/**
 * Creates the resumable-upload tables (upload_sessions, upload_session_parts).
 * Additive and idempotent. Part of db:ensure-all: the sessions are mounted at /api/v1/uploads/sessions and feed the
 * large-file protect and investigate jobs (docs/LARGE_FILE_STREAMING_PROTECTION.md).
 *
 * Run only against a database you mean to change:
 *   DATABASE_URL=postgresql://... node scripts/ensure-upload-sessions.cjs
 */
const SQL = [
  `CREATE TABLE IF NOT EXISTS "upload_sessions" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "declaredSizeBytes" BIGINT NOT NULL,
    "chunkSizeBytes" INTEGER NOT NULL,
    "totalParts" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "finalSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "upload_sessions_owner_idem_key"
     ON "upload_sessions"("ownerUserId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "upload_sessions_owner_status_idx" ON "upload_sessions"("ownerUserId", "status")`,
  `CREATE INDEX IF NOT EXISTS "upload_sessions_status_expires_idx" ON "upload_sessions"("status", "expiresAt")`,
  `CREATE TABLE IF NOT EXISTS "upload_session_parts" (
    "sessionId" TEXT NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "upload_session_parts_pkey" PRIMARY KEY ("sessionId", "partIndex")
  )`,
];

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    for (const sql of SQL) await prisma.$executeRawUnsafe(sql);
    console.log('[ensure-upload-sessions] ok');
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { SQL };

if (require.main === module) {
  main().catch((err) => {
    console.error('[ensure-upload-sessions] failed', err);
    process.exit(1);
  });
}
