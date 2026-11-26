-- Phase 2.3 (DB-GAP-22/23/24) — three evidence-backed query-performance indexes.
--
-- Each is justified by an actual query pattern found in source (not added
-- speculatively) and each was independently measured on a local, synthetic
-- benchmark before being written here — see
-- SYSTEM_DESIGN/DATABASE_ARCHITECTURE/PHASE_2_3/PHASE_2_3_QUERY_PLAN_AND_BENCHMARK_REPORT.md
-- for the full EXPLAIN (ANALYZE, BUFFERS) output this migration is based on.
--
-- NOT APPLIED TO PRODUCTION BY THIS CHANGE. Applied and benchmarked only
-- against the local per-developer Docker Postgres (docker-compose.dev.yml).
--
-- Locking note: written as plain CREATE INDEX (not CONCURRENTLY) because at
-- today's measured/estimated table sizes (tens of thousands of rows) a brief
-- exclusive lock during index build is not a practical concern — confirmed
-- by this phase's own benchmark, where building each of these three indexes
-- on 20-45k rows took well under a second. If any of these three tables
-- grows large enough that a blocking index build becomes noticeable before
-- this migration is deployed, rebuild it instead with CREATE INDEX
-- CONCURRENTLY, run as a standalone statement outside this migration's
-- transaction (PostgreSQL refuses CONCURRENTLY inside a transaction block,
-- and Prisma's `migrate deploy` wraps each migration file in one).

-- DB-GAP-22: ShareLink(ownerUserId, createdAt) — owner-facing share dashboard
-- (home-pulse.service.ts) and Profile's recent-shares list both filter by
-- ownerUserId and sort by createdAt DESC. Measured: 97.3ms seq scan on 45k
-- rows -> 1.0ms index scan.
CREATE INDEX IF NOT EXISTS "share_links_ownerUserId_createdAt_idx" ON "share_links"("ownerUserId", "createdAt");

-- DB-GAP-23: BillingHistory(externalId, provider) — every Stripe/Razorpay
-- webhook idempotency check filters by both columns together. Measured:
-- 15.7ms bitmap-heap-scan (via the low-selectivity provider index alone) on
-- 30k rows -> 0.15ms index scan.
CREATE INDEX IF NOT EXISTS "billing_history_externalId_provider_idx" ON "billing_history"("externalId", "provider");

-- DB-GAP-24: DnaRecord(status, createdAt) — super-admin's listAllDna
-- (optional status filter, createdAt DESC, take 500). Admin-only traffic,
-- not a high-traffic user path. Measured: 12.7ms seq scan on 25k rows ->
-- 0.6ms index scan.
CREATE INDEX IF NOT EXISTS "dna_records_status_createdAt_idx" ON "dna_records"("status", "createdAt");
