/**
 * A protected download is the owner's media plus PINIT identity data added after it. It must be recognised as the
 * same video, not reported as a re-compressed, cropped and resized copy.
 */
import { describe, test, expect, jest } from '@jest/globals';

const mockPartial = jest.fn();
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/services/forensics/media-tools.service', () => ({ isFfmpegAvailable: async () => true }));
jest.mock('../../src/services/forensics/partial-video-recovery.service', () => ({
  comparePartialVideoProbeToVault: (...a: unknown[]) => mockPartial(...a),
  partialVideoToRetrievalScores: () => ({ retrievalBoost: 80 }),
}));

import {
  isOriginalWithIdentityTail,
  computeVideoForensicScores,
  compareVideoInvestigation,
} from '../../src/services/forensics/video-forensic-compare.service';

const media = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(50_000, 7)]);
const identityAtProtect = Buffer.from('\u0000PINIT-DNA-SIG:PINIT-DNA:v1:d408d6fa-31c0');
const original = Buffer.concat([media, identityAtProtect]); // what the vault returns
const downloaded = Buffer.concat([original, Buffer.from('PINIT-VAULT-VIDEO|PINIT-IDT|eyJ2IjoxLCJpYXQiOiIyMDI2LTExLTA0\n')]);

describe('isOriginalWithIdentityTail', () => {
  test('the original plus appended PINIT data is the same media', () => {
    expect(isOriginalWithIdentityTail(original, downloaded)).toBe(true);
    // also true against the pure media, when the vault copy is the pure registered file
    expect(isOriginalWithIdentityTail(media, downloaded)).toBe(true);
  });

  test('identical files are not "tail only" (that is the exact-hash case)', () => {
    expect(isOriginalWithIdentityTail(original, Buffer.from(original))).toBe(false);
  });

  test('extra bytes that are not PINIT data do not count', () => {
    expect(isOriginalWithIdentityTail(original, Buffer.concat([original, Buffer.from('some other trailing bytes')]))).toBe(false);
  });

  test('a changed media byte, or a different file, never counts', () => {
    const edited = Buffer.from(downloaded);
    edited[1000] = 99;
    expect(isOriginalWithIdentityTail(original, edited)).toBe(false);
    expect(isOriginalWithIdentityTail(original, Buffer.concat([Buffer.alloc(original.length, 1), Buffer.from('PINIT')]))).toBe(false);
  });

  test('a large appended payload is not an identity tag', () => {
    expect(isOriginalWithIdentityTail(original, Buffer.concat([original, Buffer.from('PINIT'), Buffer.alloc(300 * 1024, 5)]))).toBe(false);
  });

  test('empty original never matches', () => {
    expect(isOriginalWithIdentityTail(Buffer.alloc(0), downloaded)).toBe(false);
  });
});

describe('video comparison of a protected download', () => {
  test('scores as identical media without sampling frames', async () => {
    mockPartial.mockReset();
    const s = await computeVideoForensicScores(original, downloaded, 'video/webm', 'video/webm', 'a.webm', 'a.webm');
    expect(s.identityTailOnly).toBe(true);
    expect(s.perceptualScore).toBe(1);
    expect(mockPartial).not.toHaveBeenCalled();
  });

  test('the comparison is a full match with no tamper and no layer marked changed', async () => {
    const cmp = await compareVideoInvestigation(
      { buffer: original, mimeType: 'video/webm', originalName: 'a.webm', sizeBytes: original.length },
      { buffer: downloaded, mimeType: 'video/webm', originalName: 'a.webm', sizeBytes: downloaded.length },
    );
    expect(cmp.overallConfidenceScore).toBe(100);
    expect(cmp.classification).toBe('DNA_MATCH');
    expect(cmp.tamperingDetected).toBe(false);
    const l1 = cmp.layerComparisons.find((l) => l.layer === 1)!;
    expect(l1.similarityPercent).toBe(100);
    expect(l1.changeDescription).toMatch(/only PINIT identity data/);
    expect(cmp.layerComparisons.filter((l) => l.layer <= 5).every((l) => l.matched)).toBe(true);
  });

  test('a genuinely different video still goes through frame comparison', async () => {
    mockPartial.mockResolvedValue({
      avgMatchedPerceptual: 0.8, matchedFrameRatio: 0.7, temporalConsistency: 0.6, audioScore: 50, compositeScore: 60,
      probeFrameCount: 9, vaultFrameCount: 6,
    });
    const reencoded = Buffer.alloc(40_000, 3);
    const s = await computeVideoForensicScores(original, reencoded, 'video/webm', 'video/webm', 'a.webm', 'b.webm');
    expect(s.identityTailOnly).toBeUndefined();
    expect(s.sha256Exact).toBe(false);
    expect(mockPartial).toHaveBeenCalled();
    expect(s.perceptualScore).toBeLessThan(1);
  });
});
