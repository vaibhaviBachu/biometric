# Phase 2.4 — Tenant Isolation and RLS Assessment

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. The Two Identity Systems — Re-Confirmed Unchanged

- Hub's internal tenant key: `User.id`, propagated as `ownerUserId`/`userId`/`organizationId`/`workspaceId`/
  `departmentId`.
- Cross-service identity: `pinit_id`, normalized via `extractPinitCode` (PGAP-35's own subject), never a
  Prisma primary/tenant key.

This phase did not weaken, bypass, or modify the identity-token architecture (PGAP-17/33/34/35) in any way —
confirmed by the full, unchanged, 89/89-passing security regression suite re-run after every change this
phase made (`PHASE_2_4_IMPLEMENTATION_AND_CONCURRENCY_TEST_REPORT.md`).

## 2. Per-Model Enforcement Classification

Re-confirmed, per the master prompt's own required classification:

| Enforcement class | Examples | Status |
|---|---|---|
| **Application-enforced** (the actual, primary mechanism for both services) | Essentially every tenant-sensitive Hub model; every Exchange query using `sellerMatchClause`/ownership checks | Confirmed via source — this remains the real isolation boundary, not RLS |
| **Database-enforced (RLS)** | `users`, `share_links`, `vault_records`, and others under the `supabase/rls-lockdown/` rollout | **Present but structurally inert for current production traffic** — see `PHASE_2_4_DATABASE_SECURITY_AND_LEAST_PRIVILEGE_ASSESSMENT.md` §3 (DB-GAP-31) |
| **Both** | None found where RLS is both enabled and actually effective against the application's own connecting role | — |
| **Not enforced at either layer** | The 6 models + 9 Portfolio children with no tenant column at all (`WatermarkProfile`, `FileTamperEvent`, `ShareAccessLog`, `RecipientProfile`, `LayerScoreObservation`) — carried from Phase 2.1/2.2, re-confirmed unchanged | Reachable only via parent-join; documented standing constraint, not newly broken |
| **Unknown** | Production TLS/encryption-at-rest (provider-managed, not source-verifiable) | Unchanged |

## 3. Can a Service Access Another Tenant's Data?

No new instance was found this phase of a user-facing path omitting its owner filter. This phase's source
review was concentrated on the financial/transaction paths named in the master prompt (Exchange's
seal-order/payouts flows) rather than a fresh full sweep of all ~370 Hub `findMany` call sites — that full
sweep remains, as Phase 2.1 already stated, not completed by any phase to date. Not claimed as complete here
either.

## 4. Background Jobs

`vault-scheduler.service.ts`'s system-wide integrity check (unbounded `findMany` over all `vaultRecord` rows,
no tenant filter) is re-confirmed present and unchanged — correct and intentional for a system-level job, not
a tenant-isolation defect (a background job that must touch every tenant's data by design is not the same as
a user-facing query that forgot to filter).

## 5. Pooled-Connection Tenant-Context Leakage

The master prompt's Stage 9 specifically warns: "a session variable is [not] safe when connections are
pooled... can connection pooling leak one tenant's context into another request?" This program's
architecture does **not** use session-level or transaction-local tenant-context variables (e.g. Postgres
`SET LOCAL app.current_user_id` patterns often paired with RLS policies) anywhere — tenant scoping is always
an explicit `WHERE` clause parameter in each query, never ambient connection state. **This means the specific
leakage risk the master prompt warns about does not apply to this architecture today**, precisely because
RLS-via-session-context was never wired up (consistent with §2's finding that RLS is not the active
mechanism). This is worth stating explicitly: it is not a gap this phase is leaving unaddressed, it is a risk
category this architecture's current (non-RLS-dependent) design does not create in the first place. It
*would* become a real risk the moment someone tried to activate RLS via a pooled session variable without
first solving connection-context isolation — a sequencing hazard for whichever future phase does attempt RLS
activation, recorded here for that phase's benefit.

## 6. RLS Activation Readiness

Per the master prompt's explicit instruction, **no RLS activation was attempted this phase** — only
verification of current state (§`PHASE_2_4_DATABASE_SECURITY_AND_LEAST_PRIVILEGE_ASSESSMENT.md`). A
table-by-table activation plan requires, in order: (1) the least-privilege role migration (§4 of that
report) so the application's connecting role no longer has `BYPASSRLS` and is no longer the table owner; (2)
a non-production staging environment to test every application path against the real, non-bypassing role;
(3) explicit production approval. None of these three prerequisites exist yet.

## 7. Verdict

No weakening of any existing tenant-isolation or identity control. One significant upgrade in
verification confidence: RLS's practical inertness for Hub's current production traffic is now a confirmed
fact, not an assumption, closing (for Hub) the specific "live-production RLS state UNVERIFIED" gap Phase 2.1
left open. Activation remains explicitly out of this phase's scope and is not recommended until the
least-privilege prerequisite in `PHASE_2_4_DATABASE_SECURITY_AND_LEAST_PRIVILEGE_ASSESSMENT.md` is complete.
