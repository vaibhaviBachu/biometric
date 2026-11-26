/**
 * ASH-C02 — POST /ai/duplicates must never return another tenant's documents.
 *
 * Before the fix: the controller filtered a field called `matches`, which the Python service
 * never sent (it returns `duplicates`/`nearMatches`); the real fields passed straight through
 * unfiltered via `...result`, and the Python `/duplicates` endpoint itself had no `allowedIds`
 * scoping at all, unlike `/search`. This mirrors tests/services/ai-search-scoping.test.ts's
 * mocking approach, one level down the stack (at `aiService`, since `detectDuplicates` goes
 * through the service wrapper rather than calling axios directly like `semanticSearch` does).
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

type AnyAsync = (...args: unknown[]) => Promise<unknown>;
const detectDuplicates = jest.fn<AnyAsync>();

jest.mock('../../src/services/ai/ai-embeddings.service', () => ({
  aiService: { detectDuplicates },
}));
jest.mock('../../src/lib/tenant-scope', () => ({
  getAuthUserId: () => 'user-a',
  ownedDnaIdSet: async () => new Set(['mine-1']),
  filterByOwnedDna: (hits: Array<{ dnaRecordId?: string }> | undefined, owned: Set<string>) =>
    (hits ?? []).filter((h) => h.dnaRecordId && owned.has(h.dnaRecordId)),
}));

import { detectDuplicates as handler } from '../../src/api/controllers/ai.controller';

const run = async (body: Record<string, unknown>) => {
  const json = jest.fn();
  const res = { status: jest.fn(() => ({ json })) } as never;
  await handler({ body } as never, res, jest.fn());
  return { status: (res as unknown as { status: jest.Mock }).status, body: json.mock.calls[0]?.[0] };
};

beforeEach(() => { detectDuplicates.mockReset(); });

describe('detectDuplicates (POST /ai/duplicates) scoping', () => {
  test('1 & 2. the caller\'s own-document ids are sent to the AI service as allowedIds (scoped inside the service, not just filtered after)', async () => {
    detectDuplicates.mockResolvedValue({
      duplicatesFound: 1, nearMatchesFound: 0,
      duplicates: [{ dnaRecordId: 'mine-1', filename: 'a.pdf', fileType: 'PDF', similarity: 0.99, classification: 'DUPLICATE' }],
      nearMatches: [],
    });
    await run({ text: 'invoice' });
    const [, , sentAllowedIds] = detectDuplicates.mock.calls[0]!;
    expect([...(sentAllowedIds as string[])]).toEqual(['mine-1']);
  });

  test('3 & 4. results containing another tenant\'s documents are stripped from BOTH duplicates and nearMatches, even though the Python layer is mocked to return them (defense-in-depth)', async () => {
    detectDuplicates.mockResolvedValue({
      duplicatesFound: 2, nearMatchesFound: 1,
      duplicates: [
        { dnaRecordId: 'mine-1', filename: 'a.pdf', fileType: 'PDF', similarity: 0.99, classification: 'DUPLICATE' },
        { dnaRecordId: 'theirs-1', filename: 'secret.pdf', fileType: 'PDF', similarity: 0.95, classification: 'DUPLICATE' },
      ],
      nearMatches: [
        { dnaRecordId: 'theirs-2', filename: 'other.pdf', fileType: 'PDF', similarity: 0.8, classification: 'NEAR_MATCH' },
      ],
    });

    const { body } = await run({ text: 'invoice' });

    expect(body.duplicates.map((d: { dnaRecordId: string }) => d.dnaRecordId)).toEqual(['mine-1']);
    expect(body.nearMatches).toEqual([]);
    expect(body.duplicatesFound).toBe(1);
    expect(body.nearMatchesFound).toBe(0);
    // The old vulnerable code produced a decoy `matches: []` while the real fields leaked through
    // `...result` unfiltered — confirm the response never contains an unfiltered foreign id anywhere.
    expect(JSON.stringify(body)).not.toContain('theirs-1');
    expect(JSON.stringify(body)).not.toContain('theirs-2');
  });

  test('5. missing/invalid ownership information (AI service offline) fails closed with 503, not a 200 with stale/foreign data', async () => {
    detectDuplicates.mockResolvedValue(null);
    const { status, body } = await run({ text: 'invoice' });
    expect(status).toHaveBeenCalledWith(503);
    expect(body.success).toBe(false);
  });

  test('6. the Python service contract: the Node client now sends allowedIds on every call, not only when owned ids happen to be non-empty', async () => {
    detectDuplicates.mockResolvedValue({ duplicatesFound: 0, nearMatchesFound: 0, duplicates: [], nearMatches: [] });
    await run({ text: 'invoice', threshold: 0.5 });
    expect(detectDuplicates).toHaveBeenCalledWith('invoice', 0.5, ['mine-1']);
  });

  test('7. existing legitimate same-tenant duplicate detection: the caller\'s own match survives filtering unchanged', async () => {
    detectDuplicates.mockResolvedValue({
      duplicatesFound: 1, nearMatchesFound: 0,
      duplicates: [{ dnaRecordId: 'mine-1', filename: 'a.pdf', fileType: 'PDF', similarity: 0.99, classification: 'DUPLICATE' }],
      nearMatches: [],
    });
    const { body } = await run({ text: 'invoice' });
    expect(body.duplicates).toEqual([
      { dnaRecordId: 'mine-1', filename: 'a.pdf', fileType: 'PDF', similarity: 0.99, classification: 'DUPLICATE' },
    ]);
  });

  test('missing text in the request body is still rejected with 400 before the service is ever called', async () => {
    const { status } = await run({});
    expect(status).toHaveBeenCalledWith(400);
    expect(detectDuplicates).not.toHaveBeenCalled();
  });
});
