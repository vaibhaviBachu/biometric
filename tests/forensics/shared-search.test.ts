/** The same patch search asked twice shares one computation. */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));
jest.mock('../../src/services/ai/ai-embeddings.service', () => ({ aiService: {} }));
jest.mock('../../src/services/vault/vault.service', () => ({ VaultService: class {} }));

import { sharedSearch, clearSharedSearchCache, type LocalDnaSearchHit } from '../../src/services/forensics/vault-local-dna-search.service';
import { AbortedError, runWithSignal } from '../../src/lib/cancellation';

const hit = (): LocalDnaSearchHit => ({
  vaultId: 'v1', dnaRecordId: 'd1', ownerUserId: 'o1', patchMatchCount: 10, probePatchCount: 20, vaultPatchCount: 30,
  matchRatio: 0.5, coverageRatio: 0.3, spatialConsistency: 1, geometricScore: 1, orbRefineScore: 0, compositeScore: 70, signals: ['a'],
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => clearSharedSearchCache());

describe('sharedSearch', () => {
  test('two identical searches running together compute once', async () => {
    let runs = 0;
    const compute = async () => { runs++; await sleep(20); return { hits: [hit()], cacheable: true }; };
    const [a, b] = await Promise.all([sharedSearch('k', compute), sharedSearch('k', compute)]);
    expect(runs).toBe(1);
    expect(a).toEqual(b);
  });

  test('a later identical search is answered from memory, and each caller gets its own copy', async () => {
    let runs = 0;
    const compute = async () => { runs++; return { hits: [hit()], cacheable: true }; };
    const first = await sharedSearch('k', compute);
    first[0]!.compositeScore = 1; first[0]!.signals.push('mutated');
    const second = await sharedSearch('k', compute);
    expect(runs).toBe(1);
    expect(second[0]!.compositeScore).toBe(70);
    expect(second[0]!.signals).toEqual(['a']);
  });

  test('a different key (a different picture or different stored indexes) computes again', async () => {
    let runs = 0;
    const compute = async () => { runs++; return { hits: [hit()], cacheable: true }; };
    await sharedSearch('k1', compute);
    await sharedSearch('k2', compute);
    expect(runs).toBe(2);
  });

  test('a result that could not be fully refined (AI down) is not kept for the next caller', async () => {
    let runs = 0;
    const compute = async () => { runs++; return { hits: [hit()], cacheable: false }; };
    await sharedSearch('k', compute);
    await sharedSearch('k', compute);
    expect(runs).toBe(2);
  });

  test('a caller whose own time is not up is not cancelled by the caller it shared with', async () => {
    const firstCaller = new AbortController();
    let runs = 0;
    const compute = async () => {
      runs++;
      if (runs === 1) { await sleep(30); firstCaller.abort(new AbortedError('first caller timed out')); throw new AbortedError('first caller timed out'); }
      return { hits: [hit()], cacheable: true };
    };
    const first = runWithSignal(firstCaller.signal, () => sharedSearch('k', compute)).catch((e) => e);
    await sleep(5);
    const second = await sharedSearch('k', compute); // no signal of its own: it carries on
    expect(second).toHaveLength(1);
    expect(await first).toBeInstanceOf(AbortedError);
    expect(runs).toBe(2);
  });
});
