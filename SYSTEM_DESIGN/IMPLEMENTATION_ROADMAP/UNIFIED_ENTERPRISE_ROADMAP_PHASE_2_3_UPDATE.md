# Unified Enterprise Remediation Roadmap — Phase 2.3 Update

This is an **addendum** to `UNIFIED_ENTERPRISE_REMEDIATION_ROADMAP.pdf` and the Phase 2.1/2.2 updates, not a
replacement. Every prior report in this directory and in `SYSTEM_DESIGN/DATABASE_ARCHITECTURE/` remains
unmodified and preserved.

## Phase Status

| Phase | Status |
|---|---|
| Phase 1 — API Architecture & Communication (9 sub-phases) | Complete (prior engagement) |
| Security remediation workstreams | Complete locally — READY WITH DOCUMENTED EXTERNAL DEPENDENCIES |
| Phase 2.1 — Database Discovery, Inventory & Architecture Mapping | Complete — PASS WITH LIMITATIONS |
| Phase 2.2 — Prisma Schema, Data Modelling & Referential Integrity | Complete — PASS WITH LIMITATIONS |
| **Phase 2.3 — Indexing, Query Performance & Optimization** | **Complete — PASS WITH LIMITATIONS** (see verdict below). Nine deliverables under `SYSTEM_DESIGN/DATABASE_ARCHITECTURE/PHASE_2_3/`. |
| Phase 2.4 — Transactions, Connection Pooling, Security & Tenant Isolation | Not started — awaiting approval. Now also inherits DB-GAP-25 (Exchange expression-index implementation, if the Exchange-side work is scheduled there) in addition to DB-GAP-14/20 and the carried-forward DB-GAP-07. |
| Phase 2.5 — Scalability, Capacity Planning & Final Gap Analysis | Not started — awaiting approval. DB-GAP-09's fix remains explicitly gated on this phase's data-volume measurement. |

## Phase 2.3 Headline Finding

A **systemic Exchange-side query-performance defect (`DB-GAP-25`)**: a shared helper
(`pinitCodeExpr`/`sellerMatchClause` in `exchange/server/lib/pinit-identity.js`) wraps the filtered
seller/owner-identity column in a 4-level nested `REPLACE`+`UPPER` SQL expression at 33 call sites across 11
files — every seller-facing "my sales"/"my listings"/"my payouts" dashboard in the marketplace. This defeats
any plain B-tree index on the raw column, including **three indexes already deployed to production**
(`listings.pinit_id`, `payouts.seller_pinit_id`, `seller_payout_accounts.pinit_id`) that are consequently
never usable by their own main caller. Proven, not assumed: measured on an isolated local replica of
`orders_sealed` — a plain index added to the raw column remained unused (sequential scan, 99.63ms); an
expression index matching the exact predicate dropped execution to 0.77ms. Independently re-verified with a
second, differently-sized seed (37.3ms → 0.6ms). The fix is designed and ready
(`SYSTEM_DESIGN/DATABASE_ARCHITECTURE/PHASE_2_3/PHASE_2_3_MISSING_AND_COMPOSITE_INDEX_ASSESSMENT.md` §4) but
not yet applied to the real Exchange schema anywhere, pending explicit approval.

Three further findings (`DB-GAP-22`/`23`/`24`) — all three index candidates Phase 1 and Phase 2.1 had
flagged as "statically plausible" but never confirmed — were independently re-evaluated against actual query
patterns, confirmed required (two as high-priority composite indexes on Hub's share-dashboard and
billing-webhook paths, one as a lower-priority admin-only fix), implemented on the local dev database, and
measured: 20-100x execution-time improvements across all three, with real `EXPLAIN (ANALYZE, BUFFERS)`
evidence for each.

## New Finding Namespace Extension

Phase 2.3 extends the `DB-GAP-` namespace with `DB-GAP-22` through `DB-GAP-26`, confirmed non-colliding with
every prior `DB-GAP-` ID and the 342 Phase 1 IDs. `DB-GAP-09` (Phase 2.1's own standout N+1 finding) is
re-confirmed present and unchanged, correctly kept open pending Phase 2.5's data-volume work rather than
guessed at.

Full detail: `SYSTEM_DESIGN/DATABASE_ARCHITECTURE/PHASE_2_3/PHASE_2_3_FINAL_DATABASE_PERFORMANCE_FINDINGS_REGISTER.md`.

## Phase 2.3 Verdict

**PASS WITH LIMITATIONS** — three real, measured, locally-implemented performance fixes; one major
newly-discovered finding correctly designed and proven rather than implemented outside this phase's
authority; pre-existing and newly-found open items correctly left open pending data or decisions this phase
does not have. Full regression (4/4 real-database tests, 16/16 mocked encryption tests, clean build, 89/89
security-regression tests) passes with zero new failures. No production or staging database was modified.
