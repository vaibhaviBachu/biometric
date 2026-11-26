/**
 * ASH-C01 — `/share-further` must not be able to mint a working hop link for an OTP-protected
 * share without proof the caller already passed that OTP challenge. Before this fix,
 * `mintShareFurther` never checked `parent.requireOtp` at all, so anyone holding the parent
 * token — even someone who never entered its OTP code — could mint a fresh hop whose own
 * `requireOtp` was hardcoded `false`, bypassing the owner's recipient-identity check entirely.
 *
 * The fix reuses the existing signed, per-viewer OTP grant mechanism (`issueOtpGrant`/
 * `verifyOtpGrant`, already used by `getPublicInfo`/`serveSharedFile`) rather than inventing new
 * OTP semantics: minting a hop for an OTP-required parent now requires a grant that verifies
 * against that exact parent's `shareLinkId`.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

type AnyAsync = (...args: unknown[]) => Promise<unknown>;

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    shareLink: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    linkForwardEvent: { create: jest.fn() },
  },
}));

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { prisma } from '../../src/lib/prisma';
import { shareLinkService, issueOtpGrant } from '../../src/services/share/share-link.service';

const findUnique = prisma.shareLink.findUnique as unknown as jest.Mock<AnyAsync>;
const create = prisma.shareLink.create as unknown as jest.Mock<AnyAsync>;
const update = prisma.shareLink.update as unknown as jest.Mock<AnyAsync>;
const forwardEventCreate = prisma.linkForwardEvent.create as unknown as jest.Mock<AnyAsync>;

const PARENT_ID = 'parent-link-id';
const PARENT_TOKEN = 'parentTok01';
const OTHER_LINK_ID = 'some-other-link-id';

const PARENT_BASE = {
  id: PARENT_ID,
  token: PARENT_TOKEN,
  isActive: true,
  requireOtp: false,
  depth: 0,
  vaultId: 'vault-1',
  dnaRecordId: 'dna-1',
  filename: 'evidence.pdf',
  mimeType: 'application/pdf',
  assetId: null,
  expiresAt: null,
  allowDownload: true,
  allowPrint: true,
  reviewMode: false,
  allowComments: false,
  allowChangeRequest: false,
  allowApproval: false,
  reviewVersionId: null,
  shareRecipientId: null,
  requireName: false,
  note: null,
  maxDownloads: null,
  allowedCountries: null,
  allowedDeviceTypes: null,
  allowedIpPrefixes: null,
  privacyMaskingEnabled: false,
  maskEmail: false,
  maskPhone: false,
  maskAadhaar: false,
  maskPan: false,
  maskAddress: false,
  maskCustomPatterns: null,
  requestLocation: false,
  vpnBlock: false,
  torBlock: false,
  ownerUserId: 'owner-1',
  recipientLabel: null,
};

function setupMocks(parent: Record<string, unknown>) {
  findUnique.mockImplementation(async (args: unknown) => {
    const where = (args as { where: { token?: string; id?: string } }).where;
    if (where.token === parent['token']) return parent; // mintShareFurther's own lookup
    if (where.id === parent['id']) return parent; // createHopLink re-reads the parent by id
    return null; // any freshly-generated hop token: no collision
  });
  create.mockImplementation(async (args: unknown) => {
    const data = (args as { data: Record<string, unknown> }).data;
    return { id: 'hop-id', token: data['token'], requireOtp: data['requireOtp'] };
  });
  update.mockResolvedValue({});
  forwardEventCreate.mockResolvedValue({});
}

beforeEach(() => {
  findUnique.mockReset();
  create.mockReset();
  update.mockReset();
  forwardEventCreate.mockReset();
});

describe('ASH-C01 — share-further OTP gate', () => {
  test('1. no OTP grant at all, parent requires OTP → rejected, no hop minted', async () => {
    setupMocks({ ...PARENT_BASE, requireOtp: true });

    await expect(shareLinkService.mintShareFurther(PARENT_TOKEN, {})).rejects.toMatchObject({ statusCode: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  test('2. an invalid/garbage OTP grant, parent requires OTP → rejected, no hop minted', async () => {
    setupMocks({ ...PARENT_BASE, requireOtp: true });

    await expect(
      shareLinkService.mintShareFurther(PARENT_TOKEN, { otpGrant: 'not-a-real-grant' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  test('3. an expired OTP grant, parent requires OTP → rejected, no hop minted', async () => {
    setupMocks({ ...PARENT_BASE, requireOtp: true });
    const expiredGrant = issueOtpGrant(PARENT_ID, Date.now() - 25 * 60 * 60_000); // issued as if 25h ago, TTL is 24h

    await expect(
      shareLinkService.mintShareFurther(PARENT_TOKEN, { otpGrant: expiredGrant }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  test('4. a valid, current OTP grant for this exact parent → hop is minted', async () => {
    setupMocks({ ...PARENT_BASE, requireOtp: true });
    const validGrant = issueOtpGrant(PARENT_ID);

    const hop = await shareLinkService.mintShareFurther(PARENT_TOKEN, { otpGrant: validGrant });

    expect(hop.token).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('5. unauthenticated / no proof of identity at all is the same as case 1 — this is a public, tokenonly route by design', async () => {
    // There is no user-account auth on this route; "authentication" here IS the OTP grant.
    // Covered by test 1 above — repeated here for explicit traceability against the requirement.
    setupMocks({ ...PARENT_BASE, requireOtp: true });
    await expect(shareLinkService.mintShareFurther(PARENT_TOKEN, undefined)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('6 & 7. a grant minted for a DIFFERENT share link cannot be reused to mint a hop here (cross-resource access attempt)', async () => {
    setupMocks({ ...PARENT_BASE, requireOtp: true });
    const grantForSomeoneElsesLink = issueOtpGrant(OTHER_LINK_ID);

    await expect(
      shareLinkService.mintShareFurther(PARENT_TOKEN, { otpGrant: grantForSomeoneElsesLink }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  test('8. existing legitimate behavior preserved: a link that never required OTP still mints hops with no grant needed', async () => {
    setupMocks({ ...PARENT_BASE, requireOtp: false });

    const hop = await shareLinkService.mintShareFurther(PARENT_TOKEN, {});

    expect(hop.token).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('a revoked/inactive parent is still rejected before the OTP check even runs (existing behavior unchanged)', async () => {
    setupMocks({ ...PARENT_BASE, requireOtp: true, isActive: false });

    await expect(shareLinkService.mintShareFurther(PARENT_TOKEN, {})).rejects.toMatchObject({ statusCode: 404 });
  });
});
