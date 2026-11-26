/**
 * ASH-M03 — rate limiting must be ON by default and OFF only for the known local dev/test
 * values. Before this fix, `(process.env.NODE_ENV || '').toLowerCase() !== 'production'`
 * (public-rate-limit.ts) and a stricter, non-lowercased `process.env.NODE_ENV !== 'production'`
 * (app.ts) both meant: anything other than the exact literal "production" disabled rate
 * limiting — including an unset NODE_ENV on a forgotten deploy, a typo, different casing
 * ("Production"), or a legitimate non-dev environment like "staging".
 */
import { describe, test, expect, afterEach } from '@jest/globals';
import { isUnthrottledEnv } from '../../src/lib/rate-limit-env';

const ORIGINAL = process.env['NODE_ENV'];
afterEach(() => { process.env['NODE_ENV'] = ORIGINAL; });

describe('isUnthrottledEnv', () => {
  test.each(['development', 'test'])('NODE_ENV=%p stays unthrottled (existing dev/test behavior preserved)', (env) => {
    process.env['NODE_ENV'] = env;
    expect(isUnthrottledEnv()).toBe(true);
  });

  test('NODE_ENV unset (deleted entirely) stays unthrottled — matches a plain `npm run dev`, which never sets it', () => {
    delete process.env['NODE_ENV'];
    expect(isUnthrottledEnv()).toBe(true);
  });

  test('NODE_ENV=production is rate-limited', () => {
    process.env['NODE_ENV'] = 'production';
    expect(isUnthrottledEnv()).toBe(false);
  });

  test.each(['staging', 'preview', 'Production', 'PRODUCTION', 'prod', 'stagingg'])(
    'NODE_ENV=%p (misconfigured or non-production-but-not-dev) fails safe to rate-limited — the ASH-M03 fix',
    (env) => {
      process.env['NODE_ENV'] = env;
      expect(isUnthrottledEnv()).toBe(false);
    },
  );
});
