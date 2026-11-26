/**
 * Phase 5 — closes Phase 4 finding P4-12: direct concurrent-caller test for
 * the distributed cron-job lock. Previously `tryAcquireLock`/
 * `withSingleRunnerLock` were only exercised indirectly through broader
 * Redis-client/rate-limit-store test patterns — this proves the actual
 * mutual-exclusion property the scheduler relies on: two callers racing for
 * the same bucket key within the same TTL window, exactly one of them runs.
 *
 * Uses ioredis-mock (not the real disposable Redis container) because this
 * only exercises a plain `SET key val PX ttl NX`, not Lua scripting — the
 * command ioredis-mock's support was previously found incomplete for (see
 * Phase 4's rate-limit-store work). A real-Redis re-run of this same
 * property is still worth doing whenever Docker is available; this test
 * documents that it is not a substitute for that, only a faster, always-
 * available first line of defense for this specific mechanism.
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('ioredis', () => require('ioredis-mock'));
jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));
jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));
jest.mock('../../src/services/audit/audit.service', () => ({ auditService: {} }));
jest.mock('../../src/services/crawler/monitoring.service', () => ({ isMonitoringCrawlerEnabled: () => false }));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, REDIS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:6379' };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('tryAcquireLock — direct mutual-exclusion test', () => {
  test('two concurrent callers for the same key within the same TTL window: exactly one wins', async () => {
    const { tryAcquireLock } = await import('../../src/lib/distributed-lock');
    const key = `test:lock:${Date.now()}`;

    const [a, b] = await Promise.all([
      tryAcquireLock(key, 60_000),
      tryAcquireLock(key, 60_000),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one true, one false
  });

  test('a caller for a different key is unaffected by another key already being held', async () => {
    const { tryAcquireLock } = await import('../../src/lib/distributed-lock');
    const keyA = `test:lock:a:${Date.now()}`;
    const keyB = `test:lock:b:${Date.now()}`;

    expect(await tryAcquireLock(keyA, 60_000)).toBe(true);
    expect(await tryAcquireLock(keyB, 60_000)).toBe(true); // different key — not blocked by keyA's lock
  });

  test('a second attempt at the same key after the first lock is released by TTL expiry succeeds', async () => {
    const { tryAcquireLock } = await import('../../src/lib/distributed-lock');
    const key = `test:lock:ttl:${Date.now()}`;

    expect(await tryAcquireLock(key, 50)).toBe(true);
    expect(await tryAcquireLock(key, 50)).toBe(false); // still held

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await tryAcquireLock(key, 50)).toBe(true); // expired — free again
  });
});

describe('withSingleRunnerLock — direct concurrent-caller test (closes Phase 4 finding P4-12)', () => {
  test('two concurrent callers for the same bucket key invoke run() exactly once', async () => {
    const { withSingleRunnerLock } = await import('../../src/services/scheduler/vault-scheduler.service');
    const bucketKey = `job-x:${Date.now()}`;
    let runCount = 0;
    const run = async () => { runCount += 1; };

    await Promise.all([
      withSingleRunnerLock(bucketKey, 60_000, run),
      withSingleRunnerLock(bucketKey, 60_000, run),
    ]);

    expect(runCount).toBe(1);
  });

  test('two different bucket keys (e.g. two different jobs, or two different days) each invoke run() independently', async () => {
    const { withSingleRunnerLock } = await import('../../src/services/scheduler/vault-scheduler.service');
    let runCount = 0;
    const run = async () => { runCount += 1; };

    await Promise.all([
      withSingleRunnerLock(`job-a:${Date.now()}`, 60_000, run),
      withSingleRunnerLock(`job-b:${Date.now()}`, 60_000, run),
    ]);

    expect(runCount).toBe(2);
  });
});
