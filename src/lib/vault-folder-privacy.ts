/**
 * Who may see a vaulted file, based on its My Work filing.
 *
 * Two different questions:
 *   - ownerLocked: does the owner need a face check to open it in My Work?
 *     (private folder, or To sort with a private best guess)
 *   - exposurePrivate: must it stay off public Scan, Exchange and public
 *     portfolio pages? Everything ownerLocked, plus files still being read
 *     (a freshly pinned Aadhaar must not be public for even a minute).
 */
import { PRIVATE_VAULT_FOLDERS, isPrivateVaultFolder } from './vault-folder-classifier';

export interface FolderPlacement {
  folder?: string | null;
  folderStatus?: string | null;
  folderSuggestion?: string | null;
}

export function isOwnerLocked(p: FolderPlacement): boolean {
  if (isPrivateVaultFolder(p.folder)) return true;
  return p.folder === 'tosort' && isPrivateVaultFolder(p.folderSuggestion);
}

export function isExposurePrivate(p: FolderPlacement): boolean {
  return isOwnerLocked(p) || p.folderStatus === 'pending';
}

/**
 * Prisma filter that keeps only files allowed in public places. Nulls are
 * spelled out: SQL `NOT IN` / `<>` drop NULL rows, and files that were never
 * filed (folder null) must stay listable.
 */
export function notExposurePrivateWhere() {
  const privateFolders = [...PRIVATE_VAULT_FOLDERS];
  return {
    AND: [
      { OR: [{ folder: null }, { folder: { notIn: privateFolders } }] },
      { OR: [{ folderStatus: null }, { folderStatus: { not: 'pending' } }] },
      {
        OR: [
          { folder: null },
          { folder: { not: 'tosort' } },
          { folderSuggestion: null },
          { folderSuggestion: { notIn: privateFolders } },
        ],
      },
    ],
  };
}
