/**
 * Phase 3: credentials in URLs and logs. Ordinary routes no longer accept ?token=; only the live-stream routes do.
 * Tokens, cookies, Authorization values, share tokens and secret-named fields never reach a log entry.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';

jest.mock('../../src/config', () => ({ config: { log: { level: 'info' }, env: 'test', jwt: { secret: 'x'.repeat(40) } } }));
jest.mock('../../src/services/auth/auth.service', () => ({
  authService: { verifyAccess: jest.fn() },
}));
jest.mock('../../src/lib/tenant-scope', () => ({ stripClientOwnerIdentity: jest.fn() }));

import { authService } from '../../src/services/auth/auth.service';
import { requireAuth, requireAuthSse } from '../../src/api/middleware/auth.middleware';
import { redactString, redactUrl, redactValue, isSensitiveKey } from '../../src/lib/log-redaction';
import { redactSecrets } from '../../src/lib/logger';

const verify = authService.verifyAccess as unknown as jest.Mock;
const JWT_VALUE = jwt.sign({ sub: 'user-1', role: 'USER' }, 'k'.repeat(40));

beforeEach(() => { jest.clearAllMocks(); verify.mockReturnValue({ sub: 'user-1' } as never); });

function run(mw: (req: never, res: never, next: () => void) => void, req: { headers?: Record<string, string>; query?: Record<string, unknown> }) {
  const out: { status?: number; nexted: boolean } = { nexted: false };
  const res = { status(c: number) { out.status = c; return this; }, json() { return this; } } as never;
  mw({ headers: {}, query: {}, ...req } as never, res, () => { out.nexted = true; });
  return out;
}

describe('where an access token may come from', () => {
  test('an ordinary route accepts the Authorization header', () => {
    expect(run(requireAuth as never, { headers: { authorization: `Bearer ${JWT_VALUE}` } }).nexted).toBe(true);
  });

  test('an ordinary route refuses ?token= even with a valid token', () => {
    const out = run(requireAuth as never, { query: { token: JWT_VALUE } });
    expect(out.status).toBe(401);
    expect(out.nexted).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  test('a live-stream route accepts ?token= (EventSource cannot send headers)', () => {
    expect(run(requireAuthSse as never, { query: { token: JWT_VALUE } }).nexted).toBe(true);
  });

  test('a live-stream route still accepts the header, and refuses a request with neither', () => {
    expect(run(requireAuthSse as never, { headers: { authorization: `Bearer ${JWT_VALUE}` } }).nexted).toBe(true);
    expect(run(requireAuthSse as never, {}).status).toBe(401);
  });

  test('an invalid token is refused with 401', () => {
    verify.mockImplementation(() => { throw new Error('bad'); });
    expect(run(requireAuth as never, { headers: { authorization: 'Bearer nope' } }).status).toBe(401);
  });
});

describe('redactString / redactUrl', () => {
  test('a JWT anywhere in text', () => {
    expect(redactString(`GET /api/v1/notifications/stream?token=${JWT_VALUE} 200`)).not.toContain(JWT_VALUE);
    expect(redactString(`failed for ${JWT_VALUE} at x`)).toBe('failed for [REDACTED_JWT] at x');
  });

  test('Bearer values, query secrets and the refresh cookie', () => {
    expect(redactString('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactString('/x?a=1&access_token=SECRETVALUE&b=2')).toBe('/x?a=1&access_token=[REDACTED]&b=2');
    expect(redactString('/x?signature=abcdef123456&otp=123456')).toBe('/x?signature=[REDACTED]&otp=[REDACTED]');
    expect(redactString('cookie: pinit_rt=REFRESHVALUE; other=1')).toBe('cookie: pinit_rt=[REDACTED]; other=1');
  });

  test('share-link tokens in paths are redacted, vault ids and fixed words are kept', () => {
    expect(redactUrl('/api/v1/share/VrTLf9QF-i/file')).toBe('/api/v1/share/[REDACTED]/file');
    expect(redactUrl('/api/v1/share/VrTLf9QF-i')).toBe('/api/v1/share/[REDACTED]');
    expect(redactUrl('/s/WKM31HE8Bn')).toBe('/s/[REDACTED]');
    expect(redactUrl('/api/v1/share/handover/abcDEF123456')).toBe('/api/v1/share/handover/[REDACTED]');
    expect(redactUrl('/api/v1/share/client-report/abcDEF123456/pdf')).toBe('/api/v1/share/client-report/[REDACTED]/pdf');
    expect(redactUrl('/api/v1/share/vault/b329206e-03f3-4f00-b622-a1a1222e0c76')).toBe('/api/v1/share/vault/b329206e-03f3-4f00-b622-a1a1222e0c76');
    expect(redactUrl('/api/v1/share/analytics/geo')).toBe('/api/v1/share/analytics/geo');
  });

  test('ordinary text and ids are left alone', () => {
    const text = 'Vault — retrieving encrypted image {"vaultId":"b329206e-03f3-4f00-b622-a1a1222e0c76"}';
    expect(redactString(text)).toBe(text);
  });
});

describe('redactValue (log metadata)', () => {
  test('fields named like secrets are redacted, case-insensitively and nested', () => {
    const out = redactValue({
      token: 'VrTLf9QF-i', accessToken: 'a', refreshToken: 'b', Authorization: 'Bearer c', cookie: 'pinit_rt=d',
      password: 'p', clientSecret: 's', apiKey: 'k', otp: '123456', signature: 'sig',
      nested: { shareToken: 't', inner: [{ 'set-cookie': 'x' }] },
      vaultId: 'b329206e-03f3-4f00-b622-a1a1222e0c76', action: 'VIEWED',
    }) as Record<string, unknown>;
    const text = JSON.stringify(out);
    for (const secret of ['VrTLf9QF-i', 'pinit_rt=d', '123456', 'sig"', '"p"', '"s"', '"k"']) expect(text).not.toContain(secret);
    expect(out['vaultId']).toBe('b329206e-03f3-4f00-b622-a1a1222e0c76');
    expect(out['action']).toBe('VIEWED');
    expect(out['token']).toBe('[REDACTED]');
  });

  test('counts and flags that only contain the word "token" are kept', () => {
    expect(isSensitiveKey('tokens')).toBe(false);
    expect(isSensitiveKey('tokenCount')).toBe(false);
    expect(isSensitiveKey('token')).toBe(true);
    expect(redactValue({ tokens: 3 })).toEqual({ tokens: 3 });
  });

  test('empty or missing secret fields stay empty (nothing to hide)', () => {
    expect(redactValue({ token: '', refreshToken: null })).toEqual({ token: '', refreshToken: null });
  });

  test('errors keep their shape with secrets removed from message and stack', () => {
    const err = new Error(`bad token ${JWT_VALUE}`);
    const out = redactValue({ error: err }) as { error: { message: string; stack?: string } };
    expect(out.error.message).not.toContain(JWT_VALUE);
    expect(out.error.stack ?? '').not.toContain(JWT_VALUE);
  });

  test('deeply nested data does not recurse forever', () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 30; i++) { const next: Record<string, unknown> = {}; cur['n'] = next; cur = next; }
    expect(() => redactValue(deep)).not.toThrow();
  });
});

describe('the logger format', () => {
  const MESSAGE = Symbol.for('message');

  test('every log entry is scrubbed: message and metadata', () => {
    const info = redactSecrets().transform({
      level: 'info',
      message: `GET /api/v1/notifications/stream?token=${JWT_VALUE} 200`,
      token: 'VrTLf9QF-i',
      headers: { authorization: `Bearer ${JWT_VALUE}`, cookie: 'pinit_rt=REFRESHVALUE' },
      body: { password: 'hunter2', note: 'ok' },
      [MESSAGE]: 'kept',
    } as never) as unknown as Record<string | symbol, unknown>;
    const text = JSON.stringify(info);
    for (const secret of [JWT_VALUE, 'VrTLf9QF-i', 'REFRESHVALUE', 'hunter2']) expect(text).not.toContain(secret);
    expect((info['body'] as { note: string }).note).toBe('ok');
    expect(info[MESSAGE]).toBe('kept'); // winston's own symbol fields are carried over
  });

  test('a share-token log line from the access flow is scrubbed', () => {
    const info = redactSecrets().transform({ level: 'info', message: '[SmartLink] Access recorded', token: 'VrTLf9QF-i', action: 'VIEWED' } as never) as unknown as Record<string, unknown>;
    expect(JSON.stringify(info)).not.toContain('VrTLf9QF-i');
    expect(info['action']).toBe('VIEWED');
  });
});
