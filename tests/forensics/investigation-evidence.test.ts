/**
 * A finished investigation is saved to the Evidence list: once per investigation, owned by the investigator,
 * linked to a matched asset only when that asset is theirs, and without ever failing the investigation.
 */
const mockFindFirstEvidence = jest.fn();
const mockFindFirstDna = jest.fn();
const mockCreateEvidenceRecord = jest.fn();
const mockFindManyEvidence = jest.fn();

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    evidenceRecord: {
      findFirst: (...a: unknown[]) => mockFindFirstEvidence(...a),
      findMany: (...a: unknown[]) => mockFindManyEvidence(...a),
    },
    dnaRecord: { findFirst: (...a: unknown[]) => mockFindFirstDna(...a) },
  },
}));
jest.mock('../../src/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/services/watermark/watermark.service', () => ({
  createEvidenceRecord: (...a: unknown[]) => mockCreateEvidenceRecord(...a),
}));

import {
  recordInvestigationEvidence,
  listSavedInvestigations,
  buildReportSnapshot,
  withoutSnapshot,
  INVESTIGATION_EVIDENCE_TYPE,
} from '../../src/services/evidence/investigation-evidence.service';

function report(over: Record<string, unknown> = {}): any {
  return {
    success: true,
    investigationId: 'inv-1',
    investigatedAt: '2026-10-19T10:00:00.000Z',
    currentFileHash: 'abc123',
    owner: { dnaRecordId: 'dna-1', certificateId: 'cert-1', originalFilename: 'original.png' },
    summary: {
      ownershipConfidence: 91,
      dnaMatchPercent: 88,
      certificateStatus: 'VALID',
      identityStatus: 'CONFIRMED',
      tamperSeverity: 'NONE',
      riskLevel: 'LOW',
      reportState: 'VERIFIED',
      acceptanceVerdict: 'VERIFIED_ORIGINAL',
    },
    ...over,
  };
}

const input = (r = report()) => ({ report: r, ownerUserId: 'user-1', fileName: 'probe.png', mimeType: 'image/png', sizeBytes: 1000 });

beforeEach(() => {
  jest.clearAllMocks();
  mockFindFirstEvidence.mockResolvedValue(null);
  mockFindFirstDna.mockResolvedValue({ id: 'dna-1' });
  mockCreateEvidenceRecord.mockResolvedValue({ id: 'e1', evidenceCode: 'EVD-0001' });
});

describe('recordInvestigationEvidence', () => {
  it('saves one INVESTIGATION_REPORT record owned by the investigator', async () => {
    const code = await recordInvestigationEvidence(input());
    expect(code).toBe('EVD-0001');
    expect(mockCreateEvidenceRecord).toHaveBeenCalledTimes(1);
    const arg = mockCreateEvidenceRecord.mock.calls[0][0];
    expect(arg.evidenceType).toBe(INVESTIGATION_EVIDENCE_TYPE);
    expect(arg.ownerUserId).toBe('user-1');
    expect(arg.dnaRecordId).toBe('dna-1');
    expect(arg.description).toContain('Match confirmed');
    expect(arg.metadata.investigationId).toBe('inv-1');
    expect(arg.metadata.probe.sha256).toBe('abc123');
  });

  it('is recorded once per investigation', async () => {
    mockFindFirstEvidence.mockResolvedValue({ evidenceCode: 'EVD-0007' });
    expect(await recordInvestigationEvidence(input())).toBe('EVD-0007');
    expect(mockCreateEvidenceRecord).not.toHaveBeenCalled();
  });

  it('records an investigation that found nothing', async () => {
    const r = report({ owner: {}, success: false, summary: { ...report().summary, reportState: 'NO_SIGNATURE' } });
    await recordInvestigationEvidence(input(r));
    const arg = mockCreateEvidenceRecord.mock.calls[0][0];
    expect(arg.description).toContain('No PINIT signature found');
    expect(arg.dnaRecordId).toBeUndefined();
    expect(arg.ownerUserId).toBe('user-1');
  });

  it("does not link the record to an asset that is not the investigator's", async () => {
    mockFindFirstDna.mockResolvedValue(null);
    await recordInvestigationEvidence(input());
    const arg = mockCreateEvidenceRecord.mock.calls[0][0];
    expect(arg.dnaRecordId).toBeUndefined();
    expect(arg.metadata.matched.ownedByInvestigator).toBe(false);
    expect(arg.metadata.matched.originalFilename).toBeNull();
    expect(arg.metadata.matched.certificateId).toBeNull();
  });

  it('keeps the stored copy bounded: oversized parts (heatmaps, audit traces) are left out', async () => {
    const big = report({ layerAnalysis: new Array(5000).fill({ explanation: 'x'.repeat(200) }), forensicEvidence: { heat: 'y'.repeat(1_000_000) } });
    await recordInvestigationEvidence(input(big));
    const arg = mockCreateEvidenceRecord.mock.calls[0][0];
    expect(arg.metadata.snapshot.forensicEvidence).toBeUndefined();
    expect(arg.metadata.snapshot.layerAnalysis).toBeUndefined();
    expect(arg.metadata.snapshot.summary.reportState).toBe('VERIFIED');
    expect(JSON.stringify(arg.metadata).length).toBeLessThan(20_000);
  });

  it('stores a copy the Evidence page can open, without the signing ticket', () => {
    const snap = buildReportSnapshot(report({ signingTicket: 'secret-ticket' }));
    expect(snap?.investigationId).toBe('inv-1');
    expect(snap).not.toHaveProperty('signingTicket');
  });

  it('keeps no copy at all when the whole report is too large', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 20; i++) many[`part${i}`] = 'z'.repeat(50_000);
    expect(buildReportSnapshot(report(many))).toBeNull();
  });

  it('retries once when two investigations pick the same evidence code', async () => {
    mockCreateEvidenceRecord
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce({ id: 'e2', evidenceCode: 'EVD-0002' });
    expect(await recordInvestigationEvidence(input())).toBe('EVD-0002');
    expect(mockCreateEvidenceRecord).toHaveBeenCalledTimes(2);
  });

  it('never throws when the database fails', async () => {
    mockCreateEvidenceRecord.mockRejectedValue(new Error('db down'));
    await expect(recordInvestigationEvidence(input())).resolves.toBeNull();
    mockFindFirstEvidence.mockRejectedValue(new Error('db down'));
    await expect(recordInvestigationEvidence(input())).resolves.toBeNull();
  });

  it("lists only the owner's saved investigations, newest first, in the Evidence page's shape", async () => {
    const meta = (id: string, withSnap = true) => JSON.stringify({
      investigationId: id,
      investigatedAt: '2026-10-19T10:00:00.000Z',
      probe: { fileName: `${id}.png` },
      snapshot: withSnap ? { investigationId: id, summary: { reportState: 'VERIFIED' } } : null,
    });
    mockFindManyEvidence.mockResolvedValue([
      { evidenceCode: 'EVD-0002', createdAt: new Date('2026-10-19T10:00:00Z'), metadata: meta('inv-2') },
      { evidenceCode: 'EVD-0003', createdAt: new Date('2026-10-18T10:00:00Z'), metadata: meta('inv-3', false) },
      { evidenceCode: 'EVD-0001', createdAt: new Date('2026-10-17T10:00:00Z'), metadata: 'not json' },
    ]);
    const list = await listSavedInvestigations('user-1');
    expect(mockFindManyEvidence.mock.calls[0][0].where).toEqual({ ownerUserId: 'user-1', evidenceType: INVESTIGATION_EVIDENCE_TYPE });
    expect(mockFindManyEvidence.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
    expect(list).toHaveLength(1); // no copy and unreadable rows are skipped
    expect(list[0]).toMatchObject({ kind: 'investigation', id: 'inv-2', filename: 'inv-2.png', evidenceCode: 'EVD-0002' });
  });

  it('leaves the report copy out of rows shown in a list', () => {
    const row = { evidenceType: INVESTIGATION_EVIDENCE_TYPE, metadata: JSON.stringify({ investigationId: 'i', snapshot: { big: 1 } }) };
    expect(JSON.parse(withoutSnapshot(row).metadata as string)).toEqual({ investigationId: 'i' });
    const other = { evidenceType: 'EVIDENCE_REPORT', metadata: '{"snapshot":1}' };
    expect(withoutSnapshot(other)).toBe(other);
  });

  it('ignores a report without an id or an owner', async () => {
    expect(await recordInvestigationEvidence({ ...input(), ownerUserId: '' })).toBeNull();
    expect(await recordInvestigationEvidence(input(report({ investigationId: '' })))).toBeNull();
    expect(mockCreateEvidenceRecord).not.toHaveBeenCalled();
  });
});
