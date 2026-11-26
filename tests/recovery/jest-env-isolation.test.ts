/**
 * Phase 10 — DR9-ENV-01. Positive proof (not an absence-of-counterexample
 * argument) that the test environment cannot reach production, regardless
 * of what an individual developer's real local `.env` contains.
 *
 * This test deliberately does NOT import any application module first — it
 * checks `process.env` directly, exactly as `tests/jest.env.setup.ts` left
 * it, before anything in this specific test file could have changed it.
 */
import { describe, test, expect } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyTarget } = require('../../src/lib/recovery/db-target-guard.cjs') as {
  classifyTarget: (s: string) => { classification: string; host: string };
};

describe('jest.env.setup.ts — test environment isolation (DR9-ENV-01)', () => {
  test('DATABASE_URL is the jest sentinel, not whatever the real .env contains', () => {
    expect(process.env['DATABASE_URL']).toBe('postgresql://jest-sentinel:unused@127.0.0.1:1/jest_should_never_connect');
  });

  test('DIRECT_URL matches DATABASE_URL (both sentinel)', () => {
    expect(process.env['DIRECT_URL']).toBe(process.env['DATABASE_URL']);
  });

  test('SUPABASE_URL is the jest sentinel, not the real project URL', () => {
    expect(process.env['SUPABASE_URL']).toBe('https://jest-sentinel.invalid');
  });

  test('the sentinel DATABASE_URL itself classifies as local-safe (loopback), never production-like', () => {
    // Belt-and-suspenders: even if a future edit changed the sentinel value,
    // this assertion would fail loudly rather than silently passing a
    // production-pointing sentinel.
    expect(classifyTarget(process.env['DATABASE_URL'] as string).classification).toBe('local-safe');
  });

  test('dotenv.config() (triggered by importing src/config) does not override an already-set process.env value', () => {
    // This is the actual mechanism this whole guarantee depends on. Import
    // config AFTER asserting the sentinel is in place, then assert it is
    // STILL in place after config's own `dotenv.config()` call has run.
    const before = process.env['DATABASE_URL'];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../src/config');
    expect(process.env['DATABASE_URL']).toBe(before);
  });
});
