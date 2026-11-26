/**
 * Pin It does not refuse a video because its pictures look like another clip.
 * Ten phones at the same beach can share sunrise frames; each person may protect
 * their own file. Duplicate is SHA-256 / TEP / HMAC identity in the container.
 */
import '../watermark/helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

type AnyAsync = (...args: unknown[]) => Promise<unknown>;

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    dnaRecord: { findFirst: jest.fn(), findUnique: jest.fn() },
    cryptoLayer: { findFirst: jest.fn() },
    perceptualLayer: { findMany: jest.fn() },
    asset: { findMany: jest.fn() },
    localFeatureIndex: { findMany: jest.fn(async () => []) },
    duplicateAttempt: { create: jest.fn() },
    user: { findUnique: jest.fn(async () => ({ shortId: 'PINIT-UPLOADER' })) },
  },
}));

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/services/audit/audit.service', () => ({
  auditService: { log: jest.fn(async () => undefined) },
}));

jest.mock('../../src/services/identity/identity-embedding.service', () => ({
  identityEmbeddingService: { extractAndVerify: jest.fn(async () => ({ verified: false })) },
}));

jest.mock('../../src/services/tep/tep.service', () => ({
  tepService: { extractFromFile: jest.fn(async () => ({ found: false })) },
}));

jest.mock('../../src/services/duplicate/pinit-signature-detector.service', () => ({
  pinitSignatureDetector: { detect: jest.fn(async () => ({ detected: false })) },
}));

jest.mock('../../src/services/assets/video-asset-dna.service', () => ({
  buildVideoAssetDna: jest.fn(),
}));

import { prisma } from '../../src/lib/prisma';
import { DuplicateCheckService } from '../../src/services/duplicate/duplicate-check.service';
import { buildVideoAssetDna } from '../../src/services/assets/video-asset-dna.service';

const dnaFindFirst = prisma.dnaRecord.findFirst as unknown as jest.Mock<AnyAsync>;
const dnaFindUnique = prisma.dnaRecord.findUnique as unknown as jest.Mock<AnyAsync>;
const cryptoFindFirst = prisma.cryptoLayer.findFirst as unknown as jest.Mock<AnyAsync>;
const assetFindMany = prisma.asset.findMany as unknown as jest.Mock<AnyAsync>;
const videoDna = buildVideoAssetDna as unknown as jest.Mock<AnyAsync>;

const UPLOADER = 'user-a';
const OTHER = 'user-b';
const req = () => ({ user: { sub: UPLOADER }, headers: {}, ip: '1.2.3.4' } as never);

const ownedBy = (ownerUserId: string | null) => ({
  id: 'dna-video-1',
  imageFilename: 'Coffee.mp4',
  createdAt: new Date(),
  ownerUserId,
  ownerUser: ownerUserId ? { shortId: 'PINIT-OTHER' } : null,
});

let service: DuplicateCheckService;

beforeEach(() => {
  dnaFindFirst.mockReset();
  dnaFindUnique.mockReset();
  cryptoFindFirst.mockReset();
  assetFindMany.mockReset();
  videoDna.mockReset();

  dnaFindFirst.mockResolvedValue(null);   // no exact hash match
  cryptoFindFirst.mockResolvedValue(null);
  assetFindMany.mockResolvedValue([]);
  videoDna.mockResolvedValue({ framePHashes: [], ffmpegAvailable: true });
  dnaFindUnique.mockResolvedValue(ownedBy(OTHER));

  service = new DuplicateCheckService();
});

const uploadVideo = () =>
  service.check(Buffer.from('re-encoded bytes'), 'video/mp4', 'stolen.mp4', req());

describe('video keyframe duplicate detection', () => {
  test('a re-encoded look-alike from another account is NOT blocked — similar frames are not identity', async () => {
    const result = await uploadVideo();

    expect(result.isDuplicate).toBe(false);
    expect(videoDna).not.toHaveBeenCalled();
    expect(assetFindMany).not.toHaveBeenCalled();
  });

  test('an exact byte match still blocks as identity, not as similar pictures', async () => {
    dnaFindFirst.mockResolvedValue(ownedBy(OTHER));

    const result = await uploadVideo();

    expect(result.isDuplicate).toBe(true);
    expect(result.matchType).toBe('EXACT_HASH');
    expect(result.ownerShortId).toBe('PINIT-OTHER');
    expect(videoDna).not.toHaveBeenCalled();
  });
});
