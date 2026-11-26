/**
 * Large-file protection tables (docs/LARGE_FILE_STREAMING_PROTECTION.md):
 *   large_file_manifests — whole-file SHA-256, Merkle root, true BIGINT size, sampling plan, storage segments
 *   large_file_chunks    — SHA-256 of every fixed-size chunk, indexed for fragment lookups
 *   large_file_jobs      — background protect / investigate jobs for large uploads
 *
 * ADDITIVE AND IDEMPOTENT. Safe on every deploy. Run only against a database you mean to change:
 *   DATABASE_URL=postgresql://... node scripts/ensure-large-file-tables.cjs
 */
const SQL = [
  `CREATE TABLE IF NOT EXISTS "large_file_manifests" (
    "id" TEXT NOT NULL,
    "dnaRecordId" TEXT NOT NULL,
    "vaultId" TEXT,
    "ownerUserId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "chunkSizeBytes" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "merkleRoot" CHAR(64) NOT NULL,
    "analysisMode" TEXT NOT NULL,
    "sampling" JSONB,
    "storage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "large_file_manifests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "large_file_manifests_dnaRecordId_fkey" FOREIGN KEY ("dnaRecordId")
      REFERENCES "dna_records"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "large_file_manifests_dnaRecordId_key" ON "large_file_manifests"("dnaRecordId")`,
  `CREATE INDEX IF NOT EXISTS "large_file_manifests_ownerUserId_idx" ON "large_file_manifests"("ownerUserId")`,
  `CREATE INDEX IF NOT EXISTS "large_file_manifests_sha256_idx" ON "large_file_manifests"("sha256")`,
  `CREATE INDEX IF NOT EXISTS "large_file_manifests_vaultId_idx" ON "large_file_manifests"("vaultId")`,
  `CREATE TABLE IF NOT EXISTS "large_file_chunks" (
    "manifestId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    CONSTRAINT "large_file_chunks_pkey" PRIMARY KEY ("manifestId", "chunkIndex"),
    CONSTRAINT "large_file_chunks_manifestId_fkey" FOREIGN KEY ("manifestId")
      REFERENCES "large_file_manifests"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "large_file_chunks_sha256_idx" ON "large_file_chunks"("sha256")`,
  `CREATE TABLE IF NOT EXISTS "large_file_jobs" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "uploadSessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stage" TEXT,
    "progress" DOUBLE PRECISION,
    "input" JSONB,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "large_file_jobs_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "large_file_jobs_owner_created_idx" ON "large_file_jobs"("ownerUserId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "large_file_jobs_status_idx" ON "large_file_jobs"("status")`,
];

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    for (const sql of SQL) await prisma.$executeRawUnsafe(sql);
    console.log('[ensure-large-file-tables] ok');
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { SQL };

if (require.main === module) {
  main().catch((err) => {
    console.error('[ensure-large-file-tables] failed', err);
    process.exit(1);
  });
}
