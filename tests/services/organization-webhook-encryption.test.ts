/**
 * Phase 2.2 (DB-GAP-06) — OrganizationWebhook secret encryption.
 *
 * Mocks only the Prisma-touching data layer, auth/entitlement/audit/network
 * dependencies — never the encryption logic itself, which runs for real.
 * Covers: new rows are written with only secretCipher (never plaintext);
 * legacy rows (plaintext secret, no cipher) still work via the fallback
 * path; delivery signs with the correct secret in both cases.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const mockCreate = jest.fn();
const mockFindMany = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    organizationWebhook: {
      create: (...args: unknown[]) => mockCreate(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      findFirst: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));
jest.mock('../../src/services/organization/org-access.service', () => ({
  requireOrgRole: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/organization/audit-log.service', () => ({
  logOrgAudit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/subscription/entitlements/entitlement.service', () => ({
  entitlementService: { assertFeature: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../src/lib/ssrf-guard', () => ({
  parseSafeUrl: jest.fn((url: string) => new URL(url)),
  safeRequest: jest.fn().mockResolvedValue({ status: 200, body: Buffer.from('{}') }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { orgWebhookService } = require('../../src/services/organization/webhook.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { encryptField } = require('../../src/lib/field-encryption');

describe('orgWebhookService — field encryption', () => {
  beforeEach(() => jest.clearAllMocks());

  test('create() writes only secretCipher, never plaintext secret', async () => {
    mockCreate.mockResolvedValue({
      id: 'wh-1',
      name: 'Test',
      targetUrl: 'https://example.com/hook',
      events: ['integration.test'],
      isActive: true,
      createdAt: new Date(),
    });

    await orgWebhookService.create('org-1', 'user-1', {
      name: 'Test',
      targetUrl: 'https://example.com/hook',
    });

    const createArgs = mockCreate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.secret).toBeUndefined();
    expect(createArgs.data.secretCipher).toBeInstanceOf(Buffer);
    expect(createArgs.data.secretKeyVersion).toBe('v1');
  });

  test('list() decrypts secretCipher for the hint on a new-shaped row', async () => {
    const cipher = encryptField('organization-webhook-secret', 'whsec_realvalue123');
    mockFindMany.mockResolvedValue([
      {
        id: 'wh-1', name: 'Test', targetUrl: 'https://example.com/hook', events: [], isActive: true,
        createdAt: new Date(), lastDeliveryAt: null, lastStatusCode: null, lastError: null,
        secret: null, secretCipher: cipher,
      },
    ]);
    const rows = await orgWebhookService.list('org-1', 'user-1');
    expect(rows[0].secretHint).toBe('whsec_re…');
  });

  test('list() falls back to the legacy plaintext secret when secretCipher is null', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'wh-2', name: 'Legacy', targetUrl: 'https://example.com/hook', events: [], isActive: true,
        createdAt: new Date(), lastDeliveryAt: null, lastStatusCode: null, lastError: null,
        secret: 'whsec_legacyvalue456', secretCipher: null,
      },
    ]);
    const rows = await orgWebhookService.list('org-1', 'user-1');
    expect(rows[0].secretHint).toBe('whsec_le…');
  });

  test('deliverOne() signs with the decrypted secret for a new-shaped row', async () => {
    const crypto = require('crypto');
    const realSecret = 'whsec_newrow789';
    const cipher = encryptField('organization-webhook-secret', realSecret);
    mockFindUnique.mockResolvedValue({
      id: 'wh-3', organizationId: 'org-1', targetUrl: 'https://example.com/hook',
      events: ['integration.test'], isActive: true, secret: null, secretCipher: cipher,
    });
    mockUpdate.mockResolvedValue({});

    await orgWebhookService.deliverOne('wh-3', 'integration.test', { message: 'hi' });

    const { safeRequest } = require('../../src/lib/ssrf-guard');
    const sentHeaders = (safeRequest as jest.Mock).mock.calls[0][1].headers as Record<string, string>;
    const sentBody = (safeRequest as jest.Mock).mock.calls[0][1].body as string;
    const expectedSig = crypto.createHmac('sha256', realSecret).update(sentBody).digest('hex');
    expect(sentHeaders['X-PinIT-Signature']).toBe(`sha256=${expectedSig}`);
  });

  test('deliverOne() signs with the legacy plaintext secret for an old-shaped row', async () => {
    const crypto = require('crypto');
    const realSecret = 'whsec_legacyrow000';
    mockFindUnique.mockResolvedValue({
      id: 'wh-4', organizationId: 'org-1', targetUrl: 'https://example.com/hook',
      events: ['integration.test'], isActive: true, secret: realSecret, secretCipher: null,
    });
    mockUpdate.mockResolvedValue({});

    await orgWebhookService.deliverOne('wh-4', 'integration.test', { message: 'hi' });

    const { safeRequest } = require('../../src/lib/ssrf-guard');
    const sentHeaders = (safeRequest as jest.Mock).mock.calls[0][1].headers as Record<string, string>;
    const sentBody = (safeRequest as jest.Mock).mock.calls[0][1].body as string;
    const expectedSig = crypto.createHmac('sha256', realSecret).update(sentBody).digest('hex');
    expect(sentHeaders['X-PinIT-Signature']).toBe(`sha256=${expectedSig}`);
  });
});
