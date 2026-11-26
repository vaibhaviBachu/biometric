/**
 * The CLIP embedding the public scan needs is stored with the feature index when an image is protected, never at the
 * cost of protecting it, and the backfill for existing images is a dry run by default that writes only the `clip` key.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

type AnyAsync = (...args: unknown[]) => Promise<unknown>;

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    localFeatureIndex: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    localDnaPatch: { deleteMany: jest.fn() },
    localDnaPatchArchive: { deleteMany: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  },
}));
jest.mock('../../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/config/local-dna', () => ({ localDnaConfig: { enabled: true } }));
jest.mock('../../src/services/ai/ai-embeddings.service', () => ({
  aiService: { extractLocalDnaIndex: jest.fn(), embedImageClip: jest.fn() },
}));
jest.mock('../../src/services/forensics/forensic-scanner.service', () => ({
  forensicScannerService: { indexVaultTiles: jest.fn(async () => undefined) },
}));
jest.mock('../../src/services/forensics/analysis-copy', () => ({
  prepareAnalysisCopy: jest.fn(async (buffer: Buffer, mimeType: string) => ({ buffer, mimeType, reduced: false })),
}));
jest.mock('../../src/services/forensics/local-dna-patch-generator.service', () => ({
  localDnaPatchGenerator: {
    generateMultiScaleGrid: jest.fn(async () => ({
      imageWidth: 640, imageHeight: 480, patchSize: 32, gridCols: 20, gridRows: 15, scales: [32], globalPHash: 'a'.repeat(16),
      patches: Array.from({ length: 4 }, (_, i) => ({
        patchIndex: i, gridX: i, gridY: 0, scale: 32, pHash16: '0123456789abcdef', dHash8: '01234567', aHash8: '89abcdef',
        edgeSignature: '0a', colorVector: [1, 2, 3], frequencySig: '0b', textureSig: '0c',
      })),
    })),
  },
}));
const mockRetrieve = jest.fn();
jest.mock('../../src/services/vault/vault.service', () => ({
  VaultService: class { retrieve = (...a: unknown[]) => mockRetrieve(...a); },
}));

import { prisma } from '../../src/lib/prisma';
import { aiService } from '../../src/services/ai/ai-embeddings.service';
import { LocalDnaIndexService } from '../../src/services/forensics/local-dna-index.service';

const create = prisma.localFeatureIndex.create as unknown as jest.Mock<AnyAsync>;
const findUnique = prisma.localFeatureIndex.findUnique as unknown as jest.Mock<AnyAsync>;
const queryRaw = prisma.$queryRaw as unknown as jest.Mock<AnyAsync>;
const executeRaw = prisma.$executeRaw as unknown as jest.Mock<AnyAsync>;
const extract = aiService.extractLocalDnaIndex as unknown as jest.Mock<AnyAsync>;
const embed = aiService.embedImageClip as unknown as jest.Mock<AnyAsync>;

const params = { buffer: Buffer.from('img'), mimeType: 'image/png', dnaRecordId: 'dna-1', vaultId: 'vault-1', ownerUserId: 'owner-1' };
const CLIP = Array.from({ length: 512 }, (_, i) => (i % 7) / 10);
let service: LocalDnaIndexService;

beforeEach(() => {
  jest.clearAllMocks();
  service = new LocalDnaIndexService();
  findUnique.mockResolvedValue(null);
  create.mockResolvedValue({ id: 'index-new' });
  extract.mockResolvedValue({ orbKeypoints: 3, orbDescriptors: { keypoints: [{ x: 0.1 }], method: 'opencv_orb' } });
  embed.mockResolvedValue(CLIP);
});

describe('protecting an image', () => {
  test('the embedding is stored next to the feature points, which are kept intact', async () => {
    await service.buildIndex(params);
    const stored = (create.mock.calls[0]![0] as { data: { orbDescriptors: Record<string, unknown>; orbKeypoints: number } }).data;
    expect(stored.orbDescriptors.clip).toEqual(CLIP);
    expect(stored.orbDescriptors.keypoints).toEqual([{ x: 0.1 }]);
    expect(stored.orbDescriptors.method).toBe('opencv_orb');
    expect(stored.orbKeypoints).toBe(3);
  });

  test('an embedding that cannot be made never stops the image being protected, and nothing is invented', async () => {
    embed.mockResolvedValue(null);
    const result = await service.buildIndex(params);
    expect(result).not.toBeNull();
    const stored = (create.mock.calls[0]![0] as { data: { orbDescriptors: Record<string, unknown> } }).data.orbDescriptors;
    expect('clip' in stored).toBe(false);
    expect(stored.keypoints).toEqual([{ x: 0.1 }]);
  });

  test('an embedding call that throws is survived too', async () => {
    embed.mockRejectedValue(new Error('AI service down'));
    expect(await service.buildIndex(params)).not.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('the embedding is kept even when no feature points could be found', async () => {
    extract.mockResolvedValue(null);
    await service.buildIndex(params);
    const stored = (create.mock.calls[0]![0] as { data: { orbDescriptors: Record<string, unknown>; orbKeypoints: number } }).data;
    expect(stored.orbDescriptors).toEqual({ clip: CLIP });
    expect(stored.orbKeypoints).toBe(0);
  });
});

describe('backfilling existing images', () => {
  const gaps = [
    { dnaRecordId: 'dna-a', vaultId: 'vault-a', ownerUserId: 'owner-a' },
    { dnaRecordId: 'dna-b', vaultId: 'vault-b', ownerUserId: 'owner-b' },
  ];
  beforeEach(() => {
    queryRaw.mockResolvedValue(gaps);
    executeRaw.mockResolvedValue(1);
    mockRetrieve.mockResolvedValue({ originalBuffer: Buffer.from('original'), originalMimeType: 'image/jpeg' });
  });

  test('is a dry run by default: it counts and writes nothing, and reads nothing from the Vault', async () => {
    expect(await service.backfillClipEmbeddings()).toEqual({ dryRun: true, missing: 2, updated: 0, failed: 0 });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  test('applied, it adds only the clip key to each gap', async () => {
    expect(await service.backfillClipEmbeddings({ dryRun: false })).toEqual({ dryRun: false, missing: 2, updated: 2, failed: 0 });
    expect(executeRaw).toHaveBeenCalledTimes(2);
    const sql = (executeRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(sql).toMatch(/jsonb_build_object\('clip'/);
    expect(sql).toMatch(/\|\|/); // merged into the existing JSON, never replacing it
    expect(sql).not.toMatch(/DELETE|DROP|TRUNCATE/i);
    expect(sql).toMatch(/WHERE "dnaRecordId"/);
  });

  test('an image that cannot be read from the Vault (another key) is skipped and counted, the rest continue', async () => {
    mockRetrieve.mockRejectedValueOnce(new Error('Vault decrypt failed')).mockResolvedValue({ originalBuffer: Buffer.from('x'), originalMimeType: 'image/jpeg' });
    expect(await service.backfillClipEmbeddings({ dryRun: false })).toEqual({ dryRun: false, missing: 2, updated: 1, failed: 1 });
  });

  test('an embedding that cannot be made is counted as failed and nothing is written for it', async () => {
    embed.mockResolvedValue(null);
    expect(await service.backfillClipEmbeddings({ dryRun: false })).toEqual({ dryRun: false, missing: 2, updated: 0, failed: 2 });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  test('--only pins the run to exactly those records and refuses ones that are not gaps', async () => {
    expect(await service.backfillClipEmbeddings({ dryRun: false, only: ['dna-b'] })).toEqual({ dryRun: false, missing: 1, updated: 1, failed: 0 });
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    expect(mockRetrieve.mock.calls[0]![0]).toBe('vault-b');
    await expect(service.backfillClipEmbeddings({ dryRun: false, only: ['dna-zzz'] })).rejects.toThrow(/Not a CLIP gap/);
  });

  test('non-image vault files are not embedded', async () => {
    mockRetrieve.mockResolvedValue({ originalBuffer: Buffer.from('pdf'), originalMimeType: 'application/pdf' });
    expect(await service.backfillClipEmbeddings({ dryRun: false })).toMatchObject({ updated: 0, failed: 0 });
    expect(executeRaw).not.toHaveBeenCalled();
  });
});
