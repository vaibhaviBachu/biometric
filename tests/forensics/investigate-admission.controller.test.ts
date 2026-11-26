/**
 * Investigations wait in a bounded line, and a full line answers "busy, try again" instead of freezing the server.
 * Same controller as the discovery test, with the orchestrator held open by the test.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

const releases: Array<() => void> = [];
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
import { investigationGate } from '../../src/services/forensics/forensic-gates';
import { AppError } from '../../src/api/middleware/error.middleware';

function fakeRes() {
  const headers: Record<string, string> = {};
  const res: Record<string, unknown> = { statusCode: 0, body: undefined as unknown, writableEnded: false, headersSent: false, headers };
  res['status'] = (c: number) => { res['statusCode'] = c; return res; };
  res['json'] = (b: unknown) => { res['body'] = b; res['writableEnded'] = true; return res; };
  res['setHeader'] = (k: string, v: string) => { headers[k] = v; return res; };
  return res;
}
const file = { buffer: Buffer.from('jpeg-bytes'), originalname: 'copy.jpg', mimetype: 'image/jpeg', size: 10 };
const req = () => ({ file, body: {}, query: {}, headers: {} }) as never;
const settle = () => new Promise<void>((r) => setTimeout(r, 15));

beforeEach(() => {
  releases.length = 0;
  mockInvestigate.mockReset();
  mockInvestigate.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve({ investigationId: 'inv', success: true })); }));
  process.env['FORENSIC_HEAVY_SLOTS'] = '1';
  process.env['FORENSIC_HEAVY_QUEUE'] = '1';
});
afterEach(() => {
  delete process.env['FORENSIC_HEAVY_SLOTS'];
  delete process.env['FORENSIC_HEAVY_QUEUE'];
  delete process.env['FORENSIC_ADMISSION'];
});

describe('investigation admission', () => {
  test('one runs, one waits, the third is told the server is busy (503 with Retry-After)', async () => {
    const r1 = fakeRes(); const r2 = fakeRes(); const r3 = fakeRes();
    const next1 = jest.fn(); const next2 = jest.fn(); const next3 = jest.fn();
    const p1 = unifiedInvestigate(req(), r1 as never, next1);
    await settle();
    const p2 = unifiedInvestigate(req(), r2 as never, next2);
    await settle();
    expect(mockInvestigate).toHaveBeenCalledTimes(1); // the second is waiting, not running
    expect(investigationGate.stats()).toMatchObject({ running: 1, waiting: 1 });

    await unifiedInvestigate(req(), r3 as never, next3);
    const err = next3.mock.calls[0]![0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/busy.*try again/i);
    expect((r3['headers'] as Record<string, string>)['Retry-After']).toMatch(/^\d+$/);
    expect(mockInvestigate).toHaveBeenCalledTimes(1);

    releases[0]!();
    await p1;
    await settle();
    expect(mockInvestigate).toHaveBeenCalledTimes(2); // the waiting one started when the first finished
    releases[1]!();
    await p2;
    expect((r1['body'] as { success: boolean }).success).toBe(true);
    expect((r2['body'] as { success: boolean }).success).toBe(true);
    expect(next1).not.toHaveBeenCalled();
    expect(next2).not.toHaveBeenCalled();
  });

  test('with FORENSIC_ADMISSION=off all three start at once, as before', async () => {
    process.env['FORENSIC_ADMISSION'] = 'off';
    const ps = [1, 2, 3].map(() => unifiedInvestigate(req(), fakeRes() as never, jest.fn()));
    await settle();
    expect(mockInvestigate).toHaveBeenCalledTimes(3);
    releases.forEach((r) => r());
    await Promise.all(ps);
  });
});
