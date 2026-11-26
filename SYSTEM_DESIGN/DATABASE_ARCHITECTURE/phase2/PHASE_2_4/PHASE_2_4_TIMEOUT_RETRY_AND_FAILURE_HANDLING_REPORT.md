# Phase 2.4 — Timeout, Retry and Failure Handling Report

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. Timeout Inventory

| Timeout class | Hub | Exchange |
|---|---|---|
| Connection acquisition (pool wait) | `pool_timeout=20` (seconds) via `DATABASE_URL` | `connectionTimeoutMillis: 30_000` in `pg.Pool` config |
| Query/statement execution | **None before this phase.** Fixed: `options=-c statement_timeout=30000` (30s), verified empirically (see `PHASE_2_4_CONNECTION_POOLING_AND_LIFECYCLE_ASSESSMENT.md` §1.2) | **None — re-confirmed, not fixed this phase** (deferred; the verified fix mechanism is documented for reuse) |
| Idle-in-transaction | Not configured on either side | Not configured on either side |
| Lock wait | Not configured on either side | Not configured on either side |
| Transaction-as-a-whole | Not applicable (Prisma `$transaction` has its own internal timeout/maxWait defaults, not independently re-verified this phase) | Not configured — `withImmediateTransaction` has no wall-clock bound of its own |

**Single arbitrary global timeout avoided, per instruction:** the 30s `statement_timeout` applied to Hub this
phase is a single, conservative, explicitly-labeled first bound — not presented as correctly tuned per
workload class, since no per-workload latency data exists yet (Phase 2.5's job). It was chosen specifically
to be long enough not to kill the slowest *known* legitimate query (the audit CSV export, bounded by row
count rather than time) while still closing the complete absence of any bound at all.

## 2. Retry Policy Review

### 2.1 Hub (`src/lib/db-retry.ts`) — re-confirmed, unchanged, already correct

| Attribute | Value |
|---|---|
| Which operations | Reads only (`findMany`/`findFirst`/`findUnique`/etc. — enumerated allowlist, not a blanket match) |
| Which errors qualify | Specific transient Prisma codes (`P1001`, `P1002`, `P1008`, `P1017`) or a connection-reset message match — not a blanket catch-all |
| Max attempts | 1 retry (2 total attempts) |
| Backoff | Fixed 300ms, no exponential backoff, no jitter |
| Inside a transaction? | Never — explicitly excluded |
| Idempotency requirement | Implicitly satisfied — reads are naturally idempotent, which is exactly why only reads are retried |

No change made — this is already a correctly-scoped, safe retry policy and this phase found no defect in it.

### 2.2 Exchange — no retry wrapper found anywhere

Neither `seal-order.js`, `payouts.js`, nor `db.js` wraps any database call in automatic retry logic. This is
**safe by absence** for the two financial workflows audited this phase (no risk of a retry duplicating a
non-idempotent write, because nothing retries automatically) but means a transient connection drop simply
fails the request outright with no recovery — a user-experience gap, not a correctness one. Not changed this
phase: adding retry logic to `withImmediateTransaction` without also auditing every caller for idempotency
would risk introducing exactly the "retry duplicates a financial operation" failure mode the master prompt
explicitly warns against, and no such per-caller idempotency audit was performed this phase.

### 2.3 Retry Storm / Outage-Hiding Review

No unlimited or exponential-without-cap retry loop was found on either service. No circuit-breaker pattern
exists on either service either — not flagged as a defect (none was found to be needed by any workflow
audited this phase), simply noted as absent.

## 3. Idempotency Controls Found

| Mechanism | Location | Scope |
|---|---|---|
| Bridge-event idempotency key | `recordBridgeEvent()` (`bridge-events.js`), keyed on `paymentIntentId`/`orderId` + `listingId` | Prevents reprocessing the same Hub-bridge notification (e.g. a duplicate `SOLD` webhook) — re-confirmed present and unchanged |
| `asset_commerce_locks` primary key | `seal-order.js` | Incidentally prevents a double-exclusive-sell, as detailed in `PHASE_2_4_FINANCIAL_CONCURRENCY_AND_DOUBLE_SELL_AUDIT.md` — not originally designed as an idempotency control, but functions as one |
| Payout row-count check (new this phase) | `payouts.js` | Prevents a second concurrent withdrawal request from committing a payout for earnings already claimed by the first — the fix for DB-GAP-27's financial manifestation |

## 4. Verdict

One genuine timeout gap (Hub `statement_timeout`) was found, fixed, and empirically verified to actually
work — not just configured and assumed. Exchange's equivalent gap is documented and deferred, with the
now-proven fix mechanism recorded for reuse. Existing retry policy on both services was reviewed and found
sound (Hub) or safely absent rather than dangerously present (Exchange) — no retry-related change was needed
or made.
