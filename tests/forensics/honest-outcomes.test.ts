/** An unfinished check is never a finding: investigation outcome, evidence saving, scan body. */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const mockFindFirst = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCreate = jest.fn<(...a: unknown[]) => Promise<{ evidenceCode: string }>>();
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/prisma', () => ({
  prisma: { evidenceRecord: { findFirst: (...a: unknown[]) => mockFindFirst(...a) }, dnaRecord: { findFirst: jest.fn(async () => null) } },
}));
jest.mock('../../src/services/watermark/watermark.service', () => ({
  createEvidenceRecord: (...a: unknown[]) => mockCreate(...a),
}));

import { classifyInvestigationOutcome } from '../../src/services/forensics/investigation-outcome';
import { recordInvestigationEvidence } from '../../src/services/evidence/investigation-evidence.service';
import { toPublicScanBody, scanMessage } from '../../src/services/scan/public-scan-decision';

const report = (summary: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ investigationId: 'inv-1', investigatedAt: new Date().toISOString(), summary, owner: {}, ...extra }) as never;

beforeEach(() => {
  mockFindFirst.mockReset().mockResolvedValue(null);
  mockCreate.mockReset().mockResolvedValue({ evidenceCode: 'EVD-0001' });
});

describe('classifyInvestigationOutcome', () => {
  test.each([
    ['VERIFIED_ORIGINAL', undefined, 'VERIFIED'],
    ['VERIFIED_DERIVATIVE', undefined, 'VERIFIED'],
    ['POSSIBLE_MATCH', undefined, 'POSSIBLE_MATCH'],
    ['NOT_PINIT', undefined, 'NOT_FOUND'],
    ['INSUFFICIENT_EVIDENCE', 'Stage timed out after 120000ms', 'INCONCLUSIVE'],
    ['INSUFFICIENT_EVIDENCE', 'Investigation could not complete analysis', 'INCONCLUSIVE'],
    ['INSUFFICIENT_EVIDENCE', 'Identity signals present but trust is insufficient', 'NOT_FOUND'],
  ])('%s with reason "%s" is %s', (acceptanceVerdict, decisionReason, kind) => {
    expect(classifyInvestigationOutcome({ summary: { acceptanceVerdict, decisionReason } } as never).kind).toBe(kind);
  });

  test('a timeout says so, with a message that is not "no match"', () => {
    const o = classifyInvestigationOutcome({ summary: { acceptanceVerdict: 'INSUFFICIENT_EVIDENCE', decisionReason: 'Stage timed out after 120000ms' } } as never);
    expect(o).toMatchObject({ kind: 'INCONCLUSIVE', reason: 'TIMEOUT' });
    expect(o.message).toMatch(/not a result either way/i);
  });
});

describe('recordInvestigationEvidence', () => {
  const finished = report({ acceptanceVerdict: 'NOT_PINIT' }, { outcome: { kind: 'NOT_FOUND' } });
  const unfinished = report(
    { acceptanceVerdict: 'INSUFFICIENT_EVIDENCE', decisionReason: 'Stage timed out after 120000ms' },
    { outcome: { kind: 'INCONCLUSIVE', reason: 'TIMEOUT' } },
  );

  test('an investigation that did not finish is not saved as Evidence', async () => {
    expect(await recordInvestigationEvidence({ report: unfinished, ownerUserId: 'u1', fileName: 'a.jpg' })).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  test('a finished one still is', async () => {
    expect(await recordInvestigationEvidence({ report: finished, ownerUserId: 'u1', fileName: 'a.jpg' })).toBe('EVD-0001');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('with INCONCLUSIVE_OUTCOMES=off the old behaviour returns (everything is saved)', async () => {
    process.env['INCONCLUSIVE_OUTCOMES'] = 'off';
    try {
      expect(await recordInvestigationEvidence({ report: unfinished, ownerUserId: 'u1', fileName: 'a.jpg' })).toBe('EVD-0001');
    } finally {
      delete process.env['INCONCLUSIVE_OUTCOMES'];
    }
  });

  test('a retry of a finished investigation does not create a second record', async () => {
    mockFindFirst.mockResolvedValue({ evidenceCode: 'EVD-0007' });
    expect(await recordInvestigationEvidence({ report: finished, ownerUserId: 'u1', fileName: 'a.jpg' })).toBe('EVD-0007');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('the public scan card for an unfinished scan', () => {
  test('is "inconclusive", carries no record, and says it is not a "not found"', () => {
    const body = toPublicScanBody({ verdict: 'inconclusive', inconclusiveReason: 'TIMEOUT', ownerPinitId: 'PINIT-X', title: 'secret', dnaRecordId: 'd' } as never);
    expect(body.verdict).toBe('inconclusive');
    expect(body.reason).toBe('TIMEOUT');
    expect(body.message).toMatch(/could not finish/i);
    expect(body.message).toMatch(/does not mean the image was not found/i);
    expect(body.ownerPinitId).toBeUndefined();
    expect(body.title).toBeUndefined();
    expect(scanMessage('not_found', false)).not.toMatch(/could not finish/i);
  });
});
