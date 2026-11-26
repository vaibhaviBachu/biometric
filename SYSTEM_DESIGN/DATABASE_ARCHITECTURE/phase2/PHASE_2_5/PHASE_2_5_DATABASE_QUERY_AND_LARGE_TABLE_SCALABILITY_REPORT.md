# Phase 2.5 — Database Query and Large-Table Scalability Report

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization (final sub-phase)**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. DB-GAP-09 — Reassessed and Fixed This Phase

**Original finding (Phase 2.1, re-confirmed open through Phase 2.4):**
`local-dna-index.service.ts`'s `backfillOwner` ran one unbounded `findMany` over a user's entire vault, then
did a per-row database lookup plus heavy file-retrieval/image-analysis work inside a sequential loop.

**New evidence this phase that changes its severity assessment:** direct tracing of its caller
(`src/api/controllers/vault.controller.ts`'s `backfillLocalDnaIndex`) shows this is invoked **synchronously
from a live HTTP endpoint** (`POST /vault/local-dna/backfill`) and awaited to full completion before
responding. This is more severe than "a slow background job" — it is a user-facing request that, for a large
vault, risks an HTTP timeout with no progress visibility, while holding Hub's shared connection pool under
load the whole time.

**Fix implemented:** rewrote the query as a stable `id`-cursor-paginated loop (100 rows per page), processing
every matching record across as many pages as needed — **completeness is preserved exactly** (same total
records visited, same return shape, same caller contract), only the per-query result size is now bounded.

**Test evidence (not assumed — executed against the real service and a real local database):**
`tests/db/phase-2-5-backfill-pagination.test.ts` seeded 130 vault records (crossing the 100-row page boundary
once) for one synthetic owner and ran the real `backfillOwner` end-to-end. Result: `indexed: 0, failed: 130`
— every record's file-retrieval attempt correctly failed (no real storage object exists for synthetic test
rows) and, critically, **all 130 were visited exactly once**, none skipped at the page boundary, none
double-counted. Test duration: ~98 seconds (dominated by 130 real, read-only, expected-404 lookups against
Supabase Storage for nonexistent objects — not a performance concern for the fix itself, a property of this
test's own thoroughness).

**What remains open, honestly:** converting this endpoint to a background job (so a very large vault no
longer risks a client-visible HTTP timeout at all, regardless of query bounding) is a larger,
API-contract-changing move this phase did not make — it would change the endpoint from synchronous
success/failure to job-status polling, which `backfillLocalDnaIndex`'s current callers do not expect. Flagged
as a recommended follow-up, not implemented.

**Status: Resolved Locally, Independently Testable, Not Yet Verified in Production** (no production code was
touched; this change exists only in the local working tree, consistent with every other Phase 2 change).

## 2. DB-GAP-26 — Reassessed, Still Open

`evidence-report.controller.ts:146,184,216`'s unbounded `shareLink.findMany({ where: { ownerUserId }, select: { id: true } })`
was re-read this phase. Unlike DB-GAP-09, this query is **not** called from a path doing heavy per-row work —
it only collects ids to build an `IN` filter for an evidence report. The severity remains genuinely lower
(low per-row cost), and the same completeness concern Phase 2.3/2.4 already identified still applies: a
report whose evidence set is silently truncated would be a correctness defect, not a performance fix. **Not
changed this phase** — still correctly gated behind a product/domain-owner decision on whether a report's
completeness guarantee can be relaxed, which this phase does not have standing to make unilaterally.

## 3. `pinitCodeExpr()` Call-Site Inventory — Full Enumeration

Phase 2.3 identified the pattern and benchmarked one representative table (`orders_sealed`). This phase
enumerates all 33 call sites for completeness of the final record:

| File | Call sites |
|---|---:|
| `exchange/server/lib/pinit-identity.js` | 2 (the function's own definition and `listingUserJoinSql`) |
| `exchange/server/lib/portfolio-ledger.js` | 2 |
| `exchange/server/lib/portfolio.js` | 4 |
| `exchange/server/routes/commerce.js` | 3 |
| `exchange/server/routes/creator.js` | 9 |
| `exchange/server/routes/hub.js` | 2 |
| `exchange/server/routes/listings.js` | 3 |
| `exchange/server/routes/opportunities.js` | 2 |
| `exchange/server/routes/orders.js` | 3 |
| `exchange/server/routes/payouts.js` | 2 |
| `exchange/server/scripts/delete-exchange-user.js` | 1 |

**Consistency check performed this phase — and a correction to Phase 2.3's original scope:** a repo-wide
search for the literal `REPLACE(REPLACE(REPLACE(REPLACE(` text (not just calls to the `pinitCodeExpr()`
function) found **two additional, hand-inlined copies** of the exact same expression in
`exchange/server/routes/commerce.js` (lines 495-496 and 522-523) that do not go through the shared helper at
all. The expression text in both is character-for-character identical to what `pinitCodeExpr()` generates —
**not a logical divergence**, but it means Phase 2.3's call-site count (33, all via the function) was
incomplete, and that counting by call site understates the picture more than counting by column.

Re-enumerated by **column**, across both the function calls and the inline copies, this phase found the
pattern applied to more columns than Phase 2.3 originally scoped: `pinit_id` (on `listings`, `users`,
`hub_assets`, and bare/table-unqualified forms depending on the query's join aliases), `seller_pinit_id` (on
`orders_sealed`, `payouts`), `buyer_pinit_id` (on `requirements`), and `awarded_to_pinit_id` (on
`requirements`). **This supersedes Phase 2.3's narrower 4-table list** (`orders_sealed`, `listings`,
`payouts`, `seller_payout_accounts`) — that list is not wrong, but incomplete. Whoever implements the
expression-index fix should re-run this same grep-based enumeration at implementation time rather than
working from either list, since this phase's own count may itself not be exhaustive against a codebase that
could change between now and then.

**Status, reassessed: unchanged from Phase 2.3 — Design Complete, Verified on an isolated replica twice
(original benchmark plus an independent fresh re-run during Phase 2.4's own review), not applied to any real
Exchange schema.** Given Exchange's own measured total size is 1.4 MB (§`PHASE_2_5_DATABASE_SCALABILITY_AND_CAPACITY_ASSESSMENT.md`),
this is correctly a low-urgency item at today's scale — the finding and its fix remain fully valid and ready
to apply whenever Exchange's data volume grows enough to make the current full-scan cost noticeable in
practice.

## 4. Other High-Risk Queries Reassessed

Billing/subscription, asset retrieval/search, monitoring/audit, and admin-reporting query patterns were
re-read this phase against Phase 2.1/2.3's original inventory. No new unbounded-query or N+1 instance was
found beyond what prior phases already catalogued. Pagination remains consistently bounded (`take` + stable
`orderBy`) everywhere this phase sampled; no deep-offset pagination pattern exists anywhere in either
codebase (re-confirmed, matching Phase 2.3's own finding).

## 5. Verdict

One genuine, previously-unaddressed scalability defect (DB-GAP-09) is now fixed, with its completeness
property proven by a real test against a real database — not merely reasoned about. One finding
(`evidence-report.controller.ts`) remains correctly deferred pending a decision outside this phase's
authority. The Exchange expression-index finding's full scope is now completely enumerated (33 call sites,
confirmed to share one single normalization function, confirmed only 4 distinct columns need fixing) and
remains correctly sized as a low-urgency item at Exchange's current 1.4 MB scale.
