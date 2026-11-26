/**
 * Deleting a vault file must remove every stored preview of it, not only the first size that ever existed.
 *
 * The 960 px preview (public portfolio pages) is stored encrypted next to the 480 px one. Cleanup used to remove only the
 * 480 px object, so the 960 px one stayed in storage after the owner deleted the file.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import os from 'os';
import path from 'path';

// Never let this test touch a real vault folder.
process.env['VAULT_STORAGE_DIR'] = path.join(os.tmpdir(), `pinit-test-vault-${process.pid}`);

const OWNER = 'owner-uuid';
const VAULT_ID = 'vault-uuid';
const DNA_ID = 'dna-uuid';

const vaultRecordRow = {
  id: VAULT_ID,
  dnaRecordId: DNA_ID,
  encryptedFilePath: `local:${VAULT_ID}`,
  originalFileName: 'Ocean.jpg',
  dnaRecord: { id: DNA_ID, ownerUserId: OWNER },
};

const deleteVaultObjects = jest.fn(async (_paths: string[]) => undefined);
const deleteVaultFile = jest.fn(async () => undefined);
const vaultDelete = jest.fn(async (_a?: unknown) => vaultRecordRow as unknown);

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    vaultRecord: { findUnique: jest.fn(async () => vaultRecordRow), delete: vaultDelete, deleteMany: jest.fn(async () => ({ count: 0 })) },
    asset: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })), delete: jest.fn(), deleteMany: jest.fn() },
    shareLink: { updateMany: jest.fn(async () => ({ count: 0 })) },
    dnaRecord: { delete: jest.fn() },
    assetTimelineEvent: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (ops: unknown) => Promise.all(ops as Promise<unknown>[])),
  },
}));
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/vault-storage-backend', () => ({
  uploadVaultFile: jest.fn(),
  downloadVaultFile: jest.fn(),
  deleteVaultFile: (...a: unknown[]) => (deleteVaultFile as unknown as (...x: unknown[]) => Promise<void>)(...a),
  deleteVaultObjects: (paths: string[]) => deleteVaultObjects(paths),
  findVaultFileInCloudStorage: jest.fn(),
  isCloudStorageConfigured: jest.fn(() => true),
  isCloudStorageRestricted: jest.fn(() => false),
}));
jest.mock('../../src/lib/supabase-storage', () => ({
  uploadVaultFile: jest.fn(), downloadVaultFile: jest.fn(), deleteVaultFile: jest.fn(), findVaultFileInSupabase: jest.fn(),
  isSupabaseStorageConfigured: jest.fn(() => false), isSupabaseStorageRestricted: jest.fn(() => false),
}));
jest.mock('../../src/services/vault/encryption.service', () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));
jest.mock('../../src/services/identity/identity-embedding-pipeline.service', () => ({
  identityEmbeddingPipeline: { resolveCertificateId: jest.fn(), process: jest.fn() },
}));
jest.mock('../../src/services/forensics/forensic-provenance.service', () => ({ forensicProvenanceService: { appendAsync: jest.fn() } }));
jest.mock('../../src/services/platform-events/module-events', () => ({ emitVaultStored: jest.fn(), emitVaultDeleted: jest.fn() }));

import { THUMBNAIL_SIZES, thumbnailStoragePath, allThumbnailStoragePaths } from '../../src/services/vault/vault-thumbnail-path';

/** The cleanup runs after the response, so wait for it instead of assuming it has finished. */
async function until(check: () => void, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try { check(); return; } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 15));
    }
  }
}

async function deleteVault(owner = OWNER) {
  const { VaultService } = await import('../../src/services/vault/vault.service');
  return new VaultService().delete(VAULT_ID, owner);
}

beforeEach(() => {
  deleteVaultObjects.mockReset().mockResolvedValue(undefined);
  deleteVaultFile.mockClear();
  vaultDelete.mockClear();
});

describe('stored preview paths', () => {
  test('there is one path per preview size, all different, all under the owner\'s thumbs folder', () => {
    const paths = allThumbnailStoragePaths('o', 'v');
    expect(paths).toHaveLength(THUMBNAIL_SIZES.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(['o/thumbs/v.jpg.enc', 'o/thumbs/v.960.jpg.enc']);
    paths.forEach((p) => expect(p.startsWith('o/thumbs/')).toBe(true));
  });

  test('every size the helper lists is covered, so a new size cannot be forgotten', () => {
    const expected = THUMBNAIL_SIZES.map((size) => thumbnailStoragePath('o', 'v', size));
    expect(allThumbnailStoragePaths('o', 'v')).toEqual(expected);
  });
});

describe('vault delete removes every stored preview', () => {
  test('both the 480 px and the 960 px preview are deleted from storage', async () => {
    await deleteVault();
    await until(() => expect(deleteVaultObjects).toHaveBeenCalled());
    expect(deleteVaultObjects).toHaveBeenCalledTimes(1);
    expect(deleteVaultObjects.mock.calls[0]![0]).toEqual([
      `${OWNER}/thumbs/${VAULT_ID}.jpg.enc`,
      `${OWNER}/thumbs/${VAULT_ID}.960.jpg.enc`,
    ]);
  });

  test('only previews are removed by this call: never the original or another folder', async () => {
    await deleteVault();
    await until(() => expect(deleteVaultObjects).toHaveBeenCalled());
    for (const p of deleteVaultObjects.mock.calls[0]![0]) {
      expect(p).toContain('/thumbs/');
      expect(p.startsWith(`${OWNER}/`)).toBe(true);
      expect(p).not.toBe(`${OWNER}/${VAULT_ID}.enc`);
    }
  });

  test('a storage error while removing previews does not fail the delete', async () => {
    deleteVaultObjects.mockRejectedValue(new Error('storage down'));
    await expect(deleteVault()).resolves.toMatchObject({ vaultId: VAULT_ID });
    expect(vaultDelete).toHaveBeenCalledWith({ where: { id: VAULT_ID } });
    await until(() => expect(deleteVaultObjects).toHaveBeenCalled());
  });

  test('another user cannot delete the file, and no preview is removed', async () => {
    await expect(deleteVault('someone-else')).rejects.toBeInstanceOf(Error);
    expect(vaultDelete).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 60));
    expect(deleteVaultObjects).not.toHaveBeenCalled();
  });
});
