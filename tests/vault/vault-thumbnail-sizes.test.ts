/** Two stored preview sizes (480 px for galleries, 960 px for public portfolio pages), each made once and kept separately. */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const mockRecord = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/prisma', () => ({ prisma: { vaultRecord: { findUnique: (...a: unknown[]) => mockRecord(...a) } } }));
jest.mock('../../src/lib/vault-storage-backend', () => ({
  downloadVaultObject: jest.fn(), isCloudStorageConfigured: () => false, uploadVaultObject: jest.fn(),
}));
jest.mock('../../src/services/forensics/media-tools.service', () => ({ isFfmpegAvailable: async () => false }));

import sharp from 'sharp';
import { getVaultThumbnail, forgetVaultThumbnail, clearVaultThumbnailMemory } from '../../src/services/vault/vault-thumbnail.service';
import { thumbnailStoragePath } from '../../src/services/vault/vault-thumbnail-path';
import { AppError } from '../../src/api/middleware/error.middleware';

let big: Buffer;
const retrieve = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const vault = { retrieve: (...a: unknown[]) => retrieve(...a) } as never;

beforeEach(async () => {
  clearVaultThumbnailMemory();
  retrieve.mockReset();
  mockRecord.mockReset().mockResolvedValue({
    originalFileName: 'sunset.jpg', originalMimeType: 'image/jpeg', encryptedFilePath: 'o/v.enc', dnaRecord: { ownerUserId: 'owner-1' },
  });
  big ??= await sharp({ create: { width: 2400, height: 1600, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg().toBuffer();
  retrieve.mockResolvedValue({ originalBuffer: big });
});

const sideOf = async (b: Buffer) => { const m = await sharp(b).metadata(); return Math.max(m.width ?? 0, m.height ?? 0); };

describe('vault thumbnails in two sizes', () => {
  test('small fits 480 px and large fits 960 px, and each is made once', async () => {
    const small = (await getVaultThumbnail(vault, 'v1', 'owner-1'))!;
    const large = (await getVaultThumbnail(vault, 'v1', 'owner-1', 'large'))!;
    expect(await sideOf(small)).toBe(480);
    expect(await sideOf(large)).toBe(960);
    expect(large.length).toBeGreaterThan(small.length);
    expect(retrieve).toHaveBeenCalledTimes(2);
    await getVaultThumbnail(vault, 'v1', 'owner-1');
    await getVaultThumbnail(vault, 'v1', 'owner-1', 'large');
    expect(retrieve).toHaveBeenCalledTimes(2); // both answered from memory
  });

  test('asked for at the same time, one size is made once', async () => {
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => getVaultThumbnail(vault, 'v2', 'owner-1', 'large')));
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  test('forgetting a file clears both sizes', async () => {
    await getVaultThumbnail(vault, 'v3', 'owner-1');
    await getVaultThumbnail(vault, 'v3', 'owner-1', 'large');
    forgetVaultThumbnail('v3');
    await getVaultThumbnail(vault, 'v3', 'owner-1');
    await getVaultThumbnail(vault, 'v3', 'owner-1', 'large');
    expect(retrieve).toHaveBeenCalledTimes(4);
  });

  test('storage that cannot be reached is not remembered as a missing file: the next request tries again', async () => {
    retrieve.mockRejectedValueOnce(new AppError(503, 'Your file storage is temporarily unreachable. The file is not lost.'));
    await expect(getVaultThumbnail(vault, 'v4', 'owner-1', 'large')).rejects.toThrow(/temporarily unreachable/);
    const again = await getVaultThumbnail(vault, 'v4', 'owner-1', 'large');
    expect(await sideOf(again!)).toBe(960);
  });

  test('a file that is really gone is remembered for a while, not searched for again on every request', async () => {
    retrieve.mockRejectedValue(new Error('This protected file is not in cloud storage. Protect the file again.'));
    await expect(getVaultThumbnail(vault, 'v5', 'owner-1')).rejects.toThrow();
    await expect(getVaultThumbnail(vault, 'v5', 'owner-1')).rejects.toThrow();
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  test('the two sizes are stored under different names, the small one under the name it always had', () => {
    expect(thumbnailStoragePath('o', 'v')).toBe('o/thumbs/v.jpg.enc');
    expect(thumbnailStoragePath('o', 'v', 'small')).toBe('o/thumbs/v.jpg.enc');
    expect(thumbnailStoragePath('o', 'v', 'large')).toBe('o/thumbs/v.960.jpg.enc');
  });

  test('anything that is not a picture or video gets no preview', async () => {
    mockRecord.mockResolvedValue({ originalFileName: 'a.pdf', originalMimeType: 'application/pdf', encryptedFilePath: 'o/v.enc', dnaRecord: { ownerUserId: 'owner-1' } });
    expect(await getVaultThumbnail(vault, 'v6', 'owner-1', 'large')).toBeNull();
    expect(retrieve).not.toHaveBeenCalled();
  });
});
