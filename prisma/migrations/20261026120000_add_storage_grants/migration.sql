-- Phase 1B — storage entitlement ledger, additive only.
-- NOT applied to any database by this change — written for review and for
-- `npx prisma migrate deploy` to be run explicitly against the intended
-- target environment. Does not touch, rename or drop any existing table,
-- column, or constraint.

-- CreateEnum
-- Schema-qualified existence check (not just typname) so this cannot be
-- skipped by a same-named type in another schema on the same database —
-- Exchange lives in its own "exchange" schema on this same shared Supabase
-- project (see .env.example), so this guards against that specifically,
-- however unlikely a name collision is in practice.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'StorageGrantType' AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "StorageGrantType" AS ENUM ('TRIAL', 'PURCHASED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "storage_grants" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "type" "StorageGrantType" NOT NULL,
    "bytesGranted" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "billingHistoryId" TEXT,

    CONSTRAINT "storage_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "storage_grants_billingHistoryId_key" ON "storage_grants"("billingHistoryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "storage_grants_userId_idx" ON "storage_grants"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "storage_grants_userId_type_idx" ON "storage_grants"("userId", "type");

-- Partial unique index: at most one TRIAL grant per user, ever — DB-enforced,
-- not just the application's check-then-create in ensureTrialGrant(). Not
-- expressible as a plain Prisma @@unique([userId, type]) because PURCHASED
-- grants must be allowed to repeat per user (additional purchases).
CREATE UNIQUE INDEX IF NOT EXISTS "storage_grants_one_trial_per_user"
    ON "storage_grants"("userId")
    WHERE "type" = 'TRIAL';

-- AddForeignKey
-- Scoped to conrelid (constraints actually attached to storage_grants),
-- not a bare name match against pg_constraint — correct regardless of
-- schema/search_path, and the semantically right question to ask anyway
-- ("does THIS table already have this constraint").
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'storage_grants_userId_fkey'
      AND conrelid = '"storage_grants"'::regclass
  ) THEN
    ALTER TABLE "storage_grants"
      ADD CONSTRAINT "storage_grants_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
-- ON DELETE SET NULL, deliberately not CASCADE: a BillingHistory row being
-- removed (nothing in the app does this today) must never take a user's
-- permanent, already-granted storage down with it — only the audit link is
-- lost, never the entitlement itself.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'storage_grants_billingHistoryId_fkey'
      AND conrelid = '"storage_grants"'::regclass
  ) THEN
    ALTER TABLE "storage_grants"
      ADD CONSTRAINT "storage_grants_billingHistoryId_fkey"
      FOREIGN KEY ("billingHistoryId") REFERENCES "billing_history"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
