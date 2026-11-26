# Phase 2.3 — Query Optimization and Pagination Report

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44`
Report date: 2026-11-16

---

## 1. The Standout Finding: Exchange's Function-Wrapped-Column Anti-Pattern (DB-GAP-25)

`exchange/server/lib/pinit-identity.js:60-61` defines:

```js
export function pinitCodeExpr(column) {
  return `REPLACE(REPLACE(REPLACE(REPLACE(UPPER(${column}), 'PINIT-EX-', ''), 'PINIT-USER-', ''), 'PINIT-ORG-', ''), 'PINIT-', '')`;
}
```

`sellerMatchClause(column, sellerId)` (same file, lines 74-81) uses this to build a `WHERE` fragment whenever
the caller's seller id resolves to a recognizable "PINIT-" code — the common case. **33 call sites across 11
files** use this helper, including every seller-facing "my sales"/"my listings"/"my payouts" dashboard query
in the entire Exchange marketplace (`creator.js`, `payouts.js`, `portfolio.js`, `opportunities.js`, and
others).

**Why this defeats indexing:** Postgres cannot use a plain B-tree index on `seller_pinit_id` (or `pinit_id`)
for a predicate of the shape `REPLACE(REPLACE(REPLACE(REPLACE(UPPER(seller_pinit_id),...))) = ?` — the index
stores the raw column's values, not the transformed expression's values, so the planner has no way to map
one to the other. This is exactly the "functions applied to indexed columns" anti-pattern named in this
phase's own investigation checklist.

**Proven, not assumed:** this phase built an isolated, throwaway-schema replica of `orders_sealed`'s
relevant columns on the local dev database, seeded 40,000 rows across 400 distinct sellers in the exact
`PINIT-EX-xxxxx` format production uses, and ran the real `sellerMatchClause`-generated SQL three times:

1. **No index at all** (matches `orders_sealed`'s actual current state): sequential scan, **79.97ms**.
2. **A plain index added on the raw `seller_pinit_id` column** (what someone might reasonably try without
   knowing this finding): **still a sequential scan, 99.63ms** — proof the plain index is not merely
   suboptimal but completely unusable for this query shape.
3. **An expression index matching `pinitCodeExpr(seller_pinit_id)` exactly**: bitmap index scan, **0.77ms**.

Full `EXPLAIN` output for all three runs: `PHASE_2_3_QUERY_PLAN_AND_BENCHMARK_REPORT.md`.

**Scope beyond `orders_sealed`:** the same helper, and therefore the same defeat, applies to:
- `exchange.listings` via `idx_ex_listings_seller_status ON exchange.listings (pinit_id, status)` — an
  **already-deployed production index that its own main caller (`creator.js` seller-listings dashboard,
  3 call sites) cannot use**.
- `exchange.payouts` via `idx_ex_payouts_seller ON exchange.payouts (seller_pinit_id, status)` — same
  pattern, confirmed by 4 call sites in `payouts.js`, not independently re-benchmarked this phase (the
  `orders_sealed` case stands as the representative, proven example; the fix is identical).
- `exchange.seller_payout_accounts` via `idx_ex_payout_accounts_seller` — same pattern, not independently
  benchmarked, same recommended fix.

**Recommended fix:** add an expression index matching `pinitCodeExpr(column)` exactly, for each affected
column — written out in full in `PHASE_2_3_MISSING_AND_COMPOSITE_INDEX_ASSESSMENT.md` §4 and ready to add to
`exchange/server/schema/exchange.postgres.sql` (which applies idempotently on every Exchange server boot).
**Not applied to that file, or to any real Exchange schema, in this phase** — verified only on the isolated
replica described above. This is a query-performance fix only; it changes no business logic, no API
response, and no authorization check — `sellerMatchClause`'s own matching logic is untouched, only a new
index is proposed to make the identical predicate fast.

## 2. Unbounded Query Found This Phase

`src/api/controllers/evidence-report.controller.ts:146,184,216` — `shareLink.findMany({ where: { ownerUserId }, select: { id: true } })`
with no `take`. Lower severity than a full-row fetch (id-only projection), but genuinely unbounded. **Not
fixed this phase** — adding a cap here would require knowing whether any caller actually needs the complete
set (the ids feed an `IN` filter for an evidence report; truncating silently could produce an incomplete
report, a correctness regression, not a performance fix). Recommended: confirm with product/domain owner
whether a cap is safe before implementing, consistent with "do not change business logic simply to improve
query speed."

## 3. N+1 Pattern Re-Confirmed (DB-GAP-09)

`src/services/forensics/local-dna-index.service.ts:247-253` (`backfillOwner`) — re-read directly this phase,
confirmed unchanged: unbounded `vaultRecord.findMany` + per-row `findUnique` + file retrieval inside a loop.
**Not fixed this phase**, for the same reason Phase 2.1 gave: this is a backfill/catch-up operation whose
correctness depends on processing every matching record, and Phase 2.1's own recommended precondition —
"measure actual vault-size distribution first (Phase 2.5) before prioritizing" — still has not been met; no
vault-size data exists anywhere in this repository or was made available to this phase. A `take`-capped
rewrite would need to loop until exhausted (to preserve completeness) rather than simply adding `take`, and
that rewrite was judged out of this phase's safe-minimal-change scope without the volume data to size it
correctly. Carried forward, status re-confirmed `OPEN`.

## 4. Pagination Assessment

Reviewed pagination shapes across the domains the master prompt names:

| Area | Pattern found | Assessment |
|---|---|---|
| Vault/assets, sharing, billing, investigations, audit | `take` + `orderBy` consistently present wherever a bounded list is returned (confirmed by Phase 2.1's original inventory, re-spot-checked this phase) | No change needed |
| `share-token-resolver.ts:158-230` | Three separate `findMany` calls each with `take: 1000`/`take: 1000`/`take: 200`, no cursor, re-scanned on every call | Source-level risk pattern — a large `take` with no cursor re-fetches the same rows repeatedly across calls rather than resuming from a bookmark; not measured, no evidence this path is hot enough to matter, not changed this phase |
| Exchange marketplace listings/dashboards | Offset-free `ORDER BY ... LIMIT n` patterns in `creator.js`/`orders.js`, several **with no `LIMIT` at all** (e.g. `orders.js:620-626`) | Confirmed unbounded — same category as §2's Hub finding, not fixed this phase for the same completeness-risk reason |
| Admin/super-admin listings | Consistently bounded (`take: 500`/`take: 30`/`take: 50`) | No issue |

**Offset vs. cursor:** no deep-offset pagination pattern (e.g. a page-number-driven `skip: n*pageSize` on a
large table) was found anywhere in either codebase — every bounded list uses either a fixed `take` with no
`skip`, or a cursor-like token already. This phase did not need to recommend converting any existing offset
pagination to cursor-based pagination, because no problematic offset pagination exists to convert.

## 5. What Was Not Changed, and Why

Per this phase's own instruction not to change business logic to improve speed, and not to break API
contracts, response shapes, authorization checks, or sorting/pagination semantics: no application code was
edited this phase. Every change made was additive (new indexes only). Every unbounded-query or N+1 pattern
found was investigated, evidenced, and explicitly deferred with a stated reason — never silently left
unaddressed without comment.
