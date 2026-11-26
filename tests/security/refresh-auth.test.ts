/**
 * Refresh-token handling: signature, expiry, algorithm, ownership, rotation and replay; what the HTTP handler
 * returns and sets; the cookie attributes the deployment relies on; the cross-site (CSRF) rules.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';

const SECRET = 'Jq7vK2mXr9LpW4tYb8NcZ3hGd6FsA1eU5oRiP0xT';

jest.mock('../../src/config/index', () => ({ config: { jwt: { secret: 'Jq7vK2mXr9LpW4tYb8NcZ3hGd6FsA1eU5oRiP0xT', accessTtl: '15m' } } }));
jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    refreshToken: { findUnique: jest.fn(), delete: jest.fn(), create: jest.fn(), deleteMany: jest.fn(), updateMany: jest.fn() },
    user: { findUnique: jest.fn() },
  },
}));

import { prisma } from '../../src/lib/prisma';
import { authService, REFRESH_ROTATION_GRACE_MS } from '../../src/services/auth/auth.service';
import { authController } from '../../src/api/controllers/auth.controller';
import { refreshCookieOptions } from '../../src/lib/auth-cookies';
import { requireTrustedOriginForCookieAuth } from '../../src/api/middleware/trusted-origin.middleware';

type Mocked = { findUnique: jest.Mock; delete: jest.Mock; create: jest.Mock; deleteMany: jest.Mock; updateMany: jest.Mock };
const tokens = prisma.refreshToken as unknown as Mocked;
const users = prisma.user as unknown as { findUnique: jest.Mock };

const FUTURE = () => new Date(Date.now() + 86_400_000);
const USER = { id: 'u1', shortId: 'PINIT-AAAAAAAA', fullName: 'Test', role: 'USER', isActive: true, lastLoginAt: null, accountType: 'INDIVIDUAL', lastActiveShell: 'PERSONAL' };

function refreshJwt(sub = 'u1', opts: jwt.SignOptions = { expiresIn: '30d' }, secret = SECRET): string {
  return jwt.sign({ sub }, secret, opts);
}

beforeEach(() => {
  jest.clearAllMocks();
  users.findUnique.mockResolvedValue(USER as never);
  tokens.delete.mockResolvedValue({} as never);
  tokens.create.mockResolvedValue({} as never);
  tokens.updateMany.mockResolvedValue({ count: 1 } as never);
  tokens.deleteMany.mockResolvedValue({ count: 0 } as never);
});

describe('authService.refresh', () => {
  test('a valid, stored token is rotated: a new one is stored and the old one is cut down to the grace window', async () => {
    const token = refreshJwt();
    tokens.findUnique.mockResolvedValue({ token, userId: 'u1', expiresAt: FUTURE() } as never);
    const before = Date.now();
    const out = await authService.refresh(token);
    expect(out.accessToken).toBeTruthy();
    expect(out.refreshToken).toBeTruthy();
    expect(out.refreshToken).not.toBe(token);
    expect(tokens.create).toHaveBeenCalledTimes(1);
    const update = tokens.updateMany.mock.calls[0]![0] as { where: { token: string; expiresAt: { gt: Date } }; data: { expiresAt: Date } };
    expect(update.where.token).toBe(token);
    // Only ever shortened: the update applies to rows that live longer than the grace window.
    expect(update.where.expiresAt.gt).toEqual(update.data.expiresAt);
    const grace = update.data.expiresAt.getTime() - before;
    expect(grace).toBeGreaterThanOrEqual(REFRESH_ROTATION_GRACE_MS - 50);
    expect(grace).toBeLessThanOrEqual(REFRESH_ROTATION_GRACE_MS + 1000);
    // This user's rows whose time is up are removed.
    expect(tokens.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', expiresAt: { lt: expect.any(Date) } } });
  });

  test('a token used again within the grace window (lost reply after a reload, a second tab) still works', async () => {
    const token = refreshJwt();
    tokens.findUnique.mockResolvedValue({ token, userId: 'u1', expiresAt: new Date(Date.now() + 30_000) } as never);
    const out = await authService.refresh(token);
    expect(out.accessToken).toBeTruthy();
    expect(out.refreshToken).not.toBe(token);
  });

  test('a token used again after the grace window is refused', async () => {
    const token = refreshJwt();
    tokens.findUnique
      .mockResolvedValueOnce({ token, userId: 'u1', expiresAt: FUTURE() } as never)
      .mockResolvedValueOnce({ token, userId: 'u1', expiresAt: new Date(Date.now() - 1) } as never);
    await authService.refresh(token);
    await expect(authService.refresh(token)).rejects.toThrow('INVALID_REFRESH');
  });

  test('logout revokes the token at once, with no grace window', async () => {
    const token = refreshJwt();
    await authService.logout(token);
    expect(tokens.deleteMany).toHaveBeenCalledWith({ where: { token } });
    expect(tokens.updateMany).not.toHaveBeenCalled();
  });

  test('a token that is not stored (never issued, already used, or revoked by logout) is refused', async () => {
    tokens.findUnique.mockResolvedValue(null as never);
    await expect(authService.refresh(refreshJwt())).rejects.toThrow('INVALID_REFRESH');
    expect(tokens.delete).not.toHaveBeenCalled();
  });

  test('a token whose own expiry has passed is refused without asking the database', async () => {
    const expired = refreshJwt('u1', { expiresIn: -10 });
    await expect(authService.refresh(expired)).rejects.toThrow('INVALID_REFRESH');
    expect(tokens.findUnique).not.toHaveBeenCalled();
  });

  test('a stored row that has expired is refused', async () => {
    const token = refreshJwt();
    tokens.findUnique.mockResolvedValue({ token, userId: 'u1', expiresAt: new Date(Date.now() - 1000) } as never);
    await expect(authService.refresh(token)).rejects.toThrow('INVALID_REFRESH');
  });

  test('a token signed with another secret is refused, even if a row for it exists', async () => {
    const forged = refreshJwt('u1', { expiresIn: '30d' }, 'some-other-secret-value-that-is-long-enough-xx');
    tokens.findUnique.mockResolvedValue({ token: forged, userId: 'u1', expiresAt: FUTURE() } as never);
    await expect(authService.refresh(forged)).rejects.toThrow('INVALID_REFRESH');
    expect(tokens.findUnique).not.toHaveBeenCalled();
  });

  test('an unsigned ("alg": "none") token is refused', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
    tokens.findUnique.mockResolvedValue({ token: unsigned, userId: 'u1', expiresAt: FUTURE() } as never);
    await expect(authService.refresh(unsigned)).rejects.toThrow('INVALID_REFRESH');
  });

  test('a token signed with another algorithm (HS512) is refused', async () => {
    const hs512 = refreshJwt('u1', { expiresIn: '30d', algorithm: 'HS512' });
    tokens.findUnique.mockResolvedValue({ token: hs512, userId: 'u1', expiresAt: FUTURE() } as never);
    await expect(authService.refresh(hs512)).rejects.toThrow('INVALID_REFRESH');
  });

  test('garbage is refused', async () => {
    await expect(authService.refresh('not-a-token')).rejects.toThrow('INVALID_REFRESH');
    await expect(authService.refresh('')).rejects.toThrow('INVALID_REFRESH');
  });

  test('a valid token stored for a different user is refused', async () => {
    const token = refreshJwt('u2');
    tokens.findUnique.mockResolvedValue({ token, userId: 'u1', expiresAt: FUTURE() } as never);
    await expect(authService.refresh(token)).rejects.toThrow('INVALID_REFRESH');
  });

  test('a deactivated user cannot refresh', async () => {
    const token = refreshJwt();
    tokens.findUnique.mockResolvedValue({ token, userId: 'u1', expiresAt: FUTURE() } as never);
    users.findUnique.mockResolvedValue({ ...USER, isActive: false } as never);
    await expect(authService.refresh(token)).rejects.toThrow('INVALID_REFRESH');
  });

  test('new refresh tokens are unique even when issued in the same second', async () => {
    tokens.findUnique.mockImplementation((async ({ where }: { where: { token: string } }) => ({ token: where.token, userId: 'u1', expiresAt: FUTURE() })) as never);
    const a = await authService.refresh(refreshJwt());
    const b = await authService.refresh(refreshJwt());
    expect(a.refreshToken).not.toBe(b.refreshToken);
  });
});

describe('authService.verifyAccess', () => {
  test('accepts an HS256 token signed with the secret and refuses other algorithms and secrets', () => {
    expect(authService.verifyAccess(jwt.sign({ sub: 'u1' }, SECRET)).sub).toBe('u1');
    expect(() => authService.verifyAccess(jwt.sign({ sub: 'u1' }, SECRET, { algorithm: 'HS512' }))).toThrow();
    expect(() => authService.verifyAccess(jwt.sign({ sub: 'u1' }, 'another-secret-another-secret-another-secret'))).toThrow();
  });
});

describe('POST /auth/refresh handler', () => {
  function call(body: unknown, cookie?: string) {
    const req = { body, headers: cookie ? { cookie } : {}, secure: true } as never;
    const out: { status?: number; json?: unknown; cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> } = { cookies: [] };
    const res = {
      status(code: number) { out.status = code; return this; },
      json(payload: unknown) { out.json = payload; return this; },
      cookie(name: string, value: string, options: Record<string, unknown>) { out.cookies.push({ name, value, options }); return this; },
    } as never;
    return authController.refresh(req, res).then(() => out);
  }

  test('success: the body carries only an access token; the new refresh token goes in an HttpOnly cookie', async () => {
    const token = refreshJwt();
    tokens.findUnique.mockResolvedValue({ token, userId: 'u1', expiresAt: FUTURE() } as never);
    const out = await call({}, `pinit_rt=${encodeURIComponent(token)}`);
    const text = JSON.stringify(out.json);
    expect(out.json).toMatchObject({ success: true, data: { accessToken: expect.any(String) } });
    expect(text).not.toContain('refreshToken');
    expect(text).not.toContain(out.cookies[0]!.value);
    expect(out.cookies).toHaveLength(1);
    expect(out.cookies[0]!.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'none' });
  });

  test('an invalid or expired refresh token gives 401 and clears the cookie', async () => {
    const out = await call({}, `pinit_rt=${encodeURIComponent(refreshJwt('u1', { expiresIn: -5 }))}`);
    expect(out.status).toBe(401);
    expect(out.cookies[0]).toMatchObject({ name: 'pinit_rt', value: '' });
    expect(out.cookies[0]!.options['maxAge']).toBe(0);
  });

  test('no token at all gives 400', async () => {
    const out = await call({});
    expect(out.status).toBe(400);
  });
});

describe('cookie attributes', () => {
  test('over https (deployed: frontend and API are different sites) the cookie is HttpOnly, Secure, SameSite=None', () => {
    const req = { secure: true, headers: {} } as never;
    expect(refreshCookieOptions(req)).toMatchObject({ httpOnly: true, secure: true, sameSite: 'none', path: '/' });
  });

  test('over plain http (local development) it is HttpOnly and SameSite=Lax', () => {
    const req = { secure: false, headers: {} } as never;
    expect(refreshCookieOptions(req)).toMatchObject({ httpOnly: true, secure: false, sameSite: 'lax' });
  });
});

describe('CSRF rules for cookie-authenticated requests', () => {
  function run(headers: Record<string, string>, body: unknown = {}) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { body, path: '/refresh', header: (n: string) => lower[n.toLowerCase()], get: (n: string) => lower[n.toLowerCase()] } as never;
    const out: { status?: number; nexted: boolean } = { nexted: false };
    const res = { status(c: number) { out.status = c; return this; }, json() { return this; } } as never;
    requireTrustedOriginForCookieAuth(req, res, () => { out.nexted = true; });
    return out;
  }

  test('credentialed cross-origin request from an untrusted site is refused', () => {
    expect(run({ Origin: 'https://attacker.vercel.app', Host: 'api.example.com', 'Sec-Fetch-Site': 'cross-site' }).status).toBe(403);
  });

  test('credentialed cross-origin request from the real frontend passes', () => {
    expect(run({ Origin: 'https://pinit-dna.vercel.app', Host: 'api.example.com', 'Sec-Fetch-Site': 'cross-site' }).nexted).toBe(true);
  });

  test('marked cross-site but with no Origin is refused', () => {
    expect(run({ 'Sec-Fetch-Site': 'cross-site', Host: 'api.example.com' }).status).toBe(403);
  });

  test('missing Origin and no cross-site marker (mobile app, script, same-site) passes', () => {
    expect(run({ Host: 'api.example.com' }).nexted).toBe(true);
    expect(run({ Host: 'api.example.com', 'Sec-Fetch-Site': 'same-origin' }).nexted).toBe(true);
    expect(run({ Host: 'api.example.com', 'Sec-Fetch-Site': 'none' }).nexted).toBe(true);
  });

  test('a caller that names the refresh token itself passes from any origin (extension flow)', () => {
    expect(run({ Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', Host: 'api.example.com' }, { refreshToken: 'x' }).nexted).toBe(true);
  });
});
