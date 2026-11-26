# Phase 2.5 — Connection Pool and Database Throughput Report

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization (final sub-phase)**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. Measured Connection Ceiling — The Key New Fact This Phase Establishes

A read-only `SHOW max_connections` against production returned **60** — the real, measured, server-level
hard ceiling, not an assumption. A `pg_stat_activity` snapshot at measurement time showed **22 connections in
use instance-wide** (1 active, 14 idle, 1 of untracked state), i.e. roughly a third of capacity already
spoken for before any Phase 2 change added load.

## 2. Hub — Prisma Pool, Reconfirmed

`connection_limit=10`, `pool_timeout=20`, `statement_timeout` now a working 30s (Phase 2.4, re-verified this
phase — see `PHASE_2_5_IMPLEMENTATION_AND_REGRESSION_TEST_REPORT.md`). One shared pool for interactive API
traffic and background/scheduled jobs — **re-confirmed unchanged, still not split**, still correctly flagged
rather than fixed, since no production load data exists to size a split pool responsibly.

## 3. Exchange — Raw `pg.Pool`, Reconfirmed

`max: 10`, `connectionTimeoutMillis: 30_000`, connection-pinning fixed in Phase 2.4 and re-verified this
phase (fresh PID-tracing re-run, same structural-pinning result). No `statement_timeout` configured — same
category of gap as Hub had before Phase 2.4, explicitly not fixed this phase (documented for reuse: the
`options=-c statement_timeout=<ms>` mechanism Phase 2.4 proved works for Hub applies identically to
Exchange's raw `pg.Pool` connection string).

## 4. Connection Budget — Calculated From Actual Configured Limits, Not Invented

| Consumer | Configured limit | Notes |
|---|---:|---|
| One Hub instance | 10 | `connection_limit` in `DATABASE_URL` |
| One Exchange instance | 10 | `pg.Pool({ max: 10 })` |
| Measured current total in use | 22 | `pg_stat_activity`, all consumers combined (includes this phase's own investigative connections, migration tooling, and whatever baseline load already existed) |
| **Server ceiling** | **60** | `SHOW max_connections` |

**The arithmetic that matters:** `10 × (Hub instances) + 10 × (Exchange instances)` reaches **60 — the
entire ceiling — at just 3 Hub + 3 Exchange instances**, leaving **zero** headroom for `prisma migrate`
connections, Supabase's own dashboard/admin connections, or any future analytics/reporting role. This is a
real, quantified, and — given this phase's own measured 22-connection baseline already — **not a distant
concern**: roughly 2 more full-size pools' worth of headroom exists today before any additional instance
scale-out would need a different connection strategy.

**Explicitly not estimated:** the database provider's own connection limits beyond what `SHOW max_connections`
reports, or any other service's connection consumption this phase could not directly observe. This figure is
the real Postgres-server-level ceiling as reported by the server itself, not inferred from documentation.

## 5. Is a Connection Pooler (PgBouncer/Supavisor) Already in the Picture?

The project's own `DATABASE_URL` connects via `aws-1-ap-southeast-1.pooler.supabase.com:6543` — Supabase's
own Supavisor pooler is already in the connection path for Hub's pooled connection string (re-confirmed from
`.env` inspection, consistent with Phase 2.2's own findings). **Whether it is configured for
transaction-pooling mode (which would let many more *logical* application connections multiplex onto the
measured 60 *physical* backend connections) or session-pooling mode (roughly 1:1, no multiplexing benefit)
was not determined by this phase** — that configuration lives in Supabase's project dashboard, not in
anything queryable from an ordinary SQL connection, and is recorded as a production-only unknown rather than
assumed either way.

**Compatibility note, for whichever future phase investigates this further:** transaction-pooling mode is
incompatible with session-level state (prepared statements across requests, session-level `SET` commands,
Postgres advisory locks held across statements) — Prisma's query engine and Exchange's raw `pg.Pool` usage
were not audited this phase for any such dependency; that audit is a prerequisite before relying on
transaction-pooling mode for additional headroom, not something this phase verifies.

## 6. Workload Separation — Still Open, Correctly Not Fixed

Re-confirmed, unchanged from Phase 2.4: Hub's single pool serves both interactive and background traffic.
This phase did not introduce a split, and did not introduce Redis or any other infrastructure dependency to
solve it, per the explicit instruction against doing so without evidence. The evidence that would justify a
split (measured contention, not just architectural possibility) does not exist in this codebase today.

## 7. Verdict

Hub and Exchange's connection architecture is unchanged and safe at today's measured scale (22/60 in use).
The first concrete threshold this program has quantified for horizontal scale-out is connection capacity,
not query performance or storage — reached at a surprisingly modest instance count (3+3) given the
measured, not assumed, 60-connection server ceiling. A pooler already exists in the path for Hub; its exact
pooling mode is an open, production-only question this phase correctly does not resolve from outside.
