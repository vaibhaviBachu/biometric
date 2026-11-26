/**
 * Background Trace: one row per investigation, so its status and result survive navigation, refresh, logout and restarts.
 *
 *   trace_investigations — QUEUED / PROCESSING / COMPLETED / FAILED / INCONCLUSIVE, the real stages it went through,
 *                          the saved result, the evidence code, and the reason when it did not finish.
 *
 * ADDITIVE AND IDEMPOTENT. Nothing existing is altered. Safe on every deploy.
 * Run only against a database you mean to change (the local .env points at production):
 *   DATABASE_URL=postgresql://pinit:pinit@localhost:5435/pinit_hub node scripts/ensure-trace-investigations.cjs
 *
 * Why the two unique indexes:
 *   (ownerUserId, clientRequestId)  one click is one investigation, even if the request is retried.
 *   (ownerUserId, probeSha256) WHERE status IN ('QUEUED','PROCESSING')
 *                                   the same file cannot be started twice while one is still running. The database enforces it, so two
 *                                   simultaneous requests cannot both get in.
 *
 * Roll back (only if nothing needs the history):  DROP TABLE IF EXISTS trace_investigations;
 */
const SQL = [
  `CREATE TABLE IF NOT EXISTS "trace_investigations" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "probeSha256" CHAR(64) NOT NULL,
    "probePath" TEXT,
    "discovery" JSONB,
    "stage" TEXT,
    "stageLabel" TEXT,
    "stages" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "reportInvestigationId" TEXT,
    "evidenceCode" TEXT,
    "evidenceStatus" TEXT,
    "outcome" JSONB,
    "resultSnapshot" JSONB,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "instanceId" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seenAt" TIMESTAMP(3),
    CONSTRAINT "trace_investigations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trace_investigations_status_check"
      CHECK ("status" IN ('QUEUED','PROCESSING','COMPLETED','FAILED','INCONCLUSIVE'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "trace_investigations_owner_request_key"
     ON "trace_investigations"("ownerUserId", "clientRequestId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "trace_investigations_owner_running_file_key"
     ON "trace_investigations"("ownerUserId", "probeSha256") WHERE "status" IN ('QUEUED','PROCESSING')`,
  `CREATE INDEX IF NOT EXISTS "trace_investigations_owner_created_idx" ON "trace_investigations"("ownerUserId", "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS "trace_investigations_status_created_idx" ON "trace_investigations"("status", "createdAt")`,
];

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    for (const sql of SQL) await prisma.$executeRawUnsafe(sql);
    console.log('[ensure-trace-investigations] ok');
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { SQL };

if (require.main === module) {
  main().catch((err) => {
    console.error('[ensure-trace-investigations] failed:', err.message);
    process.exit(1);
  });
}
