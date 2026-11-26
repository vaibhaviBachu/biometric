/**
 * F5: the owner check must come before any cached preview.
 *
 * The preview caches (finished, in flight, remembered failures) used to be found by file id alone and were read before the owner
 * check, which only runs when a preview has to be made. Anyone who could call the function for a cached file got the owner's
 * preview. Every callers guards access first today, but a future caller must not be able to bypass the check.
 */
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
import { AppError } from '../../src/api/middleware/error.middleware';

const OWNER = 'owner-1';
const INTRUDER = 'someone-else';

let img: Buffer;
const retrieve = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const vault = { retrieve: (...a: unknown[]) => retrieve(...a) } as never;

beforeEach(async () => {
  clearVaultThumbnailMemory();
  retrieve.mockReset();
  mockRecord.mockReset().mockResolvedValue({
    originalFileName: 'sunset.jpg', originalMimeType: 'image/jpeg', encryptedFilePath: 'o/v.enc', dnaRecord: { ownerUserId: OWNER },
  });
  img ??= await sharp({ create: { width: 1200, height: 800, channels: 3, noise: { type: 'gaussian' as const, mean: 128, sigma: 40 } } }).jpeg().toBuffer();
  retrieve.mockResolvedValue({ originalBuffer: img });
});

const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ statusCode: 403 });

describe('the owner check comes before any cached preview', () => {
  test('a finished preview made for the owner is not handed to another user, in either size', async () => {
    await getVaultThumbnail(vault, 'v1', OWNER);
    await getVaultThumbnail(vault, 'v1', OWNER, 'large');
    expect(retrieve).toHaveBeenCalledTimes(2);

    await refused(getVaultThumbnail(vault, 'v1', INTRUDER));
    await refused(getVaultThumbnail(vault, 'v1', INTRUDER, 'large'));
    expect(retrieve).toHaveBeenCalledTimes(2); // the intruder was refused before anything was read
  });

  test('a preview that is still being made for the owner is not shared with another user either', async () => {
    let release!: () => void;
    retrieve.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ originalBuffer: img }); }));
    const owners = getVaultThumbnail(vault, 'v2', OWNER);
    const intruder = getVaultThumbnail(vault, 'v2', INTRUDER);
    // Release the owner's job on its own schedule, so that if the intruder wrongly shares it the test fails at once instead of hanging.
    const releaseSoon = (async () => { while (!release) await new Promise((r) => setTimeout(r, 5)); await new Promise((r) => setTimeout(r, 30)); release(); })();
    await refused(intruder);
    await releaseSoon;
    expect(await owners).toBeInstanceOf(Buffer);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  test('a remembered "file missing" answer is not revealed to another user: they get "access denied", not the owner\'s error', async () => {
    retrieve.mockRejectedValue(new Error('This protected file is not in cloud storage. Protect the file again.'));
    await expect(getVaultThumbnail(vault, 'v3', OWNER)).rejects.toThrow(/not in cloud storage/);
    await refused(getVaultThumbnail(vault, 'v3', INTRUDER));
    await expect(getVaultThumbnail(vault, 'v3', INTRUDER)).rejects.not.toThrow(/not in cloud storage/);
  });

  test('the check is the real one: the refusal comes from the owner assertion, with a database lookup for the other user', async () => {
    await getVaultThumbnail(vault, 'v4', OWNER);
    const before = mockRecord.mock.calls.length;
    await refused(getVaultThumbnail(vault, 'v4', INTRUDER));
    expect(mockRecord.mock.calls.length).toBe(before + 1);
  });

  test('a refusal is not remembered: the owner is still served normally afterwards', async () => {
    await refused(getVaultThumbnail(vault, 'v5', INTRUDER));
    const thumb = await getVaultThumbnail(vault, 'v5', OWNER);
    expect(thumb).toBeInstanceOf(Buffer);
  });

  test('the owner still gets a cached preview without another database lookup', async () => {
    await getVaultThumbnail(vault, 'v6', OWNER);
    const lookups = mockRecord.mock.calls.length;
    await getVaultThumbnail(vault, 'v6', OWNER);
    await getVaultThumbnail(vault, 'v6', OWNER);
    expect(mockRecord.mock.calls.length).toBe(lookups);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
});

describe('forgetting a file', () => {
  test('clears every size and every user for that file, and nothing else', async () => {
    await getVaultThumbnail(vault, 'v7', OWNER);
    await getVaultThumbnail(vault, 'v7', OWNER, 'large');
    await getVaultThumbnail(vault, 'v70', OWNER); // a different file whose id starts the same way
    expect(retrieve).toHaveBeenCalledTimes(3);

    forgetVaultThumbnail('v7');
    await getVaultThumbnail(vault, 'v7', OWNER);
    await getVaultThumbnail(vault, 'v7', OWNER, 'large');
    expect(retrieve).toHaveBeenCalledTimes(5); // both sizes of v7 had to be made again
    await getVaultThumbnail(vault, 'v70', OWNER);
    expect(retrieve).toHaveBeenCalledTimes(5); // v70 was untouched
  });

  test('a deleted file is not served from memory afterwards', async () => {
    await getVaultThumbnail(vault, 'v8', OWNER);
    forgetVaultThumbnail('v8');
    mockRecord.mockResolvedValue(null); // the record is gone
    await expect(getVaultThumbnail(vault, 'v8', OWNER)).rejects.toThrow(/not found/i);
  });

  test('a refused owner check is an AppError 403, like every other access denial', async () => {
    await getVaultThumbnail(vault, 'v9', OWNER);
    const err = await getVaultThumbnail(vault, 'v9', INTRUDER).catch((e) => e as AppError);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
  });
});
