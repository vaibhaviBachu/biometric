# Phase 2.3 — Database Query Performance Discovery Report

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report — all code changes in this phase are local, uncommitted working-tree edits)
Report date: 2026-11-16

---

## 0. Methodology and Scope

This phase independently re-investigates Hub and Exchange's actual query patterns rather than relying on
Phase 2.1's summaries. Every finding below is grounded in a file:line citation, and every claimed performance
effect is either **measured** (real `EXPLAIN (ANALYZE, BUFFERS)` output, stated as such) or explicitly labeled
a **source-level risk pattern** (shape observed in code, not measured) — never presented ambiguously.

Benchmarking used the project's existing local per-developer Docker Postgres
(`docker-compose.dev.yml`, `pinit-hub-dev-db`) for Hub, and an isolated, throwaway schema on that same local
database (structurally replicating only the relevant columns of `exchange.orders_sealed`, never the real
`exchange` schema) for Exchange — no production or staging database was queried, profiled, or modified at
any point in this phase.

## 1. Query Inventory by Domain

### Authentication / Users
Carried forward from Phase 2.1 (Report 4 §1) — no new issue found; re-confirmed `src/lib/db-retry.ts`'s
read-only, narrowly-scoped retry logic is unchanged.

### Vault / Assets
`src/api/controllers/vault.controller.ts:92`, `src/services/vault/vault-folder.service.ts`,
`src/services/assets/asset.service.ts` — source-level risk patterns already identified in Phase 2.1,
re-confirmed present and unchanged this phase. No new evidence gathered beyond the original inventory.

### Forensics / DNA — **DB-GAP-09, re-confirmed**
`src/services/forensics/local-dna-index.service.ts:247-253` (`backfillOwner`) still contains the exact
pattern Phase 2.1 identified: an unbounded `vaultRecord.findMany({ where: { dnaRecord: { ownerUserId } } })`
with no `take`, followed by a per-row `localFeatureIndex.findUnique` plus a file-retrieval call inside the
loop. Re-read directly this phase, confirmed unchanged line-for-line in shape. See
`PHASE_2_3_FINAL_DATABASE_PERFORMANCE_FINDINGS_REGISTER.md` for this phase's disposition.

### Billing / Payments — **new evidence this phase (DB-GAP-23)**
`src/services/subscription/billing/razorpay.service.ts:561,678` and
`src/services/subscription/billing/stripe.service.ts:275,395` — every webhook idempotency check queries
`billingHistory.findFirst({ where: { externalId, provider } })`, always both columns together. No existing
index covers this combination (only `subscriptionId` and `provider` alone are indexed).

### Sharing / Access Control — **new evidence this phase (DB-GAP-22)**
`src/services/home/home-pulse.service.ts:70-73` (owner-facing "Right now" dashboard) and
`src/api/controllers/profile.controller.ts:362-365` (Profile's recent-shares list) both run
`shareLink.findMany({ where: { ownerUserId }, orderBy: { createdAt: 'desc' } })`. `src/lib/tenant-scope.ts:88-91,200,216-219`
run the same equality filter for authorization checks. `src/services/intelligence/ask-pinit.service.ts:1036`
adds a `createdAt: { gte }` range on top of the same equality filter. No index covers `ownerUserId` at all
today (confirmed: `ShareLink` has 9 indexes, none on `ownerUserId`, re-verified directly against
`prisma/schema.prisma`).

Also found: `src/api/controllers/evidence-report.controller.ts:146,184,216` run an **unbounded**
`shareLink.findMany({ where: { ownerUserId }, select: { id: true } })` — no `take` at all. Lower severity
than the dashboard queries (id-only projection, used to build an `IN` filter) but a genuine unbounded-query
instance, consistent with Phase 2.1's Stage-3A pattern category.

### Exchange Marketplace — **standout new finding this phase (DB-GAP-25)**
Full detail in `PHASE_2_3_MISSING_AND_COMPOSITE_INDEX_ASSESSMENT.md` §3 and
`PHASE_2_3_QUERY_PLAN_AND_BENCHMARK_REPORT.md`. Summary: Exchange's `sellerMatchClause`/`pinitCodeExpr`
helper (`exchange/server/lib/pinit-identity.js:60-81`) wraps the filtered column in a 4-level nested
`REPLACE(REPLACE(REPLACE(REPLACE(UPPER(column),...` expression before comparing it — used at **33 call sites
across 11 files**. This defeats plain B-tree indexes on the wrapped column entirely: Postgres cannot use an
index on the raw column for a predicate that transforms the column first. Confirmed by direct code read that
this affects `orders_sealed.seller_pinit_id` (no index exists at all) **and** `listings.pinit_id` /
`payouts.seller_pinit_id` / `seller_payout_accounts.pinit_id` (indexes **do** exist on these exact columns,
but are silently never usable by the seller-dashboard queries that are their main reason to exist).

### Admin / Super-Admin — **new evidence this phase (DB-GAP-24)**
`src/api/controllers/super-admin/assets.ts:111-124` (`listAllDna`) runs
`dnaRecord.findMany({ where: status ? { status } : undefined, orderBy: { createdAt: 'desc' }, take: 500 })`.
No existing index covers `status`+`createdAt` together (`DnaRecord` has 5 indexes, none on either column).
Admin-only traffic — lower priority than the Hub/Exchange findings above, stated explicitly in this phase's
severity assessment.

### Background Jobs / Scheduler
`src/services/scheduler/vault-scheduler.service.ts:120,254-264,~312` — re-confirmed present and unchanged;
no new evidence gathered beyond Phase 2.1's original source-level observations.

## 2. What Was Re-Confirmed vs. What Is New

| Carried forward from Phase 2.1, re-confirmed unchanged | New this phase |
|---|---|
| DB-GAP-09 (local-dna-index N+1) | DB-GAP-22 (ShareLink.ownerUserId, implemented+tested) |
| The three originally-flagged "statically plausible" indexes (re-evaluated in full, see `PHASE_2_3_MISSING_AND_COMPOSITE_INDEX_ASSESSMENT.md`) | DB-GAP-23 (BillingHistory.externalId+provider, implemented+tested) |
| Vault/scheduler source-level patterns | DB-GAP-24 (DnaRecord.status+createdAt, implemented+tested, admin-only) |
| No `statement_timeout` anywhere (`APIREL-L06`/`L10`) | DB-GAP-25 (Exchange's systemic function-wrapped-column anti-pattern — the standout finding of this phase) |
| | Unbounded `shareLink.findMany` in `evidence-report.controller.ts` (new unbounded-query instance) |

## 3. Verdict

Query-pattern discovery this phase both **independently re-confirmed** Phase 2.1's carried-forward findings
(none were found to be stale or incorrect) and **surfaced one systemic, previously-undocumented defect**
(DB-GAP-25) whose scope — four tables, 33 call sites, two of which already carry a now-proven-unusable index
— exceeds in measured impact every individual finding in Phase 2.1's own inventory. Full before/after
evidence for every implemented or recommended change is in
`PHASE_2_3_QUERY_PLAN_AND_BENCHMARK_REPORT.md`.
