/**
 * Phase 4 — src/lib/rate-limit-store.ts — failure-policy unit tests.
 *
 * These do not require a real Redis: they exercise the explicit fail-open/
 * fail-closed policy applied when the underlying store call throws, using a
 * fake client whose `.call()` always rejects. The cross-instance sharing,
 * atomicity, and expiry properties this module is actually for need genuine
 * Redis scripting (EVAL/EVALSHA) semantics that ioredis-mock does not fully
 * implement (confirmed this phase — its `SCRIPT LOAD` support is incomplete)
 * — those are covered instead in
 * tests/integration/redis-shared-rate-limit.local-redis.test.ts against the
 * real disposable local Redis container, skipped with an honest message if
 * that container is not reachable.
 */
import { describe, test, expect, jest } from '@jest/globals';
import { SharedRedisRateLimitStore } from '../../src/lib/rate-limit-store';

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));

function brokenClient() {
  return { call: jest.fn(async () => { throw new Error('ECONNREFUSED (simulated Redis outage)'); }) };
}

describe('SharedRedisRateLimitStore — failure policy (no silent memory fallback)', () => {
  test('fail-open: a broken Redis call allows the request through (low totalHits)', async () => {
    const client = brokenClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new SharedRedisRateLimitStore({ prefix: 'rl:fo:', windowMs: 60_000, failurePolicy: 'fail-open' }, client as any);
    const result = await store.increment('ip:1.1.1.1');
    expect(result.totalHits).toBe(1);
  });

  test('fail-closed: a broken Redis call denies the request (totalHits far over any real max)', async () => {
    const client = brokenClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new SharedRedisRateLimitStore({ prefix: 'rl:fc:', windowMs: 60_000, failurePolicy: 'fail-closed' }, client as any);
    const result = await store.increment('ip:1.1.1.1');
    expect(result.totalHits).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('decrement/resetKey swallow Redis errors rather than throwing', async () => {
    const client = brokenClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new SharedRedisRateLimitStore({ prefix: 'rl:dec:', windowMs: 60_000, failurePolicy: 'fail-open' }, client as any);
    await expect(store.decrement('ip:1.1.1.1')).resolves.toBeUndefined();
    await expect(store.resetKey('ip:1.1.1.1')).resolves.toBeUndefined();
  });

  test('prefix is exposed publicly (matches express-rate-limit Store.prefix contract)', async () => {
    const client = brokenClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new SharedRedisRateLimitStore({ prefix: 'rl:named:', windowMs: 60_000, failurePolicy: 'fail-open' }, client as any);
    expect(store.prefix).toBe('rl:named:');
  });
});
