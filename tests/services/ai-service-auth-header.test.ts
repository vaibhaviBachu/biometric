/**
 * ASH-H01 — the Node side of the fix: both call paths to the Python AI service
 * (ai-embeddings.service.ts's shared `client`, and ai.controller.ts's raw-axios
 * `semanticSearch` calls) must send the shared-secret header whenever it's configured, and
 * never silently omit it in a way that would make `require_service_auth` on the Python side
 * reject every legitimate request.
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('ai-embeddings.service.ts — shared client sends the service-auth header', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  test('X-Internal-Api-Key is attached when AI_SERVICE_SHARED_SECRET is configured', async () => {
    jest.resetModules();
    process.env['AI_SERVICE_SHARED_SECRET'] = 'test-local-dummy-secret-not-real';
    const axiosCreate = jest.fn((opts: unknown) => opts);
    jest.doMock('axios', () => ({ __esModule: true, default: { create: axiosCreate, post: jest.fn() } }));

    await import('../../src/services/ai/ai-embeddings.service');

    const createOpts = axiosCreate.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(createOpts.headers['X-Internal-Api-Key']).toBe('test-local-dummy-secret-not-real');
  });

  test('no X-Internal-Api-Key header is sent when the secret is not configured (never a blank/placeholder value)', async () => {
    jest.resetModules();
    delete process.env['AI_SERVICE_SHARED_SECRET'];
    const axiosCreate = jest.fn((opts: unknown) => opts);
    jest.doMock('axios', () => ({ __esModule: true, default: { create: axiosCreate, post: jest.fn() } }));

    await import('../../src/services/ai/ai-embeddings.service');

    const createOpts = axiosCreate.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(createOpts.headers['X-Internal-Api-Key']).toBeUndefined();
  });
});

describe('ai.controller.ts — semanticSearch sends the same header on its own direct axios calls', () => {
  beforeEach(() => { jest.resetModules(); });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; jest.resetModules(); });

  test('the header is present on both /search and /search/hybrid calls when configured', async () => {
    process.env['AI_SERVICE_SHARED_SECRET'] = 'test-local-dummy-secret-not-real';
    type AnyAsync = (...args: unknown[]) => Promise<unknown>;
    const post = jest.fn<AnyAsync>().mockResolvedValue({ data: { results: [] } });
    jest.doMock('axios', () => ({
      __esModule: true,
      default: { get: jest.fn(), put: jest.fn(), post, create: jest.fn(() => ({ post, get: jest.fn() })) },
    }));
    jest.doMock('../../src/lib/prisma', () => ({ prisma: {} }));
    jest.doMock('../../src/services/audit/audit.service', () => ({ auditService: { log: jest.fn() } }));
    jest.doMock('../../src/lib/tenant-scope', () => ({
      getAuthUserId: () => 'user-a',
      ownedDnaIdSet: async () => new Set(['mine-1']),
      filterByOwnedDna: (hits: unknown[]) => hits,
    }));

    const { semanticSearch } = await import('../../src/api/controllers/ai.controller');
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) } as never;
    await semanticSearch({ body: { query: 'invoice', mode: 'semantic' } } as never, res, jest.fn());

    const [, , opts] = post.mock.calls[0]!;
    expect((opts as { headers: Record<string, string> }).headers['X-Internal-Api-Key']).toBe('test-local-dummy-secret-not-real');
  });
});
