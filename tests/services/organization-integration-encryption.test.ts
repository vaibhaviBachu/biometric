/**
 * Phase 2.2 (DB-GAP-06) — OrganizationIntegration configJson encryption.
 *
 * Mocks only the Prisma-touching data layer, auth/entitlement/audit/network
 * dependencies — never the encryption logic itself, which runs for real.
 * Covers: new rows are written with only configJsonCipher (never plaintext);
 * legacy rows (plaintext configJson, no cipher) still work via the fallback
 * path; disconnect clears both columns.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const mockUpsert = jest.fn();
const mockFindFirst = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();
const mockFindMany = jest.fn();

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    organizationIntegration: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      findMany: (...args: unknown[]) => mockFindMany(...args),
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
  safeRequest: jest.fn().mockResolvedValue({ status: 200, body: Buffer.from('{}') }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { orgIntegrationService } = require('../../src/services/organization/integration.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { encryptJsonField } = require('../../src/lib/field-encryption');

describe('orgIntegrationService — field encryption', () => {
  beforeEach(() => jest.clearAllMocks());

  test('connectIncomingWebhook() writes only configJsonCipher, never plaintext configJson', async () => {
    mockUpsert.mockResolvedValue({ id: 'int-1', provider: 'SLACK', displayName: 'Slack alerts', status: 'CONNECTED' });

    await orgIntegrationService.connectIncomingWebhook('org-1', 'user-1', 'SLACK', {
      incomingWebhookUrl: 'https://hooks.slack.com/services/x/y/z',
    });

    const args = mockUpsert.mock.calls[0][0] as { create: Record<string, unknown>; update: Record<string, unknown> };
    expect(args.create.configJson).toBeUndefined();
    expect(args.create.configJsonCipher).toBeInstanceOf(Buffer);
    expect(args.update.configJsonCipher).toBeInstanceOf(Buffer);
  });

  test('sendWebhookBridgeTest() decrypts configJsonCipher for a new-shaped row', async () => {
    const cipher = encryptJsonField('organization-integration-config', { incomingWebhookUrl: 'https://hooks.slack.com/services/new' });
    mockFindFirst.mockResolvedValue({
      id: 'int-2', organizationId: 'org-1', provider: 'SLACK', status: 'CONNECTED',
      configJson: {}, configJsonCipher: cipher,
    });
    mockUpdate.mockResolvedValue({});

    await orgIntegrationService.sendWebhookBridgeTest('org-1', 'user-1', 'SLACK');

    const { safeRequest } = require('../../src/lib/ssrf-guard');
    expect((safeRequest as jest.Mock).mock.calls[0][0]).toBe('https://hooks.slack.com/services/new');
  });

  test('sendWebhookBridgeTest() falls back to legacy plaintext configJson when configJsonCipher is null', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'int-3', organizationId: 'org-1', provider: 'SLACK', status: 'CONNECTED',
      configJson: { incomingWebhookUrl: 'https://hooks.slack.com/services/legacy' }, configJsonCipher: null,
    });
    mockUpdate.mockResolvedValue({});

    await orgIntegrationService.sendWebhookBridgeTest('org-1', 'user-1', 'SLACK');

    const { safeRequest } = require('../../src/lib/ssrf-guard');
    expect((safeRequest as jest.Mock).mock.calls[0][0]).toBe('https://hooks.slack.com/services/legacy');
  });

  test('disconnect() clears both the plaintext and encrypted config columns', async () => {
    mockFindUnique.mockResolvedValue({ id: 'int-4', provider: 'SLACK' });
    mockUpdate.mockResolvedValue({});

    await orgIntegrationService.disconnect('org-1', 'user-1', 'SLACK');

    const args = mockUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(args.data.configJson).toEqual({});
    expect(args.data.configJsonCipher).toBeNull();
    expect(args.data.configKeyVersion).toBeNull();
  });
});
