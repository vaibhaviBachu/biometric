/**
 * Camera photos of a screen or print: a result that rests on feature points alone is only ever "possible",
 * needs both a high similarity and enough matching points, and shows no owner.
 */
import { describe, test, expect } from '@jest/globals';
import {
  FEATURE_ONLY_MIN_MATCHES,
  FEATURE_ONLY_MIN_SIMILARITY,
  decideFeatureOnly,
  decidePublicScan,
  toPublicScanBody,
} from '../../src/services/scan/public-scan-decision';

describe('decideFeatureOnly', () => {
  test('needs both a high similarity and enough matching points', () => {
    expect(decideFeatureOnly(FEATURE_ONLY_MIN_SIMILARITY, FEATURE_ONLY_MIN_MATCHES)).toBe('possible');
    expect(decideFeatureOnly(1, 500)).toBe('possible');
    expect(decideFeatureOnly(FEATURE_ONLY_MIN_SIMILARITY - 0.01, 500)).toBe('not_found');
    expect(decideFeatureOnly(1, FEATURE_ONLY_MIN_MATCHES - 1)).toBe('not_found');
    expect(decideFeatureOnly(0, 0)).toBe('not_found');
  });

  test('never reaches "protected" on its own', () => {
    for (const similarity of [0.7, 0.9, 1]) {
      for (const matches of [25, 100, 1000]) {
        expect(decideFeatureOnly(similarity, matches)).not.toBe('protected');
      }
    }
  });

  test('the existing rules are unchanged: a weak picture match without features is still not "protected"', () => {
    expect(decidePublicScan({ markFound: false, visual: 0.8, featureConfirmed: true })).toBe('not_found');
    expect(decidePublicScan({ markFound: false, visual: 0.92, featureConfirmed: false })).toBe('possible');
    expect(decidePublicScan({ markFound: false, visual: 0.92, featureConfirmed: true })).toBe('protected');
    expect(decidePublicScan({ markFound: true, visual: 0, featureConfirmed: false })).toBe('protected');
  });
});

describe('the public card for a feature-only result', () => {
  test('is "possible", carries the date and strength, and names no owner, title or recipient', () => {
    const body = toPublicScanBody({
      verdict: 'possible',
      protectedAt: '2026-10-13T08:00:00.000Z',
      matchStrength: 83,
      dnaRecordId: 'secret-internal-id',
    });
    expect(body.verdict).toBe('possible');
    expect(body.protectedAt).toBe('2026-10-13T08:00:00.000Z');
    expect(body.matchStrength).toBe(83);
    const keys = Object.keys(body);
    for (const forbidden of ['ownerPinitId', 'title', 'recipientLabel', 'dnaRecordId', 'vaultId', 'email']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(JSON.stringify(body)).not.toContain('secret-internal-id');
  });
});
