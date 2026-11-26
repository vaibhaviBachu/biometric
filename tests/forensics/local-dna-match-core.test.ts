/**
 * The local DNA patch search after the performance work must give exactly the answers it gave before.
 * The reference is a copy of the original code (fixtures/legacy-local-dna-match.ts).
 */
import { describe, test, expect } from '@jest/globals';
import { performance } from 'perf_hooks';
import {
  matchAllIndexesSync,
  matchAllIndexesYielding,
  patchesMatch,
  type MatchIndex,
} from '../../src/services/forensics/local-dna-match-core';
import { hammingBits, type PatchFingerprint } from '../../src/services/forensics/local-dna-patch-generator.service';
import { AbortedError, runWithSignal } from '../../src/lib/cancellation';
import { legacyHammingBits, legacyMatchAllIndexes, legacyPatchesMatch } from './fixtures/legacy-local-dna-match';
import { buildSyntheticVault, flipBits, randomHex, rng } from './fixtures/synthetic-vault';

describe('hammingBits', () => {
  test('gives the same number as the parseInt version for every kind of input', () => {
    const rand = rng(7);
    const alphabet = '0123456789abcdefABCDEFxyz -_é';
    const cases: Array<[string, string]> = [['', ''], ['abcd', ''], ['', 'abcd'], ['abcd', 'abc'], ['zzzz', '0000'], ['ABCD', 'abcd'], ['0000000000000000', 'ffffffffffffffff']];
    for (let i = 0; i < 4000; i++) {
      const len = 1 + Math.floor(rand() * 20);
      const make = () => Array.from({ length: len }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      cases.push([make(), rand() < 0.9 ? make() : make() + 'a']);
    }
    for (let i = 0; i < 4000; i++) cases.push([randomHex(rand, 16), randomHex(rand, 16)]);
    for (const [a, b] of cases) expect(hammingBits(a, b)).toBe(legacyHammingBits(a, b));
  });
});

describe('patchesMatch', () => {
  test('agrees with the original three-step check, including the band where the dense vote decides', () => {
    const rand = rng(11);
    let band = 0;
    for (let i = 0; i < 6000; i++) {
      const base = randomHex(rand, 16);
      const flips = Math.floor(rand() * 24);
      const dense = {
        dHash8: randomHex(rand, 8), aHash8: randomHex(rand, 8), edgeSignature: 'ab12', frequencySig: 'cd34', textureSig: 'ef56',
        colorVector: [10, 20, 30] as [number, number, number],
      };
      const probe: PatchFingerprint = {
        patchIndex: 0, gridX: 0, gridY: 0, scale: 32, pHash16: flipBits(rand, base, flips), ...dense,
        dHash8: rand() < 0.5 ? dense.dHash8 : randomHex(rand, 8),
      };
      const vault = {
        patchIndex: 1, gridX: 0, gridY: 0, scale: 32, pHash16: base, ...dense,
        colorVector: rand() < 0.5 ? dense.colorVector : [200, 100, 5],
      };
      if (hammingBits(probe.pHash16, vault.pHash16) > 14 && hammingBits(probe.pHash16, vault.pHash16) <= 18) band++;
      expect(patchesMatch(probe, vault)).toBe(legacyPatchesMatch(probe, vault));
    }
    expect(band).toBeGreaterThan(50);
  });
});

describe('matching all indexes', () => {
  const vault = buildSyntheticVault({ seed: 3, indexes: 6, patchesPerIndex: 400, probePatches: 500 });

  test('the generator, run to the end, gives the same hits as the original loop', () => {
    const before = legacyMatchAllIndexes(vault.probe, vault.indexes);
    const after = matchAllIndexesSync(vault.probe, vault.indexes);
    expect(after).toEqual(before);
    // The test data must actually contain a match, or the comparison proves little.
    expect(before.length).toBeGreaterThan(0);
    expect(before[0]!.vaultId).toBe(`vault-${vault.sourceIndex}`);
  });

  test('the yielding driver gives the same hits, in the same order', async () => {
    const before = legacyMatchAllIndexes(vault.probe, vault.indexes);
    const after = await matchAllIndexesYielding(vault.probe, vault.indexes, { sliceMs: 2 });
    expect(after).toEqual(before);
  });

  test('it hands the event loop a turn during the work: a timer fires before the search ends', async () => {
    const big = buildSyntheticVault({ seed: 5, indexes: 30, patchesPerIndex: 1200, probePatches: 1500 });
    let ticks = 0;
    let longestGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
      ticks++;
    }, 5);
    await matchAllIndexesYielding(big.probe, big.indexes, { sliceMs: 10 });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3);
    expect(longestGap).toBeLessThan(250);
  });

  test('cancellation stops the work at the next slice', async () => {
    const big = buildSyntheticVault({ seed: 6, indexes: 40, patchesPerIndex: 1200, probePatches: 1500 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new AbortedError('test')), 15);
    const started = performance.now();
    await expect(
      runWithSignal(controller.signal, () => matchAllIndexesYielding(big.probe, big.indexes, { sliceMs: 5, signal: controller.signal })),
    ).rejects.toBeInstanceOf(AbortedError);
    const spent = performance.now() - started;
    const whole = (() => { const t = performance.now(); matchAllIndexesSync(big.probe, big.indexes); return performance.now() - t; })();
    expect(spent).toBeLessThan(Math.max(250, whole * 0.6));
  });

  test('edge cases: no vault id, no patches, fewer than 40 patches', () => {
    const rand = rng(9);
    const one = buildSyntheticVault({ seed: 9, indexes: 1, patchesPerIndex: 12, probePatches: 40 });
    const indexes: MatchIndex[] = [
      { ...one.indexes[0]!, vaultId: null },
      { ...one.indexes[0]!, vaultId: 'v-empty', vaultPatches: [], vaultByPrefix: new Map() },
      { ...one.indexes[0]!, vaultId: 'v-small' },
    ];
    expect(matchAllIndexesSync(one.probe, indexes)).toEqual(legacyMatchAllIndexes(one.probe, indexes));
    void rand;
  });
});
