/**
 * PINIT-DNA — Phase 9: DB/Storage reconciliation CLI (REL7-06 / Workstream 13).
 *
 * Read-only. Lists every VaultRecord's storage reference from the database
 * and every actual object key in the configured storage bucket, then reports
 * missing objects (DB references an object that isn't there), orphaned
 * objects (object exists, nothing references it), and duplicate references —
 * via the pure src/lib/recovery/reconciliation.ts diff, which this script
 * only feeds real data into.
 *
 * SAFETY: this script's default DATABASE_URL/SUPABASE_URL point at this
 * project's real hosted Supabase instance (confirmed this phase — the same
 * trap scripts/audit-rls-readonly.cjs already warns about). Per the Phase 9
 * master prompt's explicit instruction ("No production scanning unless
 * separately approved"), this script REFUSES to run against a
 * production-classified target unless --confirm-production-scan is passed
 * explicitly. It performs no writes regardless — there is no delete/repair
 * flag in this script at all; that would be a separate, explicitly
 * authorized tool.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/recovery/reconcile-vault-storage.ts [--out=<path>] [--confirm-production-scan]
 */
import { prisma } from '../../src/lib/prisma';
import { listAllVaultObjectKeys } from '../../src/lib/vault-storage-backend';
import { reconcileVaultStorage, VaultDbReference } from '../../src/lib/recovery/reconciliation';
import { classifyRestoreTarget, ProductionTargetRejectedError } from '../../src/lib/recovery/restore-safety';
import * as fs from 'fs';
import * as path from 'path';

const PAGE_SIZE = 1000;

async function listAllDbReferences(): Promise<VaultDbReference[]> {
  const refs: VaultDbReference[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.vaultRecord.findMany({
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, encryptedFilePath: true },
    });
    if (page.length === 0) break;
    for (const row of page) {
      refs.push({ vaultRecordId: row.id, storagePath: row.encryptedFilePath });
    }
    cursor = page[page.length - 1]!.id;
    if (page.length < PAGE_SIZE) break;
  }
  return refs;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirmProductionScan = args.includes('--confirm-production-scan');
  const outArg = args.find((a) => a.startsWith('--out='));
  const outPath = outArg ? outArg.slice('--out='.length) : path.join(__dirname, '..', 'backups', `reconciliation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  const dbUrl = process.env['DATABASE_URL'] ?? '';
  const storageUrl = process.env['SUPABASE_URL'] ?? process.env['S3_BUCKET'] ?? '';

  const dbClass = classifyRestoreTarget(dbUrl);
  const storageClass = classifyRestoreTarget(storageUrl);
  const anyProductionLike = dbClass.classification === 'production-like' || storageClass.classification === 'production-like';

  console.log('[reconcile-vault-storage] Database target:', dbClass.classification, `(${dbClass.host})`);
  console.log('[reconcile-vault-storage] Storage target:', storageClass.classification, `(${storageClass.host})`);

  if (anyProductionLike && !confirmProductionScan) {
    throw new ProductionTargetRejectedError(
      'Refusing to scan: DATABASE_URL and/or SUPABASE_URL classify as production-like, and --confirm-production-scan was not passed. ' +
      'This tool is read-only (it has no delete/repair capability), but Phase 9 requires explicit separate approval before any production scan. ' +
      'Re-run against a local/disposable target, or pass --confirm-production-scan only once that approval has actually been given.',
    );
  }

  console.log('[reconcile-vault-storage] Fetching DB references (paginated)...');
  const dbReferences = await listAllDbReferences();
  console.log(`[reconcile-vault-storage] ${dbReferences.length} VaultRecord references found.`);

  console.log('[reconcile-vault-storage] Listing storage objects (paginated)...');
  const storageKeys = await listAllVaultObjectKeys();
  console.log(`[reconcile-vault-storage] ${storageKeys.length} storage objects found.`);

  const result = reconcileVaultStorage(dbReferences, storageKeys);

  const report = {
    generatedAt: new Date().toISOString(),
    target: { database: dbClass, storage: storageClass, productionScanConfirmed: confirmProductionScan },
    summary: {
      totalDbReferences: result.totalDbReferences,
      totalStorageObjects: result.totalStorageObjects,
      matchedCount: result.matchedCount,
      missingObjectCount: result.missingObjects.length,
      orphanedObjectCount: result.orphanedObjectKeys.length,
      duplicateReferenceCount: result.duplicateReferences.length,
    },
    missingObjects: result.missingObjects,
    orphanedObjectKeys: result.orphanedObjectKeys,
    duplicateReferences: result.duplicateReferences,
    note: 'Read-only report. No object or database record was created, modified, or deleted by this run.',
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('[reconcile-vault-storage] Report written to', outPath);
  console.log(JSON.stringify(report.summary, null, 2));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error('[reconcile-vault-storage] FAILED —', err instanceof Error ? err.message : String(err));
    await prisma.$disconnect();
    process.exit(1);
  });
