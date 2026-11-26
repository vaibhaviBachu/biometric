# Phase 2.5 — Database Index and Storage Growth Report

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization (final sub-phase)**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. Index Inventory — Reconfirmed Unchanged From Phase 2.3

Hub: 234 `@@index` + 22 `@@unique` (unchanged — this phase added no new Hub indexes beyond Phase 2.3's three,
re-verified present in `prisma/schema.prisma` and on the local dev database). Exchange: 24 manually-managed
indexes (unchanged). No redundant or duplicate index pair was found in either schema, re-confirmed by the
same check Phase 2.3 performed.

## 2. DB-GAP-22/23/24 — Revalidated, Not Duplicated

All three Hub indexes (`share_links_ownerUserId_createdAt_idx`, `billing_history_externalId_provider_idx`,
`dna_records_status_createdAt_idx`) were re-confirmed present in both `prisma/schema.prisma` and the local
dev database's live `pg_indexes` catalog this phase (exact query and result in
`PHASE_2_5_IMPLEMENTATION_AND_REGRESSION_TEST_REPORT.md`). No new migration was created for them — the
existing Phase 2.3 migration (`20261116120930_phase_2_3_query_performance_indexes`) remains the single
source of truth; this phase did not duplicate it.

**Production status, reassessed:** none of the three have been applied to production — re-confirmed this
phase via the same read-only `_prisma_migrations` check used in Phase 2.3/2.4
(`PHASE_2_5_DATA_RETENTION_ARCHIVAL_AND_PARTITIONING_STRATEGY.md` is not the right place for this; see
`PHASE_2_5_FINAL_DATABASE_FINDINGS_REGISTER_AND_PHASE_COMPLETION_REPORT.md` for the consolidated migration
backlog, which now includes this migration alongside the original five from DB-GAP-17).

## 3. DB-GAP-25 — Revalidated, Scope Corrected

See `PHASE_2_5_DATABASE_QUERY_AND_LARGE_TABLE_SCALABILITY_REPORT.md` §3 for the full, corrected enumeration:
this phase found the expression-wrapped-column pattern applies to more columns (`pinit_id`, `seller_pinit_id`,
`buyer_pinit_id`, `awarded_to_pinit_id` across `listings`, `users`, `hub_assets`, `orders_sealed`, `payouts`,
`requirements`) than Phase 2.3's original 4-table scope — and two call sites in `commerce.js` hand-inline the
expression rather than calling the shared `pinitCodeExpr()` helper (textually identical, not a logic
divergence, but worth normalizing for maintainability whenever this is implemented). Status unchanged:
Design Complete, verified twice on an isolated replica, not applied anywhere real.

## 4. New This Phase — Index Bloat on Near-Empty Tables (DB-GAP-32)

Full detail: `PHASE_2_5_DATABASE_SCALABILITY_AND_CAPACITY_ASSESSMENT.md` §4. Summary: `local_dna_patches`
(0 rows, 51 MB of index), `monitoring_runs` (14 rows, 6.3 MB), `crawl_results` (0 rows, 2.9 MB), `crawler_jobs`
(0 rows, 2.8 MB) — **≈63 MB of index space, ≈10% of the entire 617 MB database, on tables holding almost no
data.** This is classic unreclaimed bloat from past insert/delete churn, confirmed by `pg_stat_user_tables`
showing no recorded `last_vacuum` on at least one of these tables.

**Not classified as "unused indexes to drop"** — per this phase's own instruction not to assume an index is
unused merely from a low usage counter without accounting for the observation period, and because these
tables genuinely have workload-justified indexes (e.g. `idx_bridge_events_status` equivalents for job-queue
tables) that are simply bloated, not unnecessary. The correct remediation is `REINDEX`/`VACUUM`, not index
removal — a production action requiring authorization, not performed by this phase.

## 5. Write Overhead From This Phase's Own Index Additions

Phase 2.3's three indexes and this phase adds none further. No new write-overhead concern was introduced this
phase.

## 6. Storage Growth — Reframed by DB-GAP-33 (TOAST, Not Row Count)

Re-stating from the capacity report because it directly bears on every "should we add more indexes" decision
for future phases: `spatial_auth_packages` and `dna_records` together hold 396 MB of this database's 617 MB
total, overwhelmingly in TOAST storage for large blob/JSON columns, with trivially small table-heap and index
sizes (184 kB + 88 kB, and 680 kB + 208 kB respectively). **Any future index added to either of these two
tables will have a storage footprint driven by row count, not by the dominant TOAST growth** — the two
scale independently, and this phase found no indication that either table's current indexing is inadequate
for its own (small) row count.

## 7. Verdict

No new index was added this phase (the three from Phase 2.3 remain the complete, evidence-backed set for
Hub). No redundant or duplicate index exists in either schema. One new, quantified storage finding (index
bloat, DB-GAP-32) and one corrected-scope finding (the expression-index gap, DB-GAP-25) are recorded for a
future, explicitly-authorized implementation pass.
