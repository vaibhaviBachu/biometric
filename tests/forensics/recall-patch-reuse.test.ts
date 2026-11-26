/**
 * Candidate recall reuses the Trace's own patch search instead of running the same search again.
 *
 * 2026-11-16: every slow Trace ran the patch search twice, first in `local_dna` (shortlist, 3 probes, 90 s cap) and then in
 * recall's `local_feature` provider (whole vault, 5 probes, no limit): 68–167 s locally, 347 s on production data.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { recallPatchHits, type PriorLocalDnaSearch } from '../../src/services/forensics/enterprise-candidate-retrieval.service';
import { enterpriseRetrievalEngine } from '../../src/services/forensics/enterprise-retrieval-engine.service';
import { investigationPerformanceConfig } from '../../src/config/investigation-performance';
import { AbortedError, currentSignal } from '../../src/lib/cancellation';
import type { LocalDnaSearchHit } from '../../src/services/forensics/vault-local-dna-search.service';

const hit = (vaultId: string, patchMatchCount: number, compositeScore: number): LocalDnaSearchHit => ({
  vaultId, dnaRecordId: `d-${vaultId}`, ownerUserId: 'owner', filename: `${vaultId}.jpg`, patchMatchCount, compositeScore,
  matchRatio: 0.1, spatialConsistency: 0.1, orbRefineScore: 0, coverageRatio: 0.1, geometricScore: 0, signals: [],
} as unknown as LocalDnaSearchHit);

const engineResult = (hits: LocalDnaSearchHit[]) => ({
  probes: [], localDnaHits: hits, bestProbe: { label: 'original', buffer: Buffer.alloc(0), mimeType: 'image/jpeg' },
  topVaultId: hits[0]?.vaultId ?? null, totalPatchVotes: 0, retrievalConfidence: 0,
});

const base = { buffer: Buffer.from('probe'), mimeType: 'image/jpeg', ownerUserId: 'owner' };
let retrieve: jest.SpiedFunction<typeof enterpriseRetrievalEngine.retrieve>;
const savedBudget = investigationPerformanceConfig.recallPatchSearchBudgetMs;

beforeEach(() => { retrieve = jest.spyOn(enterpriseRetrievalEngine, 'retrieve'); });
afterEach(() => { jest.restoreAllMocks(); investigationPerformanceConfig.recallPatchSearchBudgetMs = savedBudget; });

describe('recallPatchHits', () => {
  test('no earlier search (another caller): one full search, as before', async () => {
    retrieve.mockResolvedValue(engineResult([hit('a', 30, 50)]));
    const r = await recallPatchHits(base);
    expect(r.mode).toBe('full');
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0]![3]).toEqual({ investigationFast: true, skipOrbRefine: true });
  });

  test('the Trace already searched the whole vault: its hits, and no second search', async () => {
    const prior: PriorLocalDnaSearch = { status: 'complete', hits: [hit('a', 40, 30), hit('b', 10, 20)] };
    const r = await recallPatchHits({ ...base, priorLocalDna: prior });
    expect(r).toEqual({ hits: prior.hits, mode: 'reused' });
    expect(retrieve).not.toHaveBeenCalled();
  });

  test('even a high score on the shortlist does not skip the rest of the vault (a wrong picture scored 79 in local tests)', async () => {
    retrieve.mockResolvedValue(engineResult([hit('c', 120, 70)]));
    const prior: PriorLocalDnaSearch = { status: 'complete', hits: [hit('a', 90, 80)], searchedVaultIds: ['a', 'b'] };
    const r = await recallPatchHits({ ...base, priorLocalDna: prior });
    expect(r.mode).toBe('reused+rest');
    expect(retrieve.mock.calls[0]![3]!.excludeVaultIds).toEqual(['a', 'b']);
    expect(r.hits[0]!.vaultId).toBe('c');
  });

  test('a shortlist search: only the REST of the vault is searched (never the same pictures twice), and merged', async () => {
    retrieve.mockResolvedValue(engineResult([hit('c', 70, 75), hit('d', 5, 10)]));
    const prior: PriorLocalDnaSearch = { status: 'complete', hits: [hit('a', 20, 40), hit('b', 8, 30)], searchedVaultIds: ['a', 'b'] };
    const r = await recallPatchHits({ ...base, priorLocalDna: prior });
    expect(r.mode).toBe('reused+rest');
    expect(retrieve).toHaveBeenCalledTimes(1);
    const opts = retrieve.mock.calls[0]![3]!;
    expect(opts.excludeVaultIds).toEqual(['a', 'b']);
    expect(opts.maxProbes).toBe(investigationPerformanceConfig.maxInvestigationProbes);
    // the Trace search's own scales, so its probe grids come from the cache
    expect(opts.patchScales).toEqual([...investigationPerformanceConfig.investigationPatchScales]);
    expect(r.hits.map((h) => h.vaultId)).toEqual(['c', 'a', 'b', 'd']);
  });

  test.each(['timed_out', 'skipped'] as const)('the Trace search %s: one bounded search of the whole vault', async (status) => {
    retrieve.mockResolvedValue(engineResult([hit('a', 30, 50)]));
    const r = await recallPatchHits({ ...base, priorLocalDna: { status, hits: [] } });
    expect(r.mode).toBe('bounded');
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0]![3]!.excludeVaultIds).toBeUndefined();
    expect(r.hits).toHaveLength(1);
  });

  test('the bounded search is really stopped at its budget: its signal is aborted, and recall goes on with no hits', async () => {
    investigationPerformanceConfig.recallPatchSearchBudgetMs = 60;
    let sawAbort = false;
    // Like the real matcher (local-dna-match-core: "AbortedError if `signal` is aborted"): it stops and throws when aborted.
    retrieve.mockImplementation(() => new Promise((_resolve, reject) => {
      const signal = currentSignal();
      expect(signal).toBeDefined();
      signal!.addEventListener('abort', () => { sawAbort = true; reject(new AbortedError('recall patch search exceeded budget')); });
    }));
    const started = Date.now();
    const r = await recallPatchHits({ ...base, priorLocalDna: { status: 'timed_out', hits: [] } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.hits).toEqual([]);
    expect(sawAbort).toBe(true);
  });

  test('a bounded search that fails does not fail recall', async () => {
    retrieve.mockRejectedValue(new Error('index load failed'));
    const r = await recallPatchHits({ ...base, priorLocalDna: { status: 'timed_out', hits: [] } });
    expect(r).toEqual({ hits: [], mode: 'bounded' });
  });
});
