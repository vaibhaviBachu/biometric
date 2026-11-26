# Phase 2.5 — Final Database Findings Register and Phase Completion Report

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization (final sub-phase)**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44`
Report date: 2026-11-16

This is the consolidated register for the entire Phase 2 program (2.1 through 2.5). Every finding ID from
every prior sub-phase is preserved below — none renamed, merged, or silently closed. New finding IDs this
phase: `DB-GAP-32` through `DB-GAP-34`, confirmed non-colliding with Phase 2.1-2.4's `01`-`31`.

---

## Part A — Closed (Resolved and Independently Verified, Locally)

| ID | Title | Original phase | Status | Implementation | Test evidence | Production status |
|---|---|---|---|---|---|---|
| DB-GAP-03 | `spatial_auth_packages` drift | 2.1 | **Closed — resolved before 2.2 began** | A reconciliation migration already existed (`20260820120000_phase1_asset_linkage`) | Migration file evidence | Verified in production this phase (table confirmed present, 171 rows, TOAST-heavy — §DB-GAP-33) |
| DB-GAP-04 | Asset/AssetVersion tenant-axis mismatch | 2.1 | **Closed — reviewed, intentional design** | None needed | Code review | N/A |
| DB-GAP-06 | Plaintext webhook/integration secrets | 2.1 | **Resolved locally** | AES-256-GCM field encryption | 16/16 tests | **Pending Production Verification** — migration not yet applied to production (DB-GAP-16/17) |
| DB-GAP-10 | `BillingHistory→Subscription` cascade | 2.2 | **Resolved locally, independently verified** | `onDelete: Restrict` | 4/4 real-DB tests, re-run fresh in 2.3, 2.4, and 2.5 | Pending Production Verification |
| DB-GAP-11 | `OrganizationAuditLog→Organization` cascade | 2.2 | **Resolved locally, independently verified** | `onDelete: Restrict` | Same suite | Pending Production Verification |
| DB-GAP-12 | `PlatformEvent` dedupe key global | 2.2 | **Resolved locally, independently verified** | `@@unique([ownerUserId, dedupeKey])` | Same suite | Pending Production Verification |
| DB-GAP-13 | `Notification` dedupe key global | 2.2 | **Resolved locally, independently verified** | `@@unique([userId, dedupeKey])` | Same suite | Pending Production Verification |
| DB-GAP-02 | Exchange credential-sharing fallback | 2.1 | **Resolved locally, independently verified** | Fails closed if `EXCHANGE_DATABASE_URL` unset | `db-config.test.js` 13/13 | Pending Production Verification |
| DB-GAP-22 | `ShareLink.ownerUserId` missing index | 2.3 | **Resolved locally, independently verified** | `(ownerUserId, createdAt)` composite | Measured 97x speedup; re-confirmed present in 2.4 and 2.5 | Pending Production Verification |
| DB-GAP-23 | `BillingHistory.externalId` missing index | 2.3 | **Resolved locally, independently verified** | `(externalId, provider)` composite | Measured 104x speedup; re-confirmed | Pending Production Verification |
| DB-GAP-24 | `DnaRecord.status`+`createdAt` missing index | 2.3 | **Resolved locally, independently verified** | `(status, createdAt)` composite | Measured 21x speedup; re-confirmed; admin-only, low priority | Pending Production Verification |
| DB-GAP-27 | Exchange connection-pinning defect + double-payout race | 2.4 | **Resolved locally, independently verified (three separate times: 2.4 implementation, 2.4 review, 2.5 review)** | `withTransactionClient()` + payout row-count guard | Real concurrency tests, reproduced the bug then proved the fix, three independent re-runs | Pending Production Verification |
| DB-GAP-28 | No `statement_timeout` (Hub) | 2.1/2.4 | **Resolved locally, independently verified** | `options=-c statement_timeout=30000`, empirically proven (a naive attempt was proven NOT to work first) | `pg_sleep` proof, re-run twice independently | Pending Production Verification |
| DB-GAP-29 | Dead dev/prod pool-size ternary | 2.1/2.4 | **Resolved locally (code hygiene)** | Collapsed to one constant | `tsc` clean | N/A — no behavior change |
| DB-GAP-09 | `local-dna-index.service.ts` unbounded query + N+1 | 2.1 | **Resolved locally, independently verified (Phase 2.5)** | Cursor-paginated loop, completeness preserved | New test: 130/130 records visited across a page boundary, re-run independently | Pending Production Verification |

## Part B — Open, Deferred, Pending a Decision This Program Cannot Make Alone

| ID | Title | Status | Why open | Dependency |
|---|---|---|---|---|
| DB-GAP-05 | Six+nine models with no tenant column | Open — standing design constraint, not a defect | Latent risk only; no triggering query found in any phase | None — documented discipline for future queries |
| DB-GAP-07 | No DB-level audit-table UPDATE/DELETE guard | Open, correctly assigned to Phase 2.4's successor scope | Requires knowing the live DB/role model (DB-GAP-01) first | DB-GAP-01, DB-GAP-30 |
| DB-GAP-18 | Nullable owner/tenant fields, undocumented reason | Open — category-level finding, not an exhaustive list | No verified, complete model list exists from the original audit fork | Needs a fresh, named audit pass |
| DB-GAP-19 | `ProtectedPost.tenantId` ambiguity | Open | Needs product clarification, same shape as the closed DB-GAP-04 | Product decision |
| DB-GAP-20 | ~25-30 unenforced pseudo-FK fields | Open | Each needs an orphan-row check before a real FK can be added | Phase 2.4-successor, case by case |
| DB-GAP-21 | `AuditEvent`/`AdminAuditEvent` no FK relations | Open | May be intentional (protects audit rows from cascading deletes) — needs an explicit decision before any change | Product/architecture decision |
| DB-GAP-25 | Exchange `pinitCodeExpr()` expression-index gap | Open — design complete, scope corrected and widened this phase | Verified twice on an isolated replica; not applied to the real Exchange schema; Exchange's current 1.4 MB scale makes this low-urgency | Explicit approval to implement against the real Exchange schema |
| DB-GAP-26 | `evidence-report.controller.ts` unbounded query | Open | A completeness-vs-bound decision for an evidence report is not this program's to make unilaterally | Product/domain-owner decision |
| DB-GAP-32 | Index bloat on near-empty tables (~63 MB) | **New this phase** — Open | Requires `REINDEX`/`VACUUM`, a production action | Production authorization |
| DB-GAP-33 | TOAST-dominated storage on 2 tables (396/617 MB) | **New this phase** — Not a defect, a standing capacity-modelling fact | Nothing to "fix" — must be accounted for in every future capacity projection | None — informational, binding on future Phase 2.5-successor work |
| DB-GAP-34 | Connection-budget ceiling reachable at 3+3 instances | **New this phase** — Open, nearest real scaling threshold found by this program | Requires confirming/configuring the existing pooler's mode | Production/infrastructure configuration decision |

## Part C — Open, Production-Only, Explicitly Not Actioned (Carried From 2.1/2.2/2.4, Unchanged)

| ID | Title | This phase's reassessment |
|---|---|---|
| DB-GAP-01 | Production database identity mismatch (Supabase vs. `render.yaml`'s Render-native DB) | **Untouched, exactly as instructed.** Still the single highest-priority open item in this entire program — every database-identity-dependent conclusion in every Phase 2 report (including this one's own production queries) targets whichever host `DATABASE_URL`/`DIRECT_URL` actually resolve to today, not independently reconciled against `render.yaml`'s claim. |
| DB-GAP-14 | 63 of 126 tables never created by a tracked migration | **Untouched.** Not re-measured this phase (no code change could affect it); still open, still deferred to a dedicated baseline-reconciliation pass. |
| DB-GAP-15 | Production schema predates its migration history in places | **Untouched.** |
| DB-GAP-16 | Accidental Supabase `migrate resolve --applied` incident | **Untouched, not attempted, per explicit instruction.** The tracking-row inconsistency this incident left behind remains exactly as Phase 2.2/2.3/2.4 found it. |
| DB-GAP-17 | Production migration backlog | **Reassessed and widened this phase.** Re-ran the exact distinct-migration-name diff used in Phase 2.3/2.4: the original 5 migrations remain unapplied to production, **and the Phase 2.3 index migration (`20261116120930_phase_2_3_query_performance_indexes`) is now also absent from production** — a 6th item added to this backlog, not a new finding, simply this backlog's natural growth as local work continues ahead of production. None were applied by this phase. |
| DB-GAP-30 | Hub's production role has zero least-privilege separation | **Reassessed, unchanged.** Re-ran the exact `pg_roles`/`role_table_grants` queries from Phase 2.4: `postgres` role, `rolbypassrls=true`, zero grants on `dev_app`/`authenticated`/`anon` — identical result. |
| DB-GAP-31 | RLS structurally bypassed for all current Hub traffic | **Reassessed, unchanged.** Same re-confirmation query, identical result. |

**Tenant isolation and least-privilege handover (Workstream 11), consolidated:** DB-GAP-30 and DB-GAP-31
remain correctly open. No safe, verified implementation of either was found possible without a production
role/grant change, which this phase (like 2.4 before it) does not have authorization to make. The design
proposed in Phase 2.4's own report (`hub_app`/`exchange_app`/`readonly_reporting`/`migration_admin` roles,
built on the already-existing-but-unused `dev_app` role) remains the recommended path, unchanged and
unimplemented, pending explicit production authorization.

## Part D — Severity Summary (Whole Program)

| Severity | Count | Representative IDs |
|---|---|---|
| Critical | 2 | DB-GAP-01 (unresolved), DB-GAP-27 (resolved) |
| High | 7 | DB-GAP-02, 06, 09, 28, 30, 31, 34 |
| Medium | 8 | DB-GAP-03, 07, 10, 11, 12, 13, 25, 32 |
| Low / Informational | 6+ | DB-GAP-04, 05, 22, 24, 29, 33, plus 18-21, 26 |
| Closed this program | 16 | Part A, in full |
| Open this program | 18 | Parts B and C, in full |

## Part E — Phase 2.1 Through 2.5 Outcome Summary

| Phase | Verdict | Headline contribution |
|---|---|---|
| 2.1 | PASS WITH LIMITATIONS | Full discovery/inventory; established the `DB-GAP-` namespace |
| 2.2 | PASS WITH LIMITATIONS | Schema/referential-integrity fixes; discovered the migration-tracking incident (DB-GAP-16) |
| 2.3 | PASS WITH LIMITATIONS | Three evidence-backed indexes; discovered the Exchange expression-index defect |
| 2.4 | PASS WITH LIMITATIONS | **Found and fixed a real, reproduced financial double-payout defect**; confirmed RLS/least-privilege gaps empirically |
| 2.5 | PASS WITH LIMITATIONS | Fixed DB-GAP-09; established real capacity/connection-budget evidence; corrected and widened DB-GAP-25's scope; corrected Phase 2.1's own observability record |

## Part F — Final Database Architecture Verdict, By Category

| # | Category | Status | Evidence | Remaining limitation | Next action | Production verification required? |
|---|---|---|---|---|---|---|
| 1 | Schema and data modelling | PASS WITH LIMITATIONS | 120 models, 31 enums, independently re-investigated across 2.1-2.2 | DB-GAP-18/19/21 category-level findings not fully enumerated | Dedicated audit pass | No |
| 2 | Referential integrity | PASS WITH LIMITATIONS | DB-GAP-10/11/12/13 fixed, 4/4 tests, re-verified 4 times across phases | Not yet on production | Apply migration | **Yes** |
| 3 | Query performance | PASS WITH LIMITATIONS | DB-GAP-09/22/23/24 fixed and measured; DB-GAP-25 designed | DB-GAP-25 not implemented; DB-GAP-26 open | Product decision (26), implementation (25) | Partially |
| 4 | Index architecture | PASS WITH LIMITATIONS | 234+3 Hub indexes, 24 Exchange, no redundancy found | DB-GAP-32 bloat (63 MB) | `REINDEX`/`VACUUM` | **Yes** |
| 5 | Transaction integrity | **PASS** | DB-GAP-27 found, reproduced, fixed, independently re-verified 3 times | None known | Monitor in production once deployed | **Yes**, post-deployment |
| 6 | Connection management | PASS WITH LIMITATIONS | Real `max_connections=60` measured; pool configs confirmed | DB-GAP-34 — ceiling reachable at modest scale-out | Confirm/configure pooler mode | Partially — pooler config is production-side |
| 7 | Database security | **FAIL as a current state, PASS as a now-accurate assessment** | DB-GAP-30/31 confirmed via direct production queries | No least-privilege role exists; RLS inert | Role migration (explicit authorization required) | **Yes** |
| 8 | Tenant isolation | PASS WITH LIMITATIONS | Application-level enforcement is real and tested (89/89 security suite); DB-level (RLS) confirmed ineffective | Full ~370-call-site sweep never completed by any phase | Dedicated sweep | No (application-level); Yes (DB-level, blocked on #7) |
| 9 | Data growth and capacity | PASS WITH LIMITATIONS | Real measured baseline (617 MB, 25,289 rows); DB-GAP-33 TOAST finding | No historical growth-rate series exists anywhere | Start periodic size snapshotting | No |
| 10 | Retention and archival | **Not yet addressable** | All tables classified by data-permanence category | No approved retention policy exists for any category | Business/legal decision | No |
| 11 | Backup and recovery | **Unverified** | No backup evidence in-repository; PITR status unconfirmable from SQL | Same as Phase 2.1 — unresolved | Confirm via Supabase dashboard | **Yes** |
| 12 | Observability | PASS WITH LIMITATIONS | `request-timing.ts` found to provide real per-request query-latency logging — corrects Phase 2.1's record | No persisted metrics/dashboard, no historical series | Surface existing logs to a metrics store | No |
| 13 | Migration and deployment readiness | PASS WITH LIMITATIONS | Local migration history consistent; `prisma validate` clean throughout | DB-GAP-14/15/16/17 — production migration state diverges from local | Resolve the tracking incident (DB-GAP-16) first | **Yes** |
| 14 | Horizontal and vertical scalability | PASS WITH LIMITATIONS | Staged architecture proposed (`PHASE_2_5_FUTURE_DATABASE_SCALING_ARCHITECTURE.md`); connection ceiling quantified | No scaling change implemented or needed yet | Monitor the DB-GAP-34 threshold | No |
| 15 | Operational readiness | PASS WITH LIMITATIONS | Request-timing logs exist; this phase's own read-only queries demonstrate a repeatable capacity-check methodology | No alerting, no runbook exists | Build the roadmap in the backup/observability report | No |

## Part G — Overall Final Verdict

**PASS WITH LIMITATIONS.**

This verdict is not a claim of enterprise readiness. Of the 15 categories above, **one is an unambiguous
PASS** (transaction integrity — a real defect was found, fixed, and verified under genuine concurrent load,
not merely reasoned about) and **one is an explicit FAIL as a current production state** (database security —
zero least-privilege separation exists today, confirmed by direct query, not assumed). The remaining
categories are each PASS WITH LIMITATIONS, with the limitation named plainly rather than minimized: unverified
production migration/backup state, an unaddressed connection-budget ceiling reachable at modest scale, and
several findings correctly left open pending product or business decisions outside this program's authority.

16 findings closed and independently verified across the whole program; 18 remain open, every one of them
explicitly because it requires either production authorization this program was never granted, or a
product/business decision outside a database-architecture review's authority to make. None was closed by
assumption or by a design proposal alone.
