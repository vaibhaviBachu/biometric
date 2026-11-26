/**
 * Phase 4 — src/lib/redis-client.ts
 *
 * Verifies the one property every other Phase 4 Redis consumer depends on:
 * with REDIS_ENABLED unset/false (today's default everywhere), the client
 * factory returns null and never attempts a connection — so nothing changes
 * for any deployment that has not explicitly opted in.
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('ioredis', () => require('ioredis-mock'));
jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('getRedisClient', () => {
  test('returns null when REDIS_ENABLED is unset (default/backward-compatible behavior)', async () => {
    delete process.env['REDIS_ENABLED'];
    const { getRedisClient } = await import('../../src/lib/redis-client');
    expect(getRedisClient()).toBeNull();
  });

  test('returns null when REDIS_ENABLED=false explicitly', async () => {
    process.env['REDIS_ENABLED'] = 'false';
    const { getRedisClient } = await import('../../src/lib/redis-client');
    expect(getRedisClient()).toBeNull();
  });

  test('returns a client instance when REDIS_ENABLED=true', async () => {
    process.env['REDIS_ENABLED'] = 'true';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
    const { getRedisClient } = await import('../../src/lib/redis-client');
    expect(getRedisClient()).not.toBeNull();
  });

  test('isRedisHealthy reports healthy=true and does not touch Redis when disabled', async () => {
    delete process.env['REDIS_ENABLED'];
    const { isRedisHealthy } = await import('../../src/lib/redis-client');
    const result = await isRedisHealthy();
    expect(result.healthy).toBe(true);
    expect(result.message).toMatch(/disabled/i);
  });

  test('isRedisHealthy pings the real (mocked) client and reports latency when enabled', async () => {
    process.env['REDIS_ENABLED'] = 'true';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
    const { isRedisHealthy } = await import('../../src/lib/redis-client');
    const result = await isRedisHealthy();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
  });
});
