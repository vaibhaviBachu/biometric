/**
 * Phase 4 — caching for GET /certificates/verify/:id.
 *
 * Verifies: cache miss loads from the service and populates Redis; cache hit
 * serves from Redis without calling the service again; revoke() invalidates
 * immediately rather than waiting out the TTL; and with Redis disabled
 * (REDIS_ENABLED unset, today's default everywhere) every call falls through
 * to the service directly — i.e. this change is a no-op until Redis is
 * explicitly enabled.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

jest.mock('ioredis', () => require('ioredis-mock'));
jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));

const verifyPublic = jest.fn();
const revoke = jest.fn();
jest.mock('../../src/services/certificates/certificate.service', () => ({
  certificateService: { verifyPublic: (...args: unknown[]) => verifyPublic(...args), revoke: (...args: unknown[]) => revoke(...args) },
}));
jest.mock('../../src/services/audit/audit.service', () => ({ auditService: { log: jest.fn() } }));
jest.mock('../../src/lib/tenant-scope', () => ({ getAuthUserId: jest.fn(() => 'user-1') }));

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
  } as unknown as Response;
  return { res, out };
}

const ORIGINAL_ENV = { ...process.env };

describe('certificate verify cache', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, REDIS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:6379' };
  });

  test('cache miss calls the service once and populates the cache; cache hit does not call it again', async () => {
    verifyPublic.mockResolvedValue({ valid: true, status: 'ACTIVE' });
    const { verifyCertificate } = await import('../../src/api/controllers/certificate-mgmt.controller');

    const req1 = { params: { certificateId: 'CERT-1' } } as unknown as Request;
    const { res: res1, out: out1 } = fakeRes();
    await verifyCertificate(req1, res1, (() => {}) as NextFunction);
    expect(verifyPublic).toHaveBeenCalledTimes(1);
    expect(out1.body).toEqual({ success: true, valid: true, status: 'ACTIVE' });

    const req2 = { params: { certificateId: 'CERT-1' } } as unknown as Request;
    const { res: res2, out: out2 } = fakeRes();
    await verifyCertificate(req2, res2, (() => {}) as NextFunction);
    expect(verifyPublic).toHaveBeenCalledTimes(1); // still 1 — served from cache
    expect(out2.body).toEqual(out1.body);
  });

  test('a different certificateId is a separate cache entry (no key collision)', async () => {
    verifyPublic.mockImplementation(async (id: string) => ({ valid: true, certificateId: id }));
    const { verifyCertificate } = await import('../../src/api/controllers/certificate-mgmt.controller');

    const { res: resA } = fakeRes();
    await verifyCertificate({ params: { certificateId: 'CERT-A' } } as unknown as Request, resA, (() => {}) as NextFunction);
    const { res: resB } = fakeRes();
    await verifyCertificate({ params: { certificateId: 'CERT-B' } } as unknown as Request, resB, (() => {}) as NextFunction);

    expect(verifyPublic).toHaveBeenCalledTimes(2);
    expect(verifyPublic).toHaveBeenCalledWith('CERT-A');
    expect(verifyPublic).toHaveBeenCalledWith('CERT-B');
  });

  test('revoke() invalidates the cache immediately — a subsequent verify re-queries the service', async () => {
    verifyPublic.mockResolvedValueOnce({ valid: true, status: 'ACTIVE' });
    verifyPublic.mockResolvedValueOnce({ valid: false, status: 'REVOKED' });
    revoke.mockResolvedValue({ certificateId: 'CERT-1', ownerUserId: null, dnaRecordId: 'dna-1' });

    const { verifyCertificate, revokeCertificate } = await import('../../src/api/controllers/certificate-mgmt.controller');

    const { res: res1, out: out1 } = fakeRes();
    await verifyCertificate({ params: { certificateId: 'CERT-1' } } as unknown as Request, res1, (() => {}) as NextFunction);
    expect(out1.body).toMatchObject({ valid: true });

    const { res: resRevoke } = fakeRes();
    await revokeCertificate(
      { params: { certificateId: 'CERT-1' }, body: { reason: 'compromised' } } as unknown as Request,
      resRevoke,
      (() => {}) as NextFunction,
    );

    const { res: res2, out: out2 } = fakeRes();
    await verifyCertificate({ params: { certificateId: 'CERT-1' } } as unknown as Request, res2, (() => {}) as NextFunction);
    expect(verifyPublic).toHaveBeenCalledTimes(2); // not served stale from cache
    expect(out2.body).toMatchObject({ valid: false, status: 'REVOKED' });
  });

  test('with Redis disabled, every call falls through to the service directly (no-op change)', async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env['REDIS_ENABLED'];
    verifyPublic.mockResolvedValue({ valid: true, status: 'ACTIVE' });
    const { verifyCertificate } = await import('../../src/api/controllers/certificate-mgmt.controller');

    const { res: res1 } = fakeRes();
    await verifyCertificate({ params: { certificateId: 'CERT-1' } } as unknown as Request, res1, (() => {}) as NextFunction);
    const { res: res2 } = fakeRes();
    await verifyCertificate({ params: { certificateId: 'CERT-1' } } as unknown as Request, res2, (() => {}) as NextFunction);

    expect(verifyPublic).toHaveBeenCalledTimes(2); // no caching at all when Redis is disabled
  });
});
