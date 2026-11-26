/**
 * Share limits: the "one device" setting is enforced, the hidden auto-revoke is off unless enabled, and the view
 * limit counts viewing sessions (the session that holds a view is never locked out of its own file).
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../src/config', () => ({ config: { share: { hmacSecret: 'x'.repeat(40) } } }));
jest.mock('../../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    shareAccessLog: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    shareLink: { findUnique: jest.fn(), update: jest.fn() },
    $queryRawUnsafe: jest.fn(),
  },
}));
jest.mock('../../src/lib/tenant-scope', () => ({ assertRecordOwner: jest.fn() }));
jest.mock('../../src/api/middleware/error.middleware', () => ({ AppError: class AppError extends Error {} }));
jest.mock('../../src/services/share/risk-engine.service', () => ({ riskEngineService: {}, serializeRiskEvidence: jest.fn() }));
jest.mock('../../src/lib/geo-coords', () => ({ sanitizeCoordinatePair: jest.fn() }));
jest.mock('../../src/services/forensic/ip-intelligence.service', () => ({ getIpIntelligence: jest.fn() }));
jest.mock('../../src/services/vault/vault.service', () => ({ VaultService: class VaultService {} }));
jest.mock('../../src/lib/share-viewer-url', () => ({
  isLocalShareHost: jest.fn(), isProductionShareEnv: jest.fn(), resolveShareViewerOrigin: jest.fn(),
}));

import { prisma } from '../../src/lib/prisma';
import { ShareLinkService, shareAutoRevokeEnabled } from '../../src/services/share/share-link.service';

const logs = prisma.shareAccessLog as unknown as { findFirst: jest.Mock };
const service = new ShareLinkService();

beforeEach(() => { jest.clearAllMocks(); });

describe('"one device only"', () => {
  test('the first device is allowed (nothing recorded yet) and becomes the one', async () => {
    logs.findFirst.mockResolvedValue(null as never);
    expect((await service.checkDeviceLock('link-1', 'fp-A')).allowed).toBe(true);
  });

  test('the same device is allowed again', async () => {
    logs.findFirst.mockResolvedValue({ deviceFingerprint: 'fp-A' } as never);
    expect((await service.checkDeviceLock('link-1', 'fp-A')).allowed).toBe(true);
  });

  test('a different device is refused with a clear message', async () => {
    logs.findFirst.mockResolvedValue({ deviceFingerprint: 'fp-A' } as never);
    const out = await service.checkDeviceLock('link-1', 'fp-B');
    expect(out.allowed).toBe(false);
    expect(out.message).toMatch(/one device only/i);
  });

  test('a device that cannot be identified is refused once a device is locked in', async () => {
    logs.findFirst.mockResolvedValue({ deviceFingerprint: 'fp-A' } as never);
    expect((await service.checkDeviceLock('link-1', undefined)).allowed).toBe(false);
    expect((await service.checkDeviceLock('link-1', null)).allowed).toBe(false);
  });

  test('the earliest fingerprint on this link is the one that counts', async () => {
    logs.findFirst.mockResolvedValue({ deviceFingerprint: 'fp-A' } as never);
    await service.checkDeviceLock('link-9', 'fp-A');
    expect(logs.findFirst).toHaveBeenCalledWith({
      where: { shareLinkId: 'link-9', deviceFingerprint: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { deviceFingerprint: true },
    });
  });
});

describe('auto-revoke of a link on a high risk score', () => {
  const saved = process.env['SHARE_AUTO_REVOKE_ON_RISK'];
  afterEach(() => {
    if (saved === undefined) delete process.env['SHARE_AUTO_REVOKE_ON_RISK'];
    else process.env['SHARE_AUTO_REVOKE_ON_RISK'] = saved;
  });

  test('is off by default: a fresh link is not switched off by itself', () => {
    delete process.env['SHARE_AUTO_REVOKE_ON_RISK'];
    expect(shareAutoRevokeEnabled()).toBe(false);
    process.env['SHARE_AUTO_REVOKE_ON_RISK'] = '';
    expect(shareAutoRevokeEnabled()).toBe(false);
    process.env['SHARE_AUTO_REVOKE_ON_RISK'] = 'false';
    expect(shareAutoRevokeEnabled()).toBe(false);
  });

  test('is on only when explicitly enabled', () => {
    process.env['SHARE_AUTO_REVOKE_ON_RISK'] = 'true';
    expect(shareAutoRevokeEnabled()).toBe(true);
    process.env['SHARE_AUTO_REVOKE_ON_RISK'] = 'TRUE';
    expect(shareAutoRevokeEnabled()).toBe(true);
  });
});

describe('what the code does for the other limits (checked in the source)', () => {
  const fs = jest.requireActual('fs') as typeof import('fs');
  const path = jest.requireActual('path') as typeof import('path');
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

  test('the file route passes the viewer session so a session holding a view can reload under a view limit', () => {
    expect(read('src', 'api', 'controllers', 'share-link.controller.ts'))
      .toMatch(/getPublicInfo\(token,\s*\{\s*sessionId:\s*sessionHeader,\s*deviceFingerprint:\s*fingerprintHeader,[^}]*\}\)/);
  });

  test('only the first VIEWED of a session counts against the view limit', () => {
    const source = read('src', 'services', 'share', 'share-link.service.ts');
    expect(source).toMatch(/input\.action === 'VIEWED' && !sessionAlreadyViewed/);
    expect(source).toMatch(/isExhausted && viewer\?\.sessionId/);
  });

  test('the file route enforces "one device only" before serving', () => {
    expect(read('src', 'api', 'controllers', 'share-link.controller.ts')).toMatch(/oneDeviceOnly[\s\S]{0,200}checkDeviceLock/);
  });

  test('the viewer says which limit ended the link', () => {
    const viewer = read('client', 'src', 'pages', 'ShareViewerPage.tsx');
    for (const text of ['has expired', 'view limit', 'single-use', 'turned off by the owner']) expect(viewer).toContain(text);
  });

  test('the visible viewer watermark is switched off by a flag, with the layer still mounted', () => {
    const viewer = read('client', 'src', 'pages', 'ShareViewerPage.tsx');
    expect(viewer).toMatch(/const SHOW_VISIBLE_VIEWER_WATERMARK = false/);
    expect(viewer).toMatch(/opacity: SHOW_VISIBLE_VIEWER_WATERMARK \? 1 : 0/);
    expect(viewer).toContain('PINIT-DNA · {token}'); // the content is kept, not deleted
  });
});
