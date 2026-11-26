/**
 * Origin rules: which sites may call the API with cookies. The attack these pin shut: a page on any
 * *.vercel.app site (anyone can publish one) calling /auth/refresh with the visitor's cookie.
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resolveCors } from '../../src/lib/allowed-origins';
import { requireTrustedOriginForCookieAuth } from '../../src/api/middleware/trusted-origin.middleware';

const KEYS = ['NODE_ENV', 'ALLOWED_ORIGIN', 'ALLOWED_ORIGINS', 'PUBLIC_APP_URL', 'EXCHANGE_APP_URL', 'ALLOWED_EXTENSION_IDS', 'ALLOW_LOCALHOST_ORIGINS'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env['NODE_ENV'] = 'production';
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const API_HOST = 'pinit-dna-uf5y.onrender.com';

describe('production', () => {
  test.each([
    'https://attacker.vercel.app',
    'https://vercel.app.attacker.com',
    'https://pinit-dna.vercel.app.evil.com',
    'https://pinit-dna-evil.vercel.app',
    'https://evilpinithub.com',
    'https://pinithub.com.evil.com',
    'http://www.pinithub.com', // plain http for our own domain is not accepted
    'https://xyz.ngrok-free.app',
    'http://localhost:3002',
    'http://127.0.0.1:5173',
    'null',
    'file://',
    'not a url',
  ])('%s is refused', (origin) => {
    expect(resolveCors(origin, API_HOST)).toEqual({ allowed: false, credentials: false });
  });

  test.each([
    'https://pinit-dna.vercel.app',
    'https://www.pinithub.com',
    'https://pinithub.com',
    'https://exchange.pinithub.com',
    'https://www.pinitexchange.com',
    'https://PINIT-DNA.vercel.app', // host names are case-insensitive
  ])('%s is allowed with cookies', (origin) => {
    expect(resolveCors(origin, API_HOST)).toEqual({ allowed: true, credentials: true });
  });

  test('the API\'s own origin is allowed (app served from the same host)', () => {
    expect(resolveCors(`https://${API_HOST}`, API_HOST)).toEqual({ allowed: true, credentials: true });
    expect(resolveCors(`https://${API_HOST}`, 'someone-else.example.com').allowed).toBe(false);
  });

  test('a preview or extra frontend works only once it is listed, as an exact origin', () => {
    expect(resolveCors('https://pinit-dna-git-ashwitha-team.vercel.app', API_HOST).allowed).toBe(false);
    process.env['ALLOWED_ORIGINS'] = 'https://pinit-dna-git-ashwitha-team.vercel.app, https://other.example.com/';
    expect(resolveCors('https://pinit-dna-git-ashwitha-team.vercel.app', API_HOST)).toEqual({ allowed: true, credentials: true });
    expect(resolveCors('https://other.example.com', API_HOST).allowed).toBe(true); // trailing slash in the setting is fine
    expect(resolveCors('https://pinit-dna-git-ashwitha-team.vercel.app.evil.com', API_HOST).allowed).toBe(false);
  });

  test('requests without an Origin header (not cross-origin browser calls) are not blocked, and get no cookie rights', () => {
    expect(resolveCors(undefined, API_HOST)).toEqual({ allowed: true, credentials: false });
  });

  test('localhost can be re-enabled on purpose', () => {
    process.env['ALLOW_LOCALHOST_ORIGINS'] = 'true';
    expect(resolveCors('http://localhost:3002', API_HOST)).toEqual({ allowed: true, credentials: true });
  });
});

describe('browser extensions', () => {
  const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

  test('are allowed but never with cookies', () => {
    expect(resolveCors(EXT, API_HOST)).toEqual({ allowed: true, credentials: false });
    expect(resolveCors('extension://abcdefghijklmnopabcdefghijklmnop', API_HOST)).toEqual({ allowed: true, credentials: false });
  });

  test('can be limited to listed extension ids', () => {
    process.env['ALLOWED_EXTENSION_IDS'] = 'abcdefghijklmnopabcdefghijklmnop';
    expect(resolveCors(EXT, API_HOST).allowed).toBe(true);
    expect(resolveCors('chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', API_HOST).allowed).toBe(false);
  });
});

describe('development', () => {
  beforeEach(() => { process.env['NODE_ENV'] = 'development'; });

  test('localhost and ngrok work, other sites still do not', () => {
    expect(resolveCors('http://localhost:3002', 'localhost:4000')).toEqual({ allowed: true, credentials: true });
    expect(resolveCors('https://abc.ngrok-free.app', 'localhost:4000').allowed).toBe(true);
    expect(resolveCors('https://attacker.vercel.app', 'localhost:4000').allowed).toBe(false);
  });
});

describe('cookie requests are refused from an untrusted page', () => {
  function run(headers: Record<string, string>, body: unknown) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = {
      body,
      path: '/refresh',
      header: (name: string) => lower[name.toLowerCase()],
      get: (name: string) => lower[name.toLowerCase()],
    } as unknown as Parameters<typeof requireTrustedOriginForCookieAuth>[0];
    const out: { status?: number; json?: unknown; nexted: boolean } = { nexted: false };
    const res = {
      status(code: number) { out.status = code; return this; },
      json(payload: unknown) { out.json = payload; return this; },
    } as unknown as Parameters<typeof requireTrustedOriginForCookieAuth>[1];
    requireTrustedOriginForCookieAuth(req, res, () => { out.nexted = true; });
    return out;
  }

  test('a page on another vercel.app site with only the cookie is refused (403)', () => {
    const out = run({ Origin: 'https://attacker.vercel.app', Host: API_HOST }, {});
    expect(out.nexted).toBe(false);
    expect(out.status).toBe(403);
  });

  test('our own frontend passes', () => {
    expect(run({ Origin: 'https://pinit-dna.vercel.app', Host: API_HOST }, {}).nexted).toBe(true);
  });

  test('no Origin header (not a cross-origin browser call) passes', () => {
    expect(run({ Host: API_HOST }, {}).nexted).toBe(true);
  });

  test('a caller that names the refresh token itself (the extension) passes from any origin', () => {
    const out = run({ Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', Host: API_HOST }, { refreshToken: 'abc' });
    expect(out.nexted).toBe(true);
  });

  test('an empty refreshToken in the body does not count as naming it', () => {
    const out = run({ Origin: 'https://attacker.vercel.app', Host: API_HOST }, { refreshToken: '  ' });
    expect(out.status).toBe(403);
  });
});
