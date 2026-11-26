# Phase 2.4 — Transaction Architecture and Integrity Report

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. Hub Transaction Architecture (Prisma)

Hub uses Prisma's `$transaction` across 16 files (`vault.service.ts`, `organization.service.ts`,
`billing-activation.service.ts`, `biometric-auth.service.ts`, `team.service.ts`, and 11 others — carried
forward from Phase 2.1's sampling pass, re-confirmed present and unchanged this phase). Prisma's
`$transaction` genuinely pins one connection for its whole duration by construction — this is a property of
the Prisma Client runtime itself, not something application code can get wrong the way a hand-rolled
BEGIN/COMMIT wrapper can. No new Hub-side transaction-pinning defect was found or was plausible to find,
given this architectural guarantee.

## 2. Exchange Transaction Architecture (Raw Driver) — The Central Finding of This Phase

Exchange has no ORM; `exchange/server/lib/db.js` exports a hand-written transaction helper,
`withImmediateTransaction`, used by `seal-order.js` (the marketplace purchase/licence-sealing flow) and
`payouts.js` (the seller-withdrawal flow).

### 2.1 Root Cause — DB-GAP-27 (confirmed by direct source reading, not inferred)

`exchange/server/drivers/postgres.js`'s module-level `run`/`get`/`all` functions each independently call:

```js
async function withClient(fn) {
  const client = await pool.connect();   // a NEW connection from the pool, every call
  try { return await fn(client); }
  finally { client.release(); }          // released back, every call
}
```

`withImmediateTransaction` (before this phase's fix) sent `BEGIN`, every statement inside the transaction
callback, and `COMMIT` all through these same module-level functions — meaning **every single statement in
what the code calls "one transaction" independently acquired and released its own pooled connection**, with
no connection object threaded through `fn()` at all. This is the exact defect `APIREL-H09`/`PGAP-02`
described in general terms; this phase found its precise mechanism.

### 2.2 Empirical Verification (Not Assumed)

A direct PID-tracing test (`SELECT pg_backend_pid()` run six times inside one `withImmediateTransaction`
call) showed all six statements landing on the same backend PID in a low-concurrency run — **not because the
code pins correctly, but because an idle pooled connection, when nothing else is contending for the pool,
is very likely to be immediately handed back to the next caller purely by timing, with no actual pinning
logic involved.** This matters: the structural defect is real regardless of what any one uncontended test
run shows.

### 2.3 The Two Real-World Consequences Found

| Workflow | File | What the broken pinning enables |
|---|---|---|
| Exclusive-license purchase | `seal-order.js` `sealListingSale` | A genuine TOCTOU race on `asset_commerce_locks` (see `PHASE_2_4_FINANCIAL_CONCURRENCY_AND_DOUBLE_SELL_AUDIT.md`) — **empirically found to be masked, not caused, by this bug**, because a separate, independent primary-key constraint happens to catch the race regardless of pinning. |
| Seller withdrawal/payout | `payouts.js` withdrawal handler | A genuine, **unmasked**, reproduced-on-first-attempt double-payout financial defect — no independent constraint protects this path. This is DB-GAP-27's real-world proof. Full detail: `PHASE_2_4_FINANCIAL_CONCURRENCY_AND_DOUBLE_SELL_AUDIT.md`. |

### 2.4 Fix Implemented This Phase

`exchange/server/drivers/postgres.js` gains `withTransactionClient(fn)`: one `pool.connect()`, `BEGIN` on
that client, every statement `fn()` runs via sqlite3-callback-shaped wrappers bound to that same client,
`COMMIT`/`ROLLBACK`, then `release()` — all on the one pinned client. `exchange/server/lib/db.js`'s
`withImmediateTransaction` now delegates to it on the Postgres path; the SQLite path (already genuinely
single-connection, unaffected by this class of bug) is unchanged.

Re-verified after the fix: the same PID-tracing test now shows pinning that is **structurally guaranteed**,
not incidental.

## 3. Isolation Level and Locking

Exchange's Postgres path uses a plain `BEGIN` (default `READ COMMITTED`), not `BEGIN IMMEDIATE`'s SQLite
semantics the function's own name implies. This is architecturally significant: SQLite's `BEGIN IMMEDIATE`
acquires a write lock immediately, serializing concurrent writers at transaction start; Postgres's plain
`BEGIN` acquires no such lock — two concurrent transactions' `SELECT`s can both proceed before either writes
anything. **No row-locking (`SELECT ... FOR UPDATE`) or serializable isolation was found anywhere in
Exchange's financial code.** The reason the exclusive-listing path still comes out safe under test (§2.3) is
entirely due to a table-level `PRIMARY KEY` constraint catching the conflict at `INSERT` time — not due to
any deliberate isolation-level or locking choice. This phase did not raise Exchange's isolation level
globally (per the master prompt's own caution against doing so without evaluating cost); the chosen fix for
the one workflow that lacked any such backstop (payouts) was a targeted, Postgres-native, and compatible
with `READ COMMITTED`: checking the actual row count an `UPDATE` affected and aborting the transaction on a
mismatch (§`PHASE_2_4_FINANCIAL_CONCURRENCY_AND_DOUBLE_SELL_AUDIT.md`).

## 4. External Calls Inside Transaction Boundaries

Confirmed by direct reading of `seal-order.js`: the three Hub-bridge HTTP calls
(`sealSaleWithHub`/`createLicensedShareOnHub`/`prepareDeliveryWithHub`) all run **after** `withImmediateTransaction`
returns, never inside it — no external network call holds a database transaction open. This is correct
practice, already in place, not something this phase needed to fix.

## 5. Verdict

The central transaction-architecture defect this program has carried since Phase 1 (`APIREL-H09`/`PGAP-02`)
is now root-caused precisely, fixed at its source, and empirically re-verified — on the local dev database
only, never production. One of its two real-world manifestations (the payout race) required an additional,
independent fix beyond connection pinning alone; full detail in the next report.
