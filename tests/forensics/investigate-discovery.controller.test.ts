/**
 * The discovery details sent with an investigation reach the finished report (normal and streamed), are
 * sanitised on the way, and an investigation without them is untouched.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const mockInvestigate = jest.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>();
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/tenant-scope', () => ({ getAuthUserId: () => 'user-1' }));
jest.mock('../../src/services/forensics/unified-investigation.orchestrator', () => ({
  unifiedInvestigationOrchestrator: { investigate: (...a: unknown[]) => mockInvestigate(...a) },
}));
jest.mock('../../src/services/file-type-detector', () => ({
  FileTypeDetector: class { async detect() { return { mimeType: 'image/jpeg' }; } },
}));
jest.mock('../../src/services/forensics/investigation-probe-thumbnail.service', () => ({ getProbeThumbnail: jest.fn() }));
jest.mock('../../src/services/evidence/report-signing.service', () => ({ issueInvestigationSigningTicket: () => 'ticket' }));
jest.mock('../../src/services/evidence/investigation-evidence.service', () => ({
  recordInvestigationEvidence: jest.fn(async () => undefined),
  listSavedInvestigations: jest.fn(),
}));
jest.mock('../../src/config/large-files', () => ({ largeFileConfig: { thresholdBytes: 1e12, merkleChunkBytes: 1e9 } }));

import { unifiedInvestigate } from '../../src/api/controllers/unified-investigation.controller';

function fakeRes() {
  const res: Record<string, unknown> = { statusCode: 0, body: undefined as unknown, writableEnded: false, chunks: [] as string[] };
  res['status'] = (c: number) => { res['statusCode'] = c; return res; };
  res['json'] = (b: unknown) => { res['body'] = b; return res; };
  res['setHeader'] = () => res;
  res['flushHeaders'] = () => undefined;
  res['write'] = (c: string) => { (res['chunks'] as string[]).push(c); return true; };
  res['end'] = () => { res['writableEnded'] = true; };
  return res;
}
const file = { buffer: Buffer.from('jpeg-bytes'), originalname: 'copy.jpg', mimetype: 'image/jpeg', size: 10 };
const reqOf = (body: unknown, query: Record<string, string> = {}) =>
  ({ file, body, query, headers: {} }) as never;

beforeEach(() => {
  mockInvestigate.mockReset();
  mockInvestigate.mockResolvedValue({ investigationId: 'inv-1', success: true });
});

describe('unifiedInvestigate with discovery details', () => {
  test('attaches sanitised, user-provided details to the report', async () => {
    const res = fakeRes();
    await unifiedInvestigate(reqOf({
      discovery: JSON.stringify({ platform: 'Instagram', sourceUrl: 'javascript:alert(1)', notes: 'seen at the cafe', verified: true }),
    }), res as never, jest.fn());
    const report = (res['body'] as { report: Record<string, unknown> }).report;
    expect(report['discoveryInfo']).toMatchObject({ provenance: 'USER_PROVIDED', verified: false, platform: 'Instagram', notes: 'seen at the cafe' });
    expect((report['discoveryInfo'] as Record<string, unknown>)['sourceUrl']).toBeUndefined();
  });

  test('without details the report has no discoveryInfo and the investigation still runs', async () => {
    const res = fakeRes();
    await unifiedInvestigate(reqOf({}), res as never, jest.fn());
    const report = (res['body'] as { report: Record<string, unknown> }).report;
    expect(report['investigationId']).toBe('inv-1');
    expect('discoveryInfo' in report).toBe(false);
  });

  test('garbage in the field is ignored rather than failing the check', async () => {
    const res = fakeRes();
    await unifiedInvestigate(reqOf({ discovery: '{not json' }), res as never, jest.fn());
    expect(res['statusCode']).toBe(200);
    expect('discoveryInfo' in (res['body'] as { report: Record<string, unknown> }).report).toBe(false);
  });

  test('the streamed report carries the details too', async () => {
    const res = fakeRes();
    await unifiedInvestigate(reqOf({ discovery: JSON.stringify({ foundWhere: 'a shop window' }) }, { stream: 'true' }), res as never, jest.fn());
    const complete = (res['chunks'] as string[]).map((c) => c.replace(/^data: /, '').trim()).filter((c) => c.startsWith('{')).map((c) => JSON.parse(c)).find((e) => e.type === 'complete');
    expect(complete.report.discoveryInfo).toMatchObject({ foundWhere: 'a shop window', verified: false });
  });
});
