/**
 * A phone photo of a screen is recognised by two independent kinds of evidence together: a CLIP embedding chooses the
 * candidate, SIFT points confirm it against the stored original. Neither alone is proof.
 */
import { describe, test, expect } from '@jest/globals';
import {
  CLIP_DUPLICATE_SIMILARITY,
  SCREEN_CLIP_MARGIN_MIN,
  SCREEN_CLIP_MIN,
  SCREEN_POSSIBLE_SIFT_MIN_COVERAGE,
  SCREEN_POSSIBLE_SIFT_MIN_INLIERS,
  SCREEN_SIFT_MIN_COVERAGE,
  SCREEN_SIFT_MIN_INLIERS,
  decideScreenPhoto,
} from '../../src/services/scan/public-scan-decision';

const strong = { clip: 0.82, margin: 0.2, inliers: 300, coverage: 0.8 };

describe('decideScreenPhoto: "protected" needs all four kinds of support', () => {
  test('a clear CLIP lead, confirmed by many aligned points that cover the picture, is protected', () => {
    expect(decideScreenPhoto(strong)).toBe('protected');
    expect(decideScreenPhoto({ clip: SCREEN_CLIP_MIN, margin: SCREEN_CLIP_MARGIN_MIN, inliers: SCREEN_SIFT_MIN_INLIERS, coverage: SCREEN_SIFT_MIN_COVERAGE })).toBe('protected');
  });

  test.each([
    ['CLIP just under', { ...strong, clip: SCREEN_CLIP_MIN - 0.01 }],
    ['margin just under (a look-alike is nearly as close)', { ...strong, margin: SCREEN_CLIP_MARGIN_MIN - 0.01 }],
    ['too few aligned points', { ...strong, inliers: SCREEN_SIFT_MIN_INLIERS - 1 }],
    ['aligned points cover too little of the picture', { ...strong, coverage: SCREEN_SIFT_MIN_COVERAGE - 0.01 }],
  ])('%s is not protected', (_label, evidence) => {
    expect(decideScreenPhoto(evidence)).not.toBe('protected');
  });

  test('without the SIFT confirmation (not run, or unreadable original) it can never be protected', () => {
    expect(decideScreenPhoto({ clip: 0.95, margin: 0.4 })).not.toBe('protected');
    expect(decideScreenPhoto({ clip: 0.95, margin: 0.4, inliers: 500 })).not.toBe('protected'); // coverage unknown
    expect(decideScreenPhoto({ clip: 0.95, margin: 0.4, coverage: 0.9 })).not.toBe('protected'); // inliers unknown
  });

  test('a very high CLIP similarity alone is not proof (look-alike pictures reach 0.75-0.94) and gives no verdict at all', () => {
    expect(decideScreenPhoto({ clip: 0.99, margin: 0.5 })).toBe('not_found');
    expect(decideScreenPhoto({ clip: 0.99, margin: 0.5, inliers: 3, coverage: 0.01 })).toBe('not_found');
  });

  test('plenty of aligned points with no CLIP lead is not protected either', () => {
    expect(decideScreenPhoto({ clip: 0.5, margin: 0.01, inliers: 400, coverage: 0.9 })).toBe('not_found');
  });
});

describe('decideScreenPhoto: "possible" (no owner is shown for it)', () => {
  test('a CLIP lead with aligned detail that covers a fair part of the picture', () => {
    expect(decideScreenPhoto({ clip: 0.72, margin: 0.07, inliers: SCREEN_POSSIBLE_SIFT_MIN_INLIERS, coverage: SCREEN_POSSIBLE_SIFT_MIN_COVERAGE })).toBe('possible');
    expect(decideScreenPhoto({ clip: 0.72, margin: 0.07, inliers: SCREEN_POSSIBLE_SIFT_MIN_INLIERS - 1, coverage: SCREEN_POSSIBLE_SIFT_MIN_COVERAGE })).toBe('not_found');
    expect(decideScreenPhoto({ clip: 0.72, margin: 0.07, inliers: SCREEN_POSSIBLE_SIFT_MIN_INLIERS, coverage: SCREEN_POSSIBLE_SIFT_MIN_COVERAGE - 0.01 })).toBe('not_found');
  });

  test('without the CLIP lead, aligned detail alone gives no "possible" either', () => {
    expect(decideScreenPhoto({ clip: 0.5, margin: 0.01, inliers: 100, coverage: 0.4 })).toBe('not_found');
  });

  test('anything weaker is not found', () => {
    expect(decideScreenPhoto({ clip: 0.6, margin: 0.1 })).toBe('not_found');
    expect(decideScreenPhoto({ clip: 0.69, margin: 0.2, inliers: 200, coverage: 0.9 })).toBe('not_found');
  });
});

describe('decideScreenPhoto: measured on real captures (scan-eval, 2026-10-21)', () => {
  // [clip, lead, aligned SIFT points, coverage] as recorded by the evaluation harness.
  test.each([
    ['screenshot of a protected picture (temple)', 0.758, 0.237, 539, 0.91],
    ['screenshot of a protected picture (portrait)', 0.787, 0.239, 406, 0.86],
    ['real phone photo of a laptop screen, wide shot with bezel and keyboard', 0.815, 0.234, 1120, 0.94],
    ['real phone photo of a laptop screen, close shot', 0.842, 0.279, 1739, 0.95],
  ])('a genuine capture is protected: %s', (_label, clip, margin, inliers, coverage) => {
    expect(decideScreenPhoto({ clip, margin, inliers, coverage })).toBe('protected');
  });

  test.each([
    ['a different photo of the same temple', 0.85, 0.259, 50, 0.32],
    ['a different selfie in the same place', 0.943, 0.426, 48, 0.19],
  ])('a different photo of the same place is neither protected nor possible: %s', (_label, clip, margin, inliers, coverage) => {
    expect(decideScreenPhoto({ clip, margin, inliers, coverage })).toBe('not_found');
  });
});

test('the duplicate threshold is a similarity between two stored pictures, high enough to mean the same picture', () => {
  expect(CLIP_DUPLICATE_SIMILARITY).toBeGreaterThan(0.8);
  expect(CLIP_DUPLICATE_SIMILARITY).toBeLessThan(1);
});
