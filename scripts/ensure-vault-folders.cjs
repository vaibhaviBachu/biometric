/**
 * My Work folder columns on vault_records.
 * ADDITIVE AND IDEMPOTENT. Safe on every boot. Existing rows stay null and
 * are filed lazily the first time their owner opens My Work.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const log = (...a) => console.log('[ensure-vault-folders]', ...a);

const STMTS = [
  `ALTER TABLE "vault_records" ADD COLUMN IF NOT EXISTS "folder" TEXT`,
  `ALTER TABLE "vault_records" ADD COLUMN IF NOT EXISTS "folderSource" TEXT`,
  `ALTER TABLE "vault_records" ADD COLUMN IF NOT EXISTS "folderReason" TEXT`,
  `ALTER TABLE "vault_records" ADD COLUMN IF NOT EXISTS "folderSuggestion" TEXT`,
  `ALTER TABLE "vault_records" ADD COLUMN IF NOT EXISTS "folderUpdatedAt" TIMESTAMP(3)`,
  `ALTER TABLE "vault_records" ADD COLUMN IF NOT EXISTS "folderConfidence" INTEGER`,
  `ALTER TABLE "vault_records" ADD COLUMN IF NOT EXISTS "folderStatus" TEXT`,
  `CREATE INDEX IF NOT EXISTS "vault_records_folder_idx" ON "vault_records"("folder")`,
];

async function main() {
  let failed = 0;
  for (const sql of STMTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      failed += 1;
      log('skip', err.message);
    }
  }
  log(failed ? `done with ${failed} skipped statement(s)` : 'ok — folder columns ready');
}

main()
  .catch((err) => {
    log('WARNING — could not ensure folder columns:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
