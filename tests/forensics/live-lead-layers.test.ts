/**
 * When the full DNA comparison does not finish, the report must not invent a percentage for any layer.
 * Only what was really measured is shown; everything else is "not_measured".
 */
import { describe, test, expect } from '@jest/globals';
import { buildLiveLeadLayerAnalysis, layerStatus } from '../../src/services/forensics/live-lead-layers';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('buildLiveLeadLayerAnalysis', () => {
  test('returns all fifteen rows, each with a status', () => {
    const rows = buildLiveLeadLayerAnalysis({ dnaPct: 70 });
    expect(rows).toHaveLength(15);
    expect(rows.map((r) => r.layer)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  test('with nothing measured, every layer is not_measured and carries no percentage', () => {
    const rows = buildLiveLeadLayerAnalysis({ dnaPct: 88 });
    expect(rows.every((r) => r.status === 'not_measured')).toBe(true);
    expect(rows.every((r) => r.matchPercent === 0)).toBe(true);
    expect(rows[0].explanation).toMatch(/^Not measured/);
  });

  test('the exact-copy hash comparison is reported only when both hashes exist', () => {
    const same = buildLiveLeadLayerAnalysis({ dnaPct: 0, originalHash: HASH_A, currentHash: HASH_A.toUpperCase() });
    expect(same[0]).toMatchObject({ layer: 1, matchPercent: 100, status: 'verified' });
    const differs = buildLiveLeadLayerAnalysis({ dnaPct: 0, originalHash: HASH_A, currentHash: HASH_B });
    expect(differs[0]).toMatchObject({ layer: 1, matchPercent: 0, status: 'failed' });
    const missing = buildLiveLeadLayerAnalysis({ dnaPct: 0, originalHash: HASH_A });
    expect(missing[0].status).toBe('not_measured');
  });

  test('structural and perceptual rows use the live scores that were returned, and nothing is derived from them', () => {
    const rows = buildLiveLeadLayerAnalysis({ dnaPct: 90, orbScore: 76.4, simScore: 81.2 });
    const byLayer = new Map(rows.map((r) => [r.layer, r]));
    expect(byLayer.get(2)).toMatchObject({ matchPercent: 76, status: 'warning' });
    expect(byLayer.get(7)).toMatchObject({ matchPercent: 76 });
    expect(byLayer.get(3)).toMatchObject({ matchPercent: 81, status: 'verified' });
    // Metadata, ownership, authenticity and the rest used to be scaled from the perceptual figure; they must not be.
    for (const n of [4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15]) {
      expect(byLayer.get(n)?.status).toBe('not_measured');
      expect(byLayer.get(n)?.matchPercent).toBe(0);
    }
  });

  test('without a live structural score, the structural rows are not measured (no value guessed from the perceptual one)', () => {
    const rows = buildLiveLeadLayerAnalysis({ dnaPct: 90, simScore: 90 });
    expect(rows.find((r) => r.layer === 2)?.status).toBe('not_measured');
    expect(rows.find((r) => r.layer === 7)?.status).toBe('not_measured');
    expect(rows.find((r) => r.layer === 3)?.status).toBe('verified');
  });
});

describe('layerStatus', () => {
  test('keeps its thresholds', () => {
    expect(layerStatus(80)).toBe('verified');
    expect(layerStatus(50)).toBe('warning');
    expect(layerStatus(49)).toBe('failed');
    expect(layerStatus(100, true)).toBe('skipped');
  });
});
