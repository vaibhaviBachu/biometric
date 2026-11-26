/**
 * Large camera originals must get search data (they used to get none), from a reduced copy, without touching the
 * original; small images must be handled exactly as before; failures must say where they happened.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import sharp from 'sharp';

type AnyAsync = (...args: unknown[]) => Promise<unknown>;

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    localFeatureIndex: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    localDnaPatch: { deleteMany: jest.fn() },
    localDnaPatchArchive: { deleteMany: jest.fn() },
    vaultRecord: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/config/local-dna', () => ({ localDnaConfig: { enabled: true } }));
jest.mock('../../src/services/ai/ai-embeddings.service', () => ({ aiService: { extractLocalDnaIndex: jest.fn() } }));
jest.mock('../../src/services/forensics/forensic-scanner.service', () => ({ forensicScannerService: { indexVaultTiles: jest.fn(async () => undefined) } }));
jest.mock('../../src/services/forensics/local-dna-patch-generator.service', () => ({
  localDnaPatchGenerator: {
    generateMultiScaleGrid: jest.fn(async () => ({
      imageWidth: 640, imageHeight: 480, patchSize: 32, gridCols: 20, gridRows: 15, scales: [32], globalPHash: 'a'.repeat(16),
      patches: Array.from({ length: 10 }, (_, i) => ({
        patchIndex: i, gridX: i, gridY: 0, scale: 32, pHash16: '0123456789abcdef', dHash8: '01234567', aHash8: '89abcdef',
        edgeSignature: '0a', colorVector: [1, 2, 3], frequencySig: '0b', textureSig: '0c',
      })),
    })),
  },
}));

import { prisma } from '../../src/lib/prisma';
import { logger } from '../../src/lib/logger';
import { aiService } from '../../src/services/ai/ai-embeddings.service';
import { forensicScannerService } from '../../src/services/forensics/forensic-scanner.service';
import { localDnaPatchGenerator } from '../../src/services/forensics/local-dna-patch-generator.service';
import { LocalDnaIndexService } from '../../src/services/forensics/local-dna-index.service';

const fm = (prisma.localFeatureIndex.findMany as unknown as jest.Mock<AnyAsync>);
const findUnique = prisma.localFeatureIndex.findUnique as unknown as jest.Mock<AnyAsync>;
const create = prisma.localFeatureIndex.create as unknown as jest.Mock<AnyAsync>;
const vaultFindMany = prisma.vaultRecord.findMany as unknown as jest.Mock<AnyAsync>;
const extract = aiService.extractLocalDnaIndex as unknown as jest.Mock<AnyAsync>;
const grid = localDnaPatchGenerator.generateMultiScaleGrid as unknown as jest.Mock<AnyAsync>;
const tiles = forensicScannerService.indexVaultTiles as unknown as jest.Mock<AnyAsync>;

async function photo(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let s = 99;
  for (let i = 0; i < raw.length; i++) { s = (s * 1664525 + 1013904223) % 4294967296; raw[i] = (s >>> 24) & 0xff; }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

const base = { mimeType: 'image/jpeg', dnaRecordId: 'dna-1', vaultId: 'vault-1', ownerUserId: 'owner-1' };
let service: LocalDnaIndexService;

beforeEach(() => {
  jest.clearAllMocks();
  service = new LocalDnaIndexService();
  findUnique.mockResolvedValue(null);
  create.mockResolvedValue({ id: 'index-new' });
  extract.mockResolvedValue({ orbKeypoints: 1500, orbDescriptors: { keypoints: [] } });
});

describe('building the index', () => {
  test('a large original is analysed from a reduced copy; the original buffer is untouched', async () => {
    const big = await photo(6000, 4000);
    const snapshot = Buffer.from(big);
    expect(await service.buildIndex({ ...base, buffer: big })).toEqual({ patchCount: 10, indexId: 'index-new' });
    const gridInput = grid.mock.calls[0]![0] as Buffer;
    const aiInput = extract.mock.calls[0]![0] as Buffer;
    const tileInput = tiles.mock.calls[0]![0] as Buffer;
    for (const used of [gridInput, aiInput, tileInput]) {
      expect(used).not.toBe(big);
      expect(used.length).toBeLessThan(big.length / 3);
      const meta = await sharp(used).metadata();
      expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2400);
    }
    expect(big.equals(snapshot)).toBe(true);
  }, 120000);

  test('a small image is handled exactly as before: the very same buffer goes to every step', async () => {
    const small = await photo(800, 600);
    await service.buildIndex({ ...base, buffer: small });
    expect(grid.mock.calls[0]![0]).toBe(small);
    expect(extract.mock.calls[0]![0]).toBe(small);
    expect(tiles.mock.calls[0]![0]).toBe(small);
  });

  test('an AI service that returns nothing still stores the patch index, and says it has no feature points', async () => {
    extract.mockResolvedValue(null);
    const small = await photo(800, 600);
    expect(await service.buildIndex({ ...base, buffer: small })).not.toBeNull();
    expect(create).toHaveBeenCalled();
    const warns = (logger.warn as unknown as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(warns.some((m) => m.includes('without feature points'))).toBe(true);
  });

  test('a failure reports the stage, the size and the time', async () => {
    grid.mockRejectedValueOnce(new Error('decode blew up'));
    const small = await photo(800, 600);
    expect(await service.buildIndex({ ...base, buffer: small })).toBeNull();
    const call = (logger.error as unknown as jest.Mock).mock.calls.find((c) => String(c[0]).includes('Build failed'))!;
    expect(call[1]).toMatchObject({ stage: 'grid' });
    expect(String((call[1] as { error: string }).error)).toContain('decode blew up');
  });
});

describe('finding and filling the gaps', () => {
  const vault = (id: string, mime: string, owner: string | null = 'owner-1') => ({
    id: `vault-${id}`, dnaRecordId: `dna-${id}`, dnaRecord: { ownerUserId: owner, imageMimeType: mime, imageSizeBytes: 1000 },
  });

  test('lists images with no index or no feature points, skips HEIC, and never writes in a dry run', async () => {
    vaultFindMany.mockResolvedValue([
      vault('a', 'image/jpeg'), // no index
      vault('b', 'image/jpeg'), // indexed, no feature points
      vault('c', 'image/png'), // fine
      vault('d', 'image/heic'), // cannot be decoded here
      vault('e', 'image/jpeg', null), // no owner
    ]);
    fm.mockResolvedValue([{ dnaRecordId: 'dna-b', orbKeypoints: 0 }, { dnaRecordId: 'dna-c', orbKeypoints: 1500 }]);
    const result = await service.backfillMissing();
    expect(result).toMatchObject({ dryRun: true, gaps: 2, unsupported: 1, built: 0, failed: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    const { gaps } = await service.findIndexGaps();
    expect(gaps.map((g) => [g.dnaRecordId, g.reason])).toEqual([['dna-a', 'NO_INDEX'], ['dna-b', 'NO_FEATURE_POINTS']]);
  });
});
