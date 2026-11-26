/**
 * ASH-C02-pattern fix — POST /ai/similar must never let another tenant's documents crowd the
 * requesting tenant's own matches out of a global top-K, and must never return another
 * tenant's documents to the caller.
 *
 * Before this fix: `findSimilar` (ai.controller.ts) called `aiService.findSimilar(query, topK)`
 * with no ownership scoping at all — the Python `/similar` route reuses `semantic_search`,
 * which (like `/search` and `/duplicates` before their own fixes) treats a request with no
 * `allowedIds` as "unscoped (legacy caller)" and searches the whole shared index. A
 * Node-side filter ran afterwards, so no foreign document ever reached the HTTP response, but
 * a caller's own genuine matches could still be silently dropped if other tenants' closer
 * matches filled the fixed top-K window before the filter ever ran.
 *
 * This mirrors tests/services/ai-duplicates-scoping.test.ts's mocking approach (at `aiService`,
 * since `findSimilar` goes through the service wrapper rather than calling axios directly like
 * `semanticSearch` does).
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

type AnyAsync = (...args: unknown[]) => Promise<unknown>;
const findSimilar = jest.fn<AnyAsync>();

jest.mock('../../src/services/ai/ai-embeddings.service', () => ({
  aiService: { findSimilar },
}));

let ownedIds = new Set(['mine-1']);
jest.mock('../../src/lib/tenant-scope', () => ({
  getAuthUserId: () => 'user-a',
  ownedDnaIdSet: async () => ownedIds,
  filterByOwnedDna: (hits: Array<{ dnaRecordId?: string }> | undefined, owned: Set<string>) =>
    (hits ?? []).filter((h) => h.dnaRecordId && owned.has(h.dnaRecordId)),
}));

import { findSimilar as handler } from '../../src/api/controllers/ai.controller';

const run = async (body: Record<string, unknown>) => {
  const json = jest.fn();
  const res = { status: jest.fn(() => ({ json })) } as never;
  await handler({ body } as never, res, jest.fn());
  return { status: (res as unknown as { status: jest.Mock }).status, body: json.mock.calls[0]?.[0] };
};

beforeEach(() => {
  findSimilar.mockReset();
  ownedIds = new Set(['mine-1']);
});

describe('findSimilar (POST /ai/similar) scoping', () => {
  test('1. the caller\'s own-document ids are sent to the AI service as allowedIds (scoped inside the service, not just filtered after)', async () => {
    findSimilar.mockResolvedValue({ query: 'invoice', results: [], count: 0, totalIndexed: 0, processingMs: 1 });
    await run({ query: 'invoice', topK: 5 });
    const [, , sentAllowedIds] = findSimilar.mock.calls[0]!;
    expect(sentAllowedIds).toEqual(['mine-1']);
  });

  test('2. cross-tenant entries are stripped from the response even though the Python layer is mocked to return them (defense in depth)', async () => {
    findSimilar.mockResolvedValue({
      query: 'invoice',
      results: [
        { dnaRecordId: 'mine-1', filename: 'a.pdf', fileType: 'PDF', snippet: 'mine', similarity: 0.9, indexedAt: '' },
        { dnaRecordId: 'theirs-1', filename: 'secret.pdf', fileType: 'PDF', snippet: 'theirs', similarity: 0.95, indexedAt: '' },
      ],
      count: 2, totalIndexed: 2, processingMs: 1,
    });

    const { body } = await run({ query: 'invoice' });

    expect(body.data.results.map((r: { dnaRecordId: string }) => r.dnaRecordId)).toEqual(['mine-1']);
    expect(body.data.count).toBe(1);
    expect(JSON.stringify(body)).not.toContain('theirs-1');
    expect(JSON.stringify(body)).not.toContain('secret.pdf');
  });

  test('3. the requesting tenant\'s own match is not crowded out: it survives even when it is not the top-ranked raw hit', async () => {
    findSimilar.mockResolvedValue({
      query: 'invoice',
      // Python is expected to have already searched with allowed=['mine-1'] (scoped inside the
      // service, k widened to ntotal) — the Node layer cannot itself prove the crowd-out defense
      // ran inside FAISS, but it can prove it asked the service to do so (test 1) and that a
      // caller's own match reliably reaches the client once the service returns it.
      results: [
        { dnaRecordId: 'mine-1', filename: 'a.pdf', fileType: 'PDF', snippet: 'mine', similarity: 0.40, indexedAt: '' },
      ],
      count: 1, totalIndexed: 50, processingMs: 1,
    });

    const { body } = await run({ query: 'invoice' });
    expect(body.data.results).toHaveLength(1);
    expect(body.data.results[0].dnaRecordId).toBe('mine-1');
  });

  test('4. a caller who owns zero documents fails safe to an empty result, not an unscoped fallback', async () => {
    ownedIds = new Set();
    findSimilar.mockResolvedValue({ query: 'invoice', results: [], count: 0, totalIndexed: 10, processingMs: 1 });

    await run({ query: 'invoice' });
    const [, , sentAllowedIds] = findSimilar.mock.calls[0]!;
    // An empty array must still be SENT (scoping to "nothing"), never omitted (which would mean
    // "unscoped" to the Python side's `_allowed_set(None)` contract).
    expect(sentAllowedIds).toEqual([]);
  });

  test('5. existing legitimate same-tenant behavior: topK is still forwarded alongside allowedIds', async () => {
    findSimilar.mockResolvedValue({ query: 'invoice', results: [], count: 0, totalIndexed: 0, processingMs: 1 });
    await run({ query: 'invoice', topK: 25 });
    expect(findSimilar).toHaveBeenCalledWith('invoice', 25, ['mine-1']);
  });

  test('6. missing query is still rejected with 400 before the service is ever called', async () => {
    const { status } = await run({});
    expect(status).toHaveBeenCalledWith(400);
    expect(findSimilar).not.toHaveBeenCalled();
  });
});
