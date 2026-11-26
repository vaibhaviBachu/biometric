/**
 * Phase 4: public share links. Escaping of untrusted values in HTML and SVG, token and Host validation,
 * the one-time-code guessing lockout, the throttled preview log and the public rate limits.
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

import { SHARE_TOKEN_PATTERN, escapeHtml, escapeXml, safeHostOrNull } from '../../src/lib/safe-html';
import { AttemptLimiter, OncePerInterval } from '../../src/lib/attempt-limiter';
import { shareSecretLimiter, shareReadLimiter } from '../../src/api/middleware/public-rate-limit';

describe('share token and Host validation', () => {
  test.each([
    'VrTLf9QF-i', 'WKM31HE8Bn', 'a_b-c_d-e1', 'abcdef', 'x'.repeat(64),
  ])('%s is a valid token', (token) => {
    expect(SHARE_TOKEN_PATTERN.test(token)).toBe(true);
  });

  test.each([
    '', 'short', 'x'.repeat(65), '"><script>alert(1)</script>', 'abc def ghi', 'abc/def/ghi', '../../etc/passwd',
    'abc%22def%22', "abc';--def", 'abc\r\nSet-Cookie: x=1', 'abc\u0000def',
  ])('%j is refused', (token) => {
    expect(SHARE_TOKEN_PATTERN.test(token)).toBe(false);
  });

  test('a Host header is used only when it is a plain host name', () => {
    expect(safeHostOrNull('api.example.com')).toBe('api.example.com');
    expect(safeHostOrNull('localhost:4000')).toBe('localhost:4000');
    expect(safeHostOrNull('evil.com"><script>alert(1)</script>')).toBeNull();
    expect(safeHostOrNull('a b')).toBeNull();
    expect(safeHostOrNull('host/with/path')).toBeNull();
    expect(safeHostOrNull(undefined)).toBeNull();
    expect(safeHostOrNull('')).toBeNull();
  });
});

describe('escaping', () => {
  const PAYLOADS = [
    '"><script>alert(1)</script>',
    "' onmouseover='alert(1)",
    '</text><script>alert(1)</script><text>',
    '<img src=x onerror=alert(1)>',
    'a & b < c > d',
  ];

  test.each(PAYLOADS)('escapeHtml leaves no markup or quote in %j', (payload) => {
    const out = escapeHtml(payload);
    expect(out).not.toMatch(/[<>"']/);
  });

  test.each(PAYLOADS)('escapeXml leaves no markup or quote in %j', (payload) => {
    const out = escapeXml(payload);
    expect(out).not.toMatch(/[<>"']/);
  });

  test('plain text is unchanged apart from ampersands', () => {
    expect(escapeHtml('Report 2026 final')).toBe('Report 2026 final');
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  test('escapeXml drops characters XML 1.0 forbids', () => {
    expect(escapeXml('a\u0000b\u0008c\u001fd')).toBe('abcd');
    expect(escapeXml('tab\tnewline\n')).toBe('tab\tnewline\n');
  });

  test('a hostile file name in the preview SVG stays inert', () => {
    const name = escapeXml('</text><script>alert(document.cookie)</script><text>');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${name}</text></svg>`;
    expect(svg).not.toContain('<script');
    expect((svg.match(/<text>/g) ?? []).length).toBe(1);
  });
});

describe('one-time-code guessing lockout', () => {
  test('five wrong codes lock the link; the lock ends; success resets', () => {
    let now = 0;
    const limiter = new AttemptLimiter(5, 15 * 60_000, 15 * 60_000, () => now);
    for (let i = 0; i < 4; i++) limiter.recordFailure('link-1');
    expect(limiter.lockedForMs('link-1')).toBe(0);
    limiter.recordFailure('link-1');
    expect(limiter.lockedForMs('link-1')).toBeGreaterThan(0);
    expect(limiter.lockedForMs('link-2')).toBe(0); // other links are unaffected

    now += 15 * 60_000 + 1;
    expect(limiter.lockedForMs('link-1')).toBe(0);

    limiter.recordFailure('link-3');
    limiter.reset('link-3');
    for (let i = 0; i < 4; i++) limiter.recordFailure('link-3');
    expect(limiter.lockedForMs('link-3')).toBe(0);
  });

  test('failures outside the window do not add up', () => {
    let now = 0;
    const limiter = new AttemptLimiter(3, 60_000, 60_000, () => now);
    limiter.recordFailure('k'); limiter.recordFailure('k');
    now += 61_000;
    limiter.recordFailure('k'); limiter.recordFailure('k');
    expect(limiter.lockedForMs('k')).toBe(0);
  });
});

describe('preview-fetch log throttle', () => {
  test('one row per link and caller per interval', () => {
    let now = 0;
    const gate = new OncePerInterval(10 * 60_000, () => now);
    expect(gate.shouldRun('link:1.2.3.4')).toBe(true);
    for (let i = 0; i < 50; i++) expect(gate.shouldRun('link:1.2.3.4')).toBe(false);
    expect(gate.shouldRun('link:5.6.7.8')).toBe(true);
    now += 10 * 60_000;
    expect(gate.shouldRun('link:1.2.3.4')).toBe(true);
  });
});

describe('public share rate limits (production)', () => {
  const saved = process.env['NODE_ENV'];
  beforeEach(() => { process.env['NODE_ENV'] = 'production'; });
  afterEach(() => { process.env['NODE_ENV'] = saved; });

  function call(mw: (req: never, res: never, next: () => void) => unknown, ip: string, token: string) {
    const out = { passed: false, status: 0 };
    const headers: Record<string, unknown> = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(k: string, v: unknown) { headers[k] = v; return this; },
      getHeader(k: string) { return headers[k]; },
      removeHeader() { return this; },
      status(code: number) { out.status = code; this.statusCode = code; return this; },
      send() { return this; },
      json() { return this; },
      end() { return this; },
      on() { return this; },
    };
    const req = { ip, params: { token }, headers: {}, method: 'POST', app: { get: () => false }, socket: { remoteAddress: ip } };
    return Promise.resolve(mw(req as never, res as never, () => { out.passed = true; })).then(() => out);
  }

  test('code attempts: 20 per 15 minutes per caller and link, then 429; other links and callers are not affected', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 22; i++) results.push((await call(shareSecretLimiter as never, '9.9.9.9', 'tokenAAAAAA')).passed);
    expect(results.slice(0, 20).every(Boolean)).toBe(true);
    expect(results.slice(20).some(Boolean)).toBe(false);
    expect((await call(shareSecretLimiter as never, '9.9.9.9', 'tokenBBBBBB')).passed).toBe(true);
    expect((await call(shareSecretLimiter as never, '8.8.8.8', 'tokenAAAAAA')).passed).toBe(true);
  });

  test('reads are generous: a viewer page making many calls is not blocked', async () => {
    for (let i = 0; i < 100; i++) expect((await call(shareReadLimiter as never, '7.7.7.7', 'tokenCCCCCC')).passed).toBe(true);
  });

  test('outside production nothing is limited', async () => {
    process.env['NODE_ENV'] = 'development';
    for (let i = 0; i < 40; i++) expect((await call(shareSecretLimiter as never, '6.6.6.6', 'tokenDDDDDD')).passed).toBe(true);
  });
});
