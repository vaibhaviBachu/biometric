/**
 * Phase 9 — REL7-03 fix regression test. Verifies /health's storage
 * component now distinguishes "configured but unreachable" from both
 * "not configured" and genuinely "reachable" — previously it only ever
 * checked configuration, so a real outage was invisible.
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../src/lib/prisma', () => ({ prisma: { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } }));
jest.mock('../../src/lib/redis-client', () => ({ isRedisHealthy: jest.fn().mockResolvedValue({ healthy: true, message: 'ok', latencyMs: 1 }) }));
jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));

const mockIsCloudStorageConfigured = jest.fn<() => boolean>();
const mockActiveStorageBackend = jest.fn<() => 'supabase' | 's3'>(() => 'supabase');
const mockCheckStorageReachability = jest.fn<() => Promise<void>>();

jest.mock('../../src/lib/vault-storage-backend', () => ({
  isCloudStorageConfigured: () => mockIsCloudStorageConfigured(),
  activeStorageBackend: () => mockActiveStorageBackend(),
  checkStorageReachability: () => mockCheckStorageReachability(),
}));

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];

beforeEach(() => {
  jest.resetModules();
  mockIsCloudStorageConfigured.mockReset();
  mockCheckStorageReachability.mockReset();
  process.env['NODE_ENV'] = 'production';
});

afterEach(() => {
  process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
});

describe('getHealthReport — storage component live reachability (REL7-03)', () => {
  test('configured and reachable -> healthy', async () => {
    mockIsCloudStorageConfigured.mockReturnValue(true);
    mockCheckStorageReachability.mockResolvedValue(undefined);
    const { getHealthReport } = await import('../../src/lib/health');
    const report = await getHealthReport();
    expect(report.components.supabase.status).toBe('healthy');
    expect(report.components.supabase.message).toMatch(/reachable/i);
  });

  test('configured but unreachable (a real outage) -> unhealthy, distinct from "not configured"', async () => {
    mockIsCloudStorageConfigured.mockReturnValue(true);
    mockCheckStorageReachability.mockRejectedValue(new Error('simulated provider outage'));
    const { getHealthReport } = await import('../../src/lib/health');
    const report = await getHealthReport();
    expect(report.components.supabase.status).toBe('unhealthy');
    expect(report.components.supabase.message).toMatch(/configured but unreachable/i);
    expect(report.components.supabase.message).toMatch(/simulated provider outage/);
  });

  test('not configured at all -> unhealthy, and never calls the reachability probe', async () => {
    mockIsCloudStorageConfigured.mockReturnValue(false);
    const { getHealthReport } = await import('../../src/lib/health');
    const report = await getHealthReport();
    expect(report.components.supabase.status).toBe('unhealthy');
    expect(mockCheckStorageReachability).not.toHaveBeenCalled();
  });

  test('a slow/hanging reachability probe times out rather than hanging the whole report', async () => {
    mockIsCloudStorageConfigured.mockReturnValue(true);
    mockCheckStorageReachability.mockImplementation(() => new Promise(() => {})); // never resolves
    process.env['HEALTH_STORAGE_REACHABILITY_TIMEOUT_MS'] = '50';
    const { getHealthReport } = await import('../../src/lib/health');
    const report = await getHealthReport();
    expect(report.components.supabase.status).toBe('unhealthy');
    delete process.env['HEALTH_STORAGE_REACHABILITY_TIMEOUT_MS'];
  }, 10_000);
});
