# Phase 2.3 — Complete Index Inventory and Gap Analysis

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44`
Report date: 2026-11-16

---

## 1. Hub Index Inventory — Independently Recalculated

Phase 2.1 reported 234 `@@index` declarations and 20 composite `@@unique` constraints. Recalculated
independently this phase, not copied:

| Metric | Count (this phase, direct count) | Note |
|---|---|---|
| `@@index` declarations | **234** | Matches Phase 2.1 exactly — confirmed `grep -c "^\s*@@index" prisma/schema.prisma` |
| `@@unique` composite constraints | **22** | **Differs from Phase 2.1's reported 20 — explained, not a discrepancy.** Phase 2.2 added exactly 2 (`PlatformEvent` and `Notification` dedupe-key scoping, DB-GAP-12/13), and 20 + 2 = 22 exactly. Independently reconciled. |
| Field-level `@unique` | 84 | Not previously reported; included for completeness |
| `@@id` composite primary keys | 0 | Every model uses a single-column `id` |
| Partial / expression indexes expressible in `schema.prisma` | 0 | Confirmed — Prisma's standard syntax cannot express a `WHERE` predicate or a functional expression on an index; re-confirms Phase 2.1's identical finding |
| Partial indexes found in hand-written migration SQL (invisible to the `@@index` count above) | **1** | `storage_grants_one_trial_per_user` (`WHERE "type" = 'TRIAL'`) — written in `20261026120000_add_storage_grants`, part of the still-unapplied production backlog (DB-GAP-17) |

## 2. Exchange Index Inventory — Independently Catalogued (First Time)

Exchange has no Prisma presence at all, so Phase 2.1's `@@index` count never covered it. This phase reads
`exchange/server/schema/exchange.postgres.sql` directly:

| Metric | Count |
|---|---|
| `CREATE INDEX`/`CREATE UNIQUE INDEX` statements | **24** |
| Partial or expression indexes | 0 (all are plain column or composite-column indexes) |
| Tables with a seller/owner-identity column indexed but — per this phase's finding — **never usable** by that column's main caller (DB-GAP-25) | 3 (`listings.pinit_id`, `payouts.seller_pinit_id`, `seller_payout_accounts.pinit_id`) |
| Tables with a seller/owner-identity column that is filtered this way but has **no index at all** | 1 (`orders_sealed.seller_pinit_id`) |

Full `CREATE INDEX` list (table, columns): `seller_payment_methods` (unique, method composite), `seller_payment_methods(pinit_id, status)`, `seller_onboarding_intents(pinit_id, status)`, `portfolio_profiles(slug)` unique, `listings(asset_id)`, `listings(pinit_id, status)`, `orders_sealed(buyer_pinit_id)`, `orders_sealed(asset_id)`, `cart_items(asset_id)`, `wishlist(asset_id)`, `reviews(asset_id)`, `payment_intents(asset_id)`, `refunds(asset_id)`, `seller_earnings(asset_id)`, `orders_sealed(license_status)`, `hub_bridge_events(status, next_retry_at)`, `hub_assets(pinit_id)`, `cart_items(buyer_key)`, `wishlist(buyer_key)`, `disputes(seal_id)`, `disputes(asset_id)`, `disputes(status)`, `payouts(seller_pinit_id, status)`, `seller_payout_accounts(pinit_id, status)`.

## 3. Redundant, Overlapping, or Unsuitable Indexes

No redundant or overlapping index pair was found on either side. Hub's 234 indexes were spot-checked for
duplicate column sets against the three new additions (§4) — none overlap. Exchange's 24 indexes likewise
show no duplication. **One unsuitable-for-its-purpose case was found** (not redundant, but ineffective):
the three plain indexes named in §2's third row exist, are correctly built, and would work fine for an exact
string match — but the application code that was presumably written to benefit from them never issues that
exact-match query; it always wraps the column in `pinitCodeExpr()` first (DB-GAP-25).

## 4. Foreign-Key Columns Lacking a Useful Index

Re-checked specifically for this report: every Hub foreign-key column that participates in a frequent
equality-filtered query already has a supporting index (confirmed via the query inventory in
`PHASE_2_3_DATABASE_QUERY_PERFORMANCE_DISCOVERY_REPORT.md`). No new FK-without-index gap was found beyond
the three candidates in §5 below, which are not pure FK columns (`ownerUserId`/`externalId`/`status` are
either an unenforced reference or not a reference at all — see Phase 2.2's `PHASE_2_2_RELATIONAL_INTEGRITY_AND_RELATIONSHIP_AUDIT.md`
DB-GAP-20 for the separate, already-tracked "unenforced pseudo-FK" finding, deliberately not re-derived
here).

## 5. Indexes Added This Phase

| Index | Table | Columns | Status |
|---|---|---|---|
| `share_links_ownerUserId_createdAt_idx` | `share_links` | `(ownerUserId, createdAt)` | Implemented and benchmarked on the local dev database (DB-GAP-22) |
| `billing_history_externalId_provider_idx` | `billing_history` | `(externalId, provider)` | Implemented and benchmarked on the local dev database (DB-GAP-23) |
| `dna_records_status_createdAt_idx` | `dna_records` | `(status, createdAt)` | Implemented and benchmarked on the local dev database (DB-GAP-24) |

Full design rationale: `PHASE_2_3_MISSING_AND_COMPOSITE_INDEX_ASSESSMENT.md`. Full benchmark evidence:
`PHASE_2_3_QUERY_PLAN_AND_BENCHMARK_REPORT.md`. None of these three were applied to production or staging.

## 6. Indexes Recommended but Not Implemented This Phase

| Recommendation | Table(s) | Status |
|---|---|---|
| Expression index matching `pinitCodeExpr(seller_pinit_id)` | `exchange.orders_sealed` | Designed, verified via an isolated structural-replica benchmark (not the real Exchange schema). Not applied anywhere. DB-GAP-25. |
| Expression index matching `pinitCodeExpr(pinit_id)` | `exchange.listings` | Same — the existing plain index on this column should either be supplemented with this expression index or reconsidered as dead weight. |
| Expression index matching `pinitCodeExpr(seller_pinit_id)` | `exchange.payouts` | Same reasoning, not independently benchmarked this phase (time-boxed to the one representative case in `orders_sealed`) — flagged for the same fix, pending its own verification pass. |
| Expression index matching `pinitCodeExpr(pinit_id)` | `exchange.seller_payout_accounts` | Same |

## 7. Verdict

Hub's index baseline remains strong (234 indexes, now 237 with this phase's three additions, all
evidence-justified). Exchange's 24-index baseline is **functionally weaker than its count suggests**: at
least 3 of its seller/owner-identity indexes do not serve their apparent purpose due to DB-GAP-25, a finding
this phase surfaces for the first time in this program's history.
