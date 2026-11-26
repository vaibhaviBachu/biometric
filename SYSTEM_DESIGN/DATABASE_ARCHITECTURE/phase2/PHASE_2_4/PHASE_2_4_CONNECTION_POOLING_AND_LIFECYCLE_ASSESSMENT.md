# Phase 2.4 — Connection Pooling and Lifecycle Assessment

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. Hub — Prisma Client Singleton (`src/lib/prisma.ts`)

Re-confirmed, re-reading the file directly:

- Exactly one `PrismaClient` instantiation, survives dev hot-reload via a `globalThis` singleton; production
  creates one fresh client per boot (correct — production doesn't hot-reload).
- Graceful shutdown calls `prisma.$disconnect()` (`src/lib/graceful-shutdown.ts`).
- Three `$use` middlewares: a DNA hard-delete guard (blocks `delete`/`deleteMany` on `DnaRecord` entirely),
  per-query timing instrumentation, and a narrowly-scoped read-only retry (`src/lib/db-retry.ts`): retries
  only `findMany`/`findFirst`/etc., never a write, only on transient Prisma error codes (`P1001`/`P1002`/
  `P1008`/`P1017`) or a connection-reset message match, never inside an open transaction, one retry, fixed
  300ms backoff.
- `connection_limit`/`pool_timeout` injected into `DATABASE_URL` only if the URL doesn't already set them —
  so a production deployment can still override both via its own `DATABASE_URL` query string without a code
  change.

### 1.1 DB-GAP-29 — Dead Dev/Prod Ternary (re-confirmed, cleaned up)

`APIPERF-I02` (Phase 1, re-confirmed by Phase 2.1) found `connection_limit = NODE_ENV === 'production' ? '10' : '10'`
— both branches resolve identically, i.e. the apparent dev/prod distinction is dead code. Re-confirmed by
direct re-read this phase. **Fixed this phase**: collapsed to a single constant with a comment explaining
why (rather than inventing a different production number with no load data to justify it — that is
explicitly Phase 2.5's job once real usage is measured).

### 1.2 DB-GAP-28 — No `statement_timeout` (re-confirmed, then genuinely fixed)

Phase 2.1 found no `statement_timeout` configuration anywhere — only connection-pool **wait** time was
bounded (`pool_timeout=20`), not query **execution** time once a connection was acquired. Re-confirmed by
direct re-read.

**Fixed this phase, and the fix was itself verified empirically rather than assumed to work:**

- First attempt — a plain `?statement_timeout=30000` query parameter — **was proven NOT to work**: a direct
  test ran `SELECT pg_sleep(5)` through a Prisma client configured with that parameter and the query ran for
  its full 5 seconds. Prisma's Postgres connector does not translate an arbitrary query-string key into a
  Postgres session setting the way it does for its own `connection_limit`/`pool_timeout` parameters.
- Second attempt — the libpq-native `options` parameter (`?options=-c statement_timeout=30000`) — **verified
  to work**: the same `pg_sleep(5)` test instead errored at ~2.1 seconds (using a 2000ms test value) with
  Postgres error `57014` ("canceling statement due to statement timeout"), both with the raw value and with
  the exact `URLSearchParams.set()` encoding the real code produces.
- 30 seconds was chosen as a conservative first bound: long enough not to kill legitimate slow admin/export
  queries (the existing audit-CSV export already caps itself at 10,000 rows, not time), short enough that
  one runaway query cannot hold a pool connection — and therefore a pool slot — indefinitely. Per-workload
  tuning needs Phase 2.5's real latency data; this phase does not claim 30s is the right number forever, only
  that it closes an unbounded gap with a real, verified mechanism.

### 1.3 Workload Separation

Re-confirmed unchanged: Hub's single shared Prisma pool serves both interactive API traffic and
background/scheduled jobs (`vault-scheduler.service.ts` and others) — no separate pool budget exists. This
phase did not introduce one. Per the master prompt's own instruction not to introduce Redis or another
infrastructure dependency merely to solve a database-pool problem, and given no measured evidence exists of
actual contention (no production query-latency or connection-utilization data was available to this phase
either), splitting the pool was not attempted without that evidence. Flagged, not fixed — a Phase 2.5
data-gathering prerequisite, same as Phase 2.1 already concluded.

## 2. Exchange — Raw `pg.Pool` (`exchange/server/drivers/postgres.js`)

- `max: 10`, `connectionTimeoutMillis: 30_000`. No `idleTimeoutMillis`, no minimum pool size configured
  (both default to node-postgres's own defaults: no idle timeout set means idle clients are never
  proactively closed by the pool itself).
- No `statement_timeout` or equivalent configured for Exchange's own pool either — same category of gap as
  Hub, not fixed this phase (out of this phase's chosen priority order; flagged for a future pass using the
  same verified `options=-c statement_timeout=<ms>` mechanism this phase proved works).
- **The central finding of this phase** — the per-statement `pool.connect()`/`release()` pattern and its fix
  — is detailed fully in `PHASE_2_4_TRANSACTION_ARCHITECTURE_AND_INTEGRITY_REPORT.md`, not repeated here.
- `pool.end()` is called in this phase's own test scripts for clean shutdown; production shutdown behavior
  (whether `exchange/server/server.js` calls an equivalent on `SIGTERM`) was not independently re-verified
  this phase — carried forward as unconfirmed rather than assumed.

## 3. Are Hub and Exchange Independent Pools Against the Same Physical Database?

Re-confirmed: yes, two independent pools (Prisma's internal pool for Hub, `pg.Pool` for Exchange), both
capable of connecting to the same physical Supabase Postgres instance. **Production-only unknown, not
estimated by this phase:** actual concurrent connection totals, since no production connection-count metric
exists in this codebase (same gap Phase 2.1 already identified) and this phase was not authorized to query
production's live connection count in a way that could affect production load — a read-only `pg_stat_activity`
count was judged out of scope for this specific sub-question since it would need to be sampled over time to
mean anything, which this phase's one-shot investigation style cannot responsibly provide.

## 4. Verdict

Two real, verified fixes (statement_timeout, the dead-ternary cleanup) plus one re-confirmed, correctly
unfixed gap (workload separation, pending Phase 2.5 data) on the Hub side. Exchange's pool configuration
itself was reviewed and found to have the same statement_timeout gap, explicitly deferred rather than
addressed in this pass, with the connection-pinning defect (the far more severe finding) fixed instead as
this phase's priority.
