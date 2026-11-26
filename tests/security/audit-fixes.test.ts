/**
 * Regression tests for the four high-severity findings of the 2026-10-16 audit:
 *   H1  evidence reports must only read records the requester owns
 *   H2  the server signs report manifests only for investigations the caller ran
 *   H3  a correct one-time code unlocks the link for that viewer only (signed grant), not for everyone
 *   H4  the identity-embedded vault copy is not "tampering" and must not switch forwarded links off
 * Prisma is mocked: nothing here touches a database.
 */
import sharp from 'sharp';
import type { Request, Response } from 'express';

const db = {
  shareLink: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
  dnaRecord: { findFirst: jest.fn(), findUnique: jest.fn() },
  incident: { findUnique: jest.fn() },
  watermarkProfile: { findUnique: jest.fn() },
  investigationProbeThumbnail: { findFirst: jest.fn() },
  fileTamperEvent: { create: jest.fn() },
};

jest.mock('../../src/lib/prisma', () => ({ prisma: db }));
jest.mock('../../src/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));
jest.mock('../../src/config/dna-phase3', () => ({
  ...jest.requireActual('../../src/config/dna-phase3'),
  isPhase3SignedReportsActive: () => true,
}));
jest.mock('../../src/services/evidence/report-signing.service', () => {
  const actual = jest.requireActual('../../src/services/evidence/report-signing.service');
  return {
    ...actual,
    signReportManifest: jest.fn((m: Record<string, unknown>) => ({ ...m, signature: 'sig', publicKeyFingerprint: 'fp', verifyUrl: 'u' })),
  };
});

import { assertEvidenceReportSubjectOwner } from '../../src/lib/tenant-scope';
import { generateEvidenceReport } from '../../src/services/evidence/evidence-report.service';
import {
  issueInvestigationSigningTicket,
  verifyInvestigationSigningTicket,
} from '../../src/services/evidence/report-signing.service';
import { signReportManifestHandler } from '../../src/api/controllers/evidence-verify.controller';
import { issueOtpGrant, verifyOtpGrant, shareLinkService } from '../../src/services/share/share-link.service';
import {
  buildIntegrityManifest,
  signManifest,
  embedManifestTail,
} from '../../src/services/identity/integrity-manifest.service';
import { AppError } from '../../src/api/middleware/error.middleware';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeEach(() => {
  jest.clearAllMocks();
  for (const model of Object.values(db)) for (const fn of Object.values(model)) (fn as jest.Mock).mockResolvedValue(null);
});

// ─── H1 ──────────────────────────────────────────────────────────────────────
describe('H1 — evidence report subjects must belong to the requester', () => {
  it('refuses another user\'s share link, DNA record, incident and watermark code', async () => {
    await expect(assertEvidenceReportSubjectOwner({ shareLinkId: 'link-of-alice' }, BOB)).rejects.toThrow(AppError);
    await expect(assertEvidenceReportSubjectOwner({ dnaRecordId: 'dna-of-alice' }, BOB)).rejects.toThrow(AppError);

    db.incident.findUnique.mockResolvedValue({ dnaRecordId: 'dna-of-alice', shareLinkId: null });
    await expect(assertEvidenceReportSubjectOwner({ incidentId: 'inc-1' }, BOB)).rejects.toThrow(AppError);

    db.watermarkProfile.findUnique.mockResolvedValue({ dnaRecordId: 'dna-of-alice' });
    await expect(assertEvidenceReportSubjectOwner({ watermarkCode: 'WM-1' }, BOB)).rejects.toThrow(AppError);
  });

  it('scopes every lookup to the requester', async () => {
    db.shareLink.findFirst.mockResolvedValue({ id: 'link-1' });
    db.dnaRecord.findFirst.mockResolvedValue({ id: 'dna-1' });
    await assertEvidenceReportSubjectOwner({ shareLinkId: 'link-1', dnaRecordId: 'dna-1' }, ALICE);
    expect(db.shareLink.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'link-1', ownerUserId: ALICE },
    }));
    expect(db.dnaRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'dna-1', ownerUserId: ALICE },
    }));
  });

  it('accepts an incident through the owned share link', async () => {
    db.incident.findUnique.mockResolvedValue({ dnaRecordId: null, shareLinkId: 'link-1' });
    db.shareLink.findFirst.mockResolvedValue({ id: 'link-1' });
    await expect(assertEvidenceReportSubjectOwner({ incidentId: 'inc-1' }, ALICE)).resolves.toBeUndefined();
  });

  it('generateEvidenceReport stops before reading anything when the subject is not the caller\'s', async () => {
    await expect(generateEvidenceReport({ type: 'DNA_RECORD', dnaRecordId: 'dna-of-alice', requestedBy: BOB }))
      .rejects.toThrow(AppError);
    expect(db.dnaRecord.findUnique).not.toHaveBeenCalled();
  });
});

// ─── H2 ──────────────────────────────────────────────────────────────────────
function mockRes() {
  const res = { statusCode: 200, body: undefined as unknown, json: jest.fn() };
  res.json.mockImplementation((b: unknown) => { res.body = b; return res; });
  return res;
}

async function callSign(userId: string, body: Record<string, unknown>) {
  const res = mockRes();
  const next = jest.fn();
  await signReportManifestHandler({ user: { sub: userId }, body } as unknown as Request, res as unknown as Response, next);
  return { res, err: next.mock.calls[0]?.[0] as AppError | undefined };
}

describe('H2 — report manifests are signed only for the caller\'s own investigation', () => {
  const HASH = 'a'.repeat(64);

  it('a ticket verifies only for the user and investigation it was issued for', () => {
    const t = issueInvestigationSigningTicket('inv-1', ALICE);
    expect(verifyInvestigationSigningTicket(t, 'inv-1', ALICE)).toBe(true);
    expect(verifyInvestigationSigningTicket(t, 'inv-1', BOB)).toBe(false);
    expect(verifyInvestigationSigningTicket(t, 'inv-2', ALICE)).toBe(false);
    expect(verifyInvestigationSigningTicket(`${t}x`, 'inv-1', ALICE)).toBe(false);
    expect(verifyInvestigationSigningTicket(undefined, 'inv-1', ALICE)).toBe(false);
  });

  it('refuses to sign without a ticket or an owned investigation record', async () => {
    const { err, res } = await callSign(BOB, { investigationId: 'inv-1', reportType: 'INVESTIGATION', reportHash: HASH });
    expect(err?.statusCode).toBe(403);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('refuses another user\'s ticket', async () => {
    const aliceTicket = issueInvestigationSigningTicket('inv-1', ALICE);
    const { err } = await callSign(BOB, {
      investigationId: 'inv-1', reportType: 'INVESTIGATION', reportHash: HASH, signingTicket: aliceTicket,
    });
    expect(err?.statusCode).toBe(403);
  });

  it('signs with the caller\'s own ticket', async () => {
    const { err, res } = await callSign(ALICE, {
      investigationId: 'inv-1', reportType: 'INVESTIGATION', reportHash: HASH,
      signingTicket: issueInvestigationSigningTicket('inv-1', ALICE),
    });
    expect(err).toBeUndefined();
    expect((res.body as { success: boolean }).success).toBe(true);
  });

  it('signs a report reopened from before tickets when the stored investigation is the caller\'s', async () => {
    db.investigationProbeThumbnail.findFirst.mockResolvedValue({ id: 'thumb' });
    const { err } = await callSign(ALICE, { investigationId: 'inv-old', reportType: 'DNA', reportHash: HASH });
    expect(err).toBeUndefined();
    expect(db.investigationProbeThumbnail.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { investigationId: 'inv-old', ownerUserId: ALICE },
    }));
  });

  it('rejects malformed hashes and report types', async () => {
    const ticket = issueInvestigationSigningTicket('inv-1', ALICE);
    expect((await callSign(ALICE, { investigationId: 'inv-1', reportType: 'INVESTIGATION', reportHash: 'nope', signingTicket: ticket })).err?.statusCode).toBe(400);
    expect((await callSign(ALICE, { investigationId: 'inv-1', reportType: 'ANYTHING', reportHash: HASH, signingTicket: ticket })).err?.statusCode).toBe(400);
  });
});

// ─── H3 ──────────────────────────────────────────────────────────────────────
describe('H3 — the one-time code unlocks the link for one viewer only', () => {
  it('a grant is bound to its link and expires', () => {
    const now = Date.now();
    const grant = issueOtpGrant('link-1', now);
    expect(verifyOtpGrant(grant, 'link-1', now + 1000)).toBe(true);
    expect(verifyOtpGrant(grant, 'link-2', now + 1000)).toBe(false);
    expect(verifyOtpGrant(grant, 'link-1', now + 25 * 60 * 60_000)).toBe(false);
    expect(verifyOtpGrant(undefined, 'link-1', now)).toBe(false);
    expect(verifyOtpGrant('garbage', 'link-1', now)).toBe(false);
  });

  it('a forged grant (changed expiry) is refused', () => {
    const now = Date.now();
    const [, mac] = issueOtpGrant('link-1', now).split('.');
    const forged = `${(now + 10 * 365 * 86_400_000).toString(36)}.${mac}`;
    expect(verifyOtpGrant(forged, 'link-1', now)).toBe(false);
  });
});

// ─── H4 ──────────────────────────────────────────────────────────────────────
describe('H4 — tamper check acts only on proof of a wrong file', () => {
  const ORIGINAL_HASH = 'f'.repeat(64);

  async function embedded(dnaRecordId: string, vaultId: string): Promise<Buffer> {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#336699' } }).png().toBuffer();
    const manifest = buildIntegrityManifest({
      vaultId, dnaRecordId, ownerUserId: ALICE, certificateId: null, preEmbedSha256: ORIGINAL_HASH,
      methods: ['integrity-manifest'], identityTokenHash: '', recoveryTokenHash: '', watermarkHash: '', signatureHash: '',
    });
    return embedManifestTail(png, signManifest(manifest), { mimeType: 'image/png', fileName: 'a.png' });
  }

  beforeEach(() => {
    db.dnaRecord.findUnique.mockResolvedValue({ sha256Hash: ORIGINAL_HASH, cryptoLayer: { sha256Hash: ORIGINAL_HASH } });
    db.shareLink.updateMany.mockResolvedValue({ count: 3 });
  });

  it('the identity-embedded copy of the same record is not tampering and suspends nothing', async () => {
    const result = await shareLinkService.checkFileTamper('dna-1', 'vault-1', await embedded('dna-1', 'vault-1'));
    expect(result).toEqual({ tampered: false, reason: 'identity-embedded' });
    expect(db.shareLink.updateMany).not.toHaveBeenCalled();
    expect(db.fileTamperEvent.create).not.toHaveBeenCalled();
  });

  it('changed bytes without a signed manifest are logged, not acted on', async () => {
    const result = await shareLinkService.checkFileTamper('dna-1', 'vault-1', Buffer.from('different bytes'));
    expect(result.tampered).toBe(false);
    expect(result.reason).toBe('unverified');
    expect(db.shareLink.updateMany).not.toHaveBeenCalled();
  });

  it('a vault file carrying another record\'s manifest is tampering', async () => {
    const result = await shareLinkService.checkFileTamper('dna-1', 'vault-1', await embedded('dna-OTHER', 'vault-OTHER'));
    expect(result).toEqual({ tampered: true, reason: 'wrong-file' });
    expect(db.fileTamperEvent.create).toHaveBeenCalled();
  });
});
