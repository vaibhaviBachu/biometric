/**
 * PINIT-DNA — Phase 9: DB/Storage reconciliation (REL7-06 / Workstream 13).
 *
 * Pure diff logic, deliberately separated from any I/O (Prisma query,
 * Supabase Storage `.list()` call) so it is testable with plain fixtures and
 * carries no ability to touch a database or bucket itself. The orchestration
 * script (scripts/recovery/reconcile-vault-storage.cjs) is what actually
 * reads data and calls this function; this file never does.
 */

export interface VaultDbReference {
  vaultRecordId: string;
  storagePath: string;
}

export interface ReconciliationResult {
  /** DB record references a storage path that does not appear in the bucket listing. */
  missingObjects: VaultDbReference[];
  /** Storage object exists but no DB record references its path. */
  orphanedObjectKeys: string[];
  /** More than one DB record references the exact same storage path. */
  duplicateReferences: Array<{ storagePath: string; vaultRecordIds: string[] }>;
  /** Paths referenced by exactly one DB record and present in storage. */
  matchedCount: number;
  totalDbReferences: number;
  totalStorageObjects: number;
}

export function reconcileVaultStorage(
  dbReferences: VaultDbReference[],
  storageObjectKeys: string[],
): ReconciliationResult {
  const storageKeySet = new Set(storageObjectKeys);

  const byPath = new Map<string, string[]>();
  for (const ref of dbReferences) {
    const list = byPath.get(ref.storagePath) ?? [];
    list.push(ref.vaultRecordId);
    byPath.set(ref.storagePath, list);
  }

  const missingObjects: VaultDbReference[] = [];
  const duplicateReferences: Array<{ storagePath: string; vaultRecordIds: string[] }> = [];
  let matchedCount = 0;

  for (const [storagePath, vaultRecordIds] of byPath) {
    const existsInStorage = storageKeySet.has(storagePath);
    if (!existsInStorage) {
      for (const vaultRecordId of vaultRecordIds) {
        missingObjects.push({ vaultRecordId, storagePath });
      }
    } else {
      matchedCount += 1;
    }
    if (vaultRecordIds.length > 1) {
      duplicateReferences.push({ storagePath, vaultRecordIds });
    }
  }

  const referencedPaths = new Set(byPath.keys());
  const orphanedObjectKeys = storageObjectKeys.filter((key) => !referencedPaths.has(key));

  return {
    missingObjects,
    orphanedObjectKeys,
    duplicateReferences,
    matchedCount,
    totalDbReferences: dbReferences.length,
    totalStorageObjects: storageObjectKeys.length,
  };
}
