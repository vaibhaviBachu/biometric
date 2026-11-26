/**
 * Edited copies (crops, rotations, mirrors, overlays, borders, a photo of a screen) fail the picture fingerprint but keep
 * their feature points. The scan now checks that matches agree on ONE alignment, and a strong consistent alignment is
 * "Protected"; everything weaker behaves as before.
 */
import { describe, test, expect } from '@jest/globals';
import {
  FEATURE_CONFIRM_MIN_INLIERS,
  FEATURE_PROTECTED_MIN_AGREEMENT,
  FEATURE_POSSIBLE_MIN_INLIERS,
  FEATURE_PROTECTED_MIN_COVERAGE,
  FEATURE_PROTECTED_MIN_INLIERS,
  decideFeatureMatch,
  featureConfirms,
} from '../../src/services/scan/public-scan-decision';

describe('decideFeatureMatch', () => {
  test('a strong, consistent alignment is "protected"', () => {
    expect(decideFeatureMatch({ similarity: 1, matches: 600, inliers: 400, ratioMatches: 450, probeCoverage: 0.95, referenceCoverage: 0.95 })).toBe('protected');
    expect(decideFeatureMatch({ similarity: 1, matches: 200, inliers: FEATURE_PROTECTED_MIN_INLIERS, ratioMatches: 250, probeCoverage: 0.95, referenceCoverage: 0.95 })).toBe('protected');
  });

  test('just under the cut-off is not "protected"', () => {
    const v = decideFeatureMatch({ similarity: 1, matches: 200, inliers: FEATURE_PROTECTED_MIN_INLIERS - 1, ratioMatches: 200, probeCoverage: 0.95, referenceCoverage: 0.95 });
    expect(v).not.toBe('protected');
  });

  describe('coverage: how much of a picture the aligned points explain', () => {
    const strong = { similarity: 1, matches: 600, inliers: 300, ratioMatches: 340 };

    test('a template look-alike (shares a background, most of the rest redrawn) is not "protected"', () => {
      // Measured on synthetic look-alikes: redrawing 50% / 60% / 75% of a picture covered about 41% / 30% / 14%.
      for (const coverage of [0.41, 0.3, 0.14]) {
        expect(decideFeatureMatch({ ...strong, probeCoverage: coverage, referenceCoverage: coverage })).toBe('possible');
      }
    });

    test('the cut-off is exact', () => {
      expect(decideFeatureMatch({ ...strong, probeCoverage: FEATURE_PROTECTED_MIN_COVERAGE, referenceCoverage: 0.1 })).toBe('protected');
      expect(decideFeatureMatch({ ...strong, probeCoverage: FEATURE_PROTECTED_MIN_COVERAGE - 0.01, referenceCoverage: 0.1 })).toBe('possible');
    });

    test('either picture being explained is enough: a crop of the original, or the original inside a larger screenshot', () => {
      expect(decideFeatureMatch({ ...strong, probeCoverage: 0.95, referenceCoverage: 0.2 })).toBe('protected'); // crop
      expect(decideFeatureMatch({ ...strong, probeCoverage: 0.2, referenceCoverage: 0.95 })).toBe('protected'); // pasted into a larger picture
    });

    test('coverage that is not reported never produces "protected" (an older or partial AI service)', () => {
      expect(decideFeatureMatch(strong)).toBe('possible');
      expect(decideFeatureMatch({ ...strong, probeCoverage: 0.95 })).toBe('possible');
      expect(decideFeatureMatch({ ...strong, referenceCoverage: 0.95 })).toBe('possible');
    });
  });

  test('many matches that do not agree on one alignment are not "protected" (busy graphics, look-alikes)', () => {
    const ratioMatches = Math.ceil(FEATURE_PROTECTED_MIN_INLIERS / (FEATURE_PROTECTED_MIN_AGREEMENT - 0.05));
    expect(decideFeatureMatch({ similarity: 1, matches: 900, inliers: FEATURE_PROTECTED_MIN_INLIERS, ratioMatches, probeCoverage: 0.95, referenceCoverage: 0.95 })).not.toBe('protected');
  });

  test('weaker evidence is "possible" exactly as before, and noise is "not_found"', () => {
    expect(decideFeatureMatch({ similarity: 0.9, matches: 120, inliers: 90, ratioMatches: 130 })).toBe('possible');
    expect(decideFeatureMatch({ similarity: 0.533, matches: 80, inliers: 20, ratioMatches: 40 })).toBe('not_found');
    expect(decideFeatureMatch({ similarity: 0, matches: 0, inliers: 0, ratioMatches: 0 })).toBe('not_found');
  });

  test('many raw matches without an alignment (text-heavy pictures) are not even "possible"', () => {
    // Measured: unrelated certificate and badge images, 190-206 raw matches, 9-15 aligned.
    expect(decideFeatureMatch({ similarity: 1, matches: 206, inliers: 15, ratioMatches: 80 })).toBe('not_found');
    expect(decideFeatureMatch({ similarity: 1, matches: 197, inliers: 9, ratioMatches: 60 })).toBe('not_found');
    expect(decideFeatureMatch({ similarity: 1, matches: 150, inliers: FEATURE_POSSIBLE_MIN_INLIERS, ratioMatches: 70 })).toBe('possible');
    expect(decideFeatureMatch({ similarity: 1, matches: 150, inliers: FEATURE_POSSIBLE_MIN_INLIERS - 1, ratioMatches: 70 })).toBe('not_found');
  });

  test('an AI service that does not report alignment can never produce "protected"', () => {
    for (const similarity of [0.7, 1]) {
      for (const matches of [25, 150, 1500]) {
        expect(decideFeatureMatch({ similarity, matches })).not.toBe('protected');
      }
    }
    expect(decideFeatureMatch({ similarity: 1, matches: 500 })).toBe('possible');
  });
});

describe('featureConfirms (the second check for a picture-fingerprint look-alike)', () => {
  test('uses aligned points when they are reported', () => {
    expect(featureConfirms({ similarity: 1, matches: 900, inliers: FEATURE_CONFIRM_MIN_INLIERS })).toBe(true);
    // Many raw matches but no consistent alignment no longer confirms a look-alike.
    expect(featureConfirms({ similarity: 1, matches: 900, inliers: FEATURE_CONFIRM_MIN_INLIERS - 1 })).toBe(false);
  });

  test('falls back to the earlier raw-match rule when the AI service does not report alignment', () => {
    expect(featureConfirms({ similarity: 0.5, matches: 80 })).toBe(true);
    expect(featureConfirms({ similarity: 0.49, matches: 80 })).toBe(false);
  });
});
