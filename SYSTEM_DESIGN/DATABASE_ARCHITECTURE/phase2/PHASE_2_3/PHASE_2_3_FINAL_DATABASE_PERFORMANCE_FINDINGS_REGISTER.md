# Phase 2.3 — Final Database Performance Findings Register

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44`
Report date: 2026-11-16

New finding IDs continue the `DB-GAP-` namespace, checked against the complete master register (Phase 1's
342 IDs, Phase 2.1's `DB-GAP-01`–`09`, Phase 2.2's `DB-GAP-10`–`21`). This phase's new IDs start at
`DB-GAP-22`, confirmed non-colliding.

---

## Part A — Implemented, Locally Verified, Not Yet on Production

| ID | Description | Severity | Schema/table | Query | Source path | Root cause | Evidence | Status | Target phase |
|---|---|---|---|---|---|---|---|---|---|
| **DB-GAP-22** | `ShareLink.ownerUserId` has no supporting index; the owner-facing share dashboard and Profile's recent-shares list both filter by it and sort by `createdAt` | High | `public.share_links` | `home-pulse.service.ts:70-73`, `profile.controller.ts:362-365` | Same | Index never added when the column was | 97.3ms → 1.0ms, measured, 45k-row local benchmark | **Implemented Locally, Benchmarked, Independently Verified** | Pending Production Verification |
| **DB-GAP-23** | `BillingHistory.externalId`+`provider` has no supporting composite; every Stripe/Razorpay webhook idempotency check filters by both | High | `public.billing_history` | `razorpay.service.ts:561,678`, `stripe.service.ts:275,395` | Same | Index never added | 15.7ms → 0.15ms, measured, 30k-row local benchmark | **Implemented Locally, Benchmarked, Independently Verified** | Pending Production Verification |
| **DB-GAP-24** | `DnaRecord.status`+`createdAt` has no supporting composite; super-admin's `listAllDna` filters and sorts by both | Low (admin-only traffic) | `public.dna_records` | `super-admin/assets.ts:111-124` | Same | Index never added | 12.7ms → 0.6ms, measured, 25k-row local benchmark | **Implemented Locally, Benchmarked, Independently Verified** | Pending Production Verification |

## Part B — Designed, Verified on an Isolated Replica, Not Implemented Anywhere Real

| ID | Description | Severity | Schema/table | Query | Source path | Root cause | Evidence | Status | Target phase |
|---|---|---|---|---|---|---|---|---|---|
| **DB-GAP-25** | `sellerMatchClause`/`pinitCodeExpr` wraps the filtered column in a 4-level nested `REPLACE`+`UPPER` expression at 33 call sites across 11 files, defeating any plain B-tree index on the raw column — including 3 **already-deployed production indexes** that are consequently never used by their main caller | **High — the standout finding of this phase** | `exchange.orders_sealed` (no index at all), `exchange.listings`, `exchange.payouts`, `exchange.seller_payout_accounts` (each has a now-proven-unusable plain index) | `creator.js` (3 sites), `payouts.js` (4 sites), `portfolio.js`, `opportunities.js`, 7 more files | `exchange/server/lib/pinit-identity.js:60-81` | Query predicate transforms the column; index does not | `orders_sealed`: 79.97ms (no index) / 99.63ms (plain index, unused) / 0.77ms (expression index) — measured twice, independently re-verified with a second, different-sized seed (37.3ms → 0.6ms) | **Design Complete, Benchmarked on isolated replica, Independently Verified** — not implemented in the real Exchange schema | Open — recommended for the next Exchange-side implementation pass, explicit approval required |

## Part C — Re-Confirmed Open, Carried Forward Unchanged

| ID | Description | Status this phase |
|---|---|---|
| **DB-GAP-09** | `local-dna-index.service.ts:247-253` unbounded `findMany` + per-row `findUnique` + file I/O inside a loop | Re-read directly, confirmed unchanged line-for-line. **Still Open — Deferred to Phase 2.5** pending the vault-size-distribution data neither this phase nor any prior one has. Not fixed: a safe fix requires knowing the real data volume to decide between a capped-loop rewrite and a batched rewrite, and guessing risks a completeness regression in a backfill operation. |
| **APIPERF-M01–M21 bucket** (Phase 1, cross-referenced by Phase 2.1) | "N+1 patterns," "missing DnaRecord indexes," "JS-side aggregation," "unscoped full-row fetches" | Phase 2.1 flagged this bucket's relationship to DB-GAP-09 as "not confirmed identical or distinct." This phase's own query inventory (`PHASE_2_3_DATABASE_QUERY_PERFORMANCE_DISCOVERY_REPORT.md`) did not independently re-derive every item in this bucket — still flagged honestly as unresolved, not assumed covered by DB-GAP-09's fix (which has not happened) or by this phase's three new indexes (which address different tables entirely). |

## Part D — New, Unbounded-Query Finding, Not Fixed

| ID | Description | Severity | Status |
|---|---|---|---|
| **DB-GAP-26** | `evidence-report.controller.ts:146,184,216` — unbounded `shareLink.findMany({ where: { ownerUserId }, select: { id: true } })`, no `take` | Low (id-only projection, but genuinely unbounded) | **Open — deferred.** A cap risks truncating an evidence report's id set, a correctness regression; needs a product/domain-owner decision on whether completeness or a bound matters more here, before any change. |

## Part E — Explicit Non-Findings (Checked, Nothing Wrong Found)

- No redundant or overlapping index pair exists on either Hub or Exchange's index set (checked directly, not
  inherited).
- No problematic deep-offset pagination pattern exists anywhere in either codebase.
- The three indexes this phase implemented do not duplicate, narrow, or widen any existing unique or FK
  constraint.
- Adding these three indexes introduced zero regressions across 4/4 real-database tests, 16/16 mocked
  encryption tests, a clean TypeScript build, and 89/89 security-regression tests.

## Part F — Production-Only Dependencies Kept Open, Per Explicit Instruction

`DB-GAP-01`, `DB-GAP-14`, `DB-GAP-15`, `DB-GAP-16`, `DB-GAP-17`, `DB-GAP-18` through `DB-GAP-21` — all
carried forward unresolved, exactly as instructed. This phase did not attempt to close, touch, or take any
action on any of them.

## Part G — Severity Summary

| Severity | Count | IDs |
|---|---|---|
| High | 3 | DB-GAP-22, DB-GAP-23, DB-GAP-25 |
| Low | 2 | DB-GAP-24, DB-GAP-26 |
| Re-confirmed open (no new severity assigned, carried as-is) | 1 | DB-GAP-09 |

## Part H — Phase 2.3 Verdict

**PASS WITH LIMITATIONS**, subject to the test evidence in
`PHASE_2_3_IMPLEMENTATION_AND_REGRESSION_TEST_REPORT.md` and the independent re-verification in
`PHASE_2_3_INDEPENDENT_PERFORMANCE_REVIEW.md`. Three real, measured, locally-implemented performance fixes;
one major, newly-discovered, rigorously-evidenced finding (DB-GAP-25) correctly left as a recommendation
rather than an implementation, since this phase was not authorized to touch the real Exchange schema; two
pre-existing/newly-found patterns correctly left open pending data this phase does not have (DB-GAP-09) or a
decision this phase cannot make alone (DB-GAP-26).
