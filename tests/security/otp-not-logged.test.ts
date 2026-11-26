/**
 * ASH-L02 — the share-link OTP code must never be written to the general log stream in
 * plaintext. Before this fix, `ShareLinkService.create()` logged `{ recipientEmail, otp:
 * plainOtp }` on every OTP-gated link creation, purely as a way to demo the flow without SMTP
 * configured. That's unnecessary: `create()` already returns `devOtp: plainOtp` in its result,
 * which only the authenticated owner's own API response carries to the frontend (see
 * share-link.controller.ts's `devOtp` passthrough) — the log line was a redundant, sensitive
 * value written somewhere far more broadly visible (log aggregators, ops/support tooling).
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

type AnyAsync = (...args: unknown[]) => Promise<unknown>;

const vaultRecordFindUnique = jest.fn<AnyAsync>();
const shareLinkFindUnique = jest.fn<AnyAsync>();
const shareLinkCreate = jest.fn<AnyAsync>();
const logInfo = jest.fn();

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    vaultRecord: { findUnique: vaultRecordFindUnique },
    shareLink: { findUnique: shareLinkFindUnique, create: shareLinkCreate },
  },
}));
jest.mock('../../src/lib/logger', () => ({
  logger: { info: logInfo, warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// isProductionShareEnv=false + isLocalShareHost=true => publicViewer=false => VaultService's
// ensureCloudCopyForPublicShare is never called, so it needs no mock of its own.
jest.mock('../../src/lib/share-viewer-url', () => ({
  isProductionShareEnv: () => false,
  isLocalShareHost: () => true,
  resolveShareViewerOrigin: () => 'http://localhost:3002',
}));
jest.mock('../../src/services/platform-events/module-events', () => ({
  emitShareLinkCreated: jest.fn(),
}));

import { shareLinkService } from '../../src/services/share/share-link.service';

const OWNER = 'owner-1';

beforeEach(() => {
  vaultRecordFindUnique.mockReset();
  shareLinkFindUnique.mockReset();
  shareLinkCreate.mockReset();
  logInfo.mockReset();

  vaultRecordFindUnique.mockResolvedValue({
    id: 'vault-1',
    dnaRecordId: 'dna-1',
    originalFileName: 'contract.pdf',
    originalMimeType: 'application/pdf',
    dnaRecord: { id: 'dna-1', imageFilename: 'contract.pdf', imageMimeType: 'application/pdf', ownerUserId: OWNER },
  });
  shareLinkFindUnique.mockResolvedValue(null); // token always unique on first try
  shareLinkCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'link-1', ...data }));
});

describe('OTP-gated share-link creation never logs the plaintext code', () => {
  test('the OTP code is not present anywhere in any logger.info call', async () => {
    const result = await shareLinkService.create({
      vaultId: 'vault-1',
      ownerUserId: OWNER,
      requireOtp: true,
      recipientEmail: 'recipient@example.com',
    });

    expect(result.devOtp).toBeTruthy(); // legitimate behavior preserved: the owner still gets it
    expect(typeof result.devOtp).toBe('string');

    for (const call of logInfo.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(result.devOtp as string);
    }
  });

  test('the recipient email is still logged (only the secret value was removed)', async () => {
    await shareLinkService.create({
      vaultId: 'vault-1',
      ownerUserId: OWNER,
      requireOtp: true,
      recipientEmail: 'recipient@example.com',
    });

    const otpLog = logInfo.mock.calls.find((c) => String(c[0]).includes('OTP generated'));
    expect(otpLog).toBeDefined();
    expect(otpLog?.[1]).toMatchObject({ recipientEmail: 'recipient@example.com' });
    expect(otpLog?.[1]).not.toHaveProperty('otp');
  });

  test('a non-OTP link creation is unaffected (existing behavior preserved)', async () => {
    const result = await shareLinkService.create({ vaultId: 'vault-1', ownerUserId: OWNER });
    expect(result.devOtp).toBeNull();
  });
});
