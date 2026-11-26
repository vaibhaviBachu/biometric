# Phase 2.3 — Query Plan and Benchmark Report

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44`
Report date: 2026-11-16

---

## 0. Environment and Safety

All measurements below ran against the project's existing local per-developer Docker Postgres
(`docker-compose.dev.yml`, container `pinit-hub-dev-db`, PostgreSQL 16-alpine, port 5435), or an isolated,
throwaway schema created on that same local database for the Exchange-side test. **No production or staging
database was queried, profiled, or modified at any point.** All seeded test data was synthetic, and all of
it — rows, indexes created purely for the test, and the throwaway schema itself — was deleted/dropped after
each benchmark, verified by a direct row-count and `pg_indexes`/`information_schema` check afterward.

Every number below is copy-pasted directly from real `EXPLAIN (ANALYZE, BUFFERS)` output, not estimated,
rounded for narrative effect, or invented. Where a measurement could not be obtained, this report says so
explicitly rather than guessing.

## 1. Hub — `ShareLink(ownerUserId, createdAt)` — DB-GAP-22

**Setup:** 20,000 `ShareLink` rows for one synthetic user, plus 25,000 "noise" rows with `ownerUserId = NULL`
(45,000 rows total), `ANALYZE`d before each measurement. Query shape taken verbatim from
`home-pulse.service.ts`/`profile.controller.ts`.

**BEFORE** (no index on `ownerUserId`):
```
Limit  (cost=3895.97..3898.47 rows=1000 width=130) (actual time=88.818..89.123 rows=1000 loops=1)
  Buffers: shared hit=2239
  ->  Sort  (cost=3895.97..3945.87 rows=19961 width=130) (actual time=88.815..88.957 rows=1000 loops=1)
        Sort Key: "createdAt" DESC
        Sort Method: top-N heapsort  Memory: 385kB
        Buffers: shared hit=2239
        ->  Seq Scan on share_links  (cost=0.00..2801.53 rows=19961 width=130) (actual time=20.388..64.613 rows=20000 loops=1)
              Filter: ("ownerUserId" = 'p23-user-bd856b5d'::text)
              Rows Removed by Filter: 25002
              Buffers: shared hit=2239
Planning Time: 5.077 ms
Execution Time: 97.336 ms
```

**AFTER** (with `share_links_ownerUserId_createdAt_idx`):
```
Limit  (cost=0.29..245.82 rows=1000 width=130) (actual time=0.079..0.811 rows=1000 loops=1)
  Buffers: shared hit=54
  ->  Index Scan using "share_links_ownerUserId_createdAt_idx" on share_links  (cost=0.29..4904.93 rows=19976 width=130) (actual time=0.077..0.689 rows=1000 loops=1)
        Index Cond: ("ownerUserId" = 'p23-user-bd856b5d'::text)
        Buffers: shared hit=54
Planning Time: 9.766 ms
Execution Time: 1.009 ms
```

| Metric | Before | After |
|---:|---:|---:|
| Execution time | 97.336 ms | 1.009 ms |
| Planning time | 5.077 ms | 9.766 ms |
| Rows scanned | 45,002 (20,000 matched + 25,002 removed by filter) | 20,000 (via index condition) |
| Rows returned | 1,000 | 1,000 |
| Buffer hits | 2,239 | 54 |
| Index usage | None — sequential scan | `share_links_ownerUserId_createdAt_idx`, index scan |

**Measured improvement: ~96x faster execution, ~41x fewer buffer accesses**, on this specific 45,000-row
synthetic dataset. This is a measured result on synthetic local data, not a production measurement — stated
explicitly per this phase's own evidentiary rules.

**Note on index direction:** the index actually committed to `prisma/schema.prisma` and the migration file is
a plain ascending `(ownerUserId, createdAt)` index (no explicit `DESC`), not the `DESC`-qualified version
used in the initial benchmark run above. Re-verified separately on a fresh 5,000-row reseed that the plain
ascending index is still used for the `ORDER BY createdAt DESC` query, via Postgres's backward-index-scan
capability (`Index Scan Backward using "share_links_ownerUserId_createdAt_idx"`, 1.314ms execution) —
confirming the committed index definition performs equivalently, not a weaker approximation of what was
benchmarked.

## 2. Hub — `BillingHistory(externalId, provider)` — DB-GAP-23

**Setup:** 30,000 `BillingHistory` rows, alternating `provider` 50/50 between `RAZORPAY`/`STRIPE`, each with
a unique `externalId`.

**BEFORE** (only `provider` indexed):
```
Bitmap Heap Scan on billing_history  (cost=168.79..911.79 rows=1 width=41) (actual time=6.292..14.715 rows=1 loops=1)
  Recheck Cond: (provider = 'RAZORPAY'::"BillingProvider")
  Filter: ("externalId" = 'ext_15_500_bd856b5d'::text)
  Rows Removed by Filter: 14999
  Heap Blocks: exact=518
  Buffers: shared hit=531
  ->  Bitmap Index Scan on billing_history_provider_idx  (cost=0.00..168.79 rows=15000 width=0) (actual time=2.717..2.718 rows=15010 loops=1)
        Index Cond: (provider = 'RAZORPAY'::"BillingProvider")
        Buffers: shared hit=13
Planning Time: 2.255 ms
Execution Time: 15.699 ms
```

**AFTER** (with `billing_history_externalId_provider_idx`):
```
Index Scan using "billing_history_externalId_provider_idx" on billing_history  (cost=0.29..8.31 rows=1 width=41) (actual time=0.076..0.078 rows=1 loops=1)
  Index Cond: (("externalId" = 'ext_15_500_bd856b5d'::text) AND (provider = 'RAZORPAY'::"BillingProvider"))
  Buffers: shared hit=3
Planning Time: 0.988 ms
Execution Time: 0.151 ms
```

| Metric | Before | After |
|---:|---:|---:|
| Execution time | 15.699 ms | 0.151 ms |
| Rows scanned (via bitmap) | 15,010, then filtered to 1 | 1 (direct) |
| Buffer hits | 531 | 3 |
| Index usage | `billing_history_provider_idx` only, then an in-memory filter | `billing_history_externalId_provider_idx`, exact |

**Measured improvement: ~104x faster execution, ~177x fewer buffer accesses**, on this 30,000-row synthetic
dataset.

## 3. Hub — `DnaRecord(status, createdAt)` — DB-GAP-24

**Setup:** 25,000 `DnaRecord` rows, `status` round-robin across all 5 enum values (~5,000 each).

**BEFORE**:
```
Limit  (cost=1005.91..1007.16 rows=500 width=49) (actual time=12.444..12.544 rows=500 loops=1)
  Buffers: shared hit=442
  ->  Sort  (cost=1005.91..1018.42 rows=5006 width=49) (actual time=12.440..12.484 rows=500 loops=1)
        Sort Key: "createdAt" DESC
        Sort Method: top-N heapsort  Memory: 157kB
        Buffers: shared hit=442
        ->  Seq Scan on dna_records  (cost=0.00..756.46 rows=5006 width=49) (actual time=0.024..8.526 rows=5006 loops=1)
              Filter: (status = 'COMPLETE'::"DnaStatus")
              Rows Removed by Filter: 20151
              Buffers: shared hit=442
Planning Time: 1.737 ms
Execution Time: 12.653 ms
```

**AFTER** (with `dna_records_status_createdAt_idx`):
```
Limit  (cost=0.29..184.15 rows=500 width=49) (actual time=0.107..0.487 rows=500 loops=1)
  Buffers: shared hit=49
  ->  Index Scan using "dna_records_status_createdAt_idx" on dna_records  (cost=0.29..1841.14 rows=5006 width=49) (actual time=0.105..0.431 rows=500 loops=1)
        Index Cond: (status = 'COMPLETE'::"DnaStatus")
        Buffers: shared hit=49
Planning Time: 1.075 ms
Execution Time: 0.607 ms
```

| Metric | Before | After |
|---:|---:|---:|
| Execution time | 12.653 ms | 0.607 ms |
| Buffer hits | 442 | 49 |
| Index usage | None — sequential scan | `dna_records_status_createdAt_idx`, index scan |

**Measured improvement: ~20.8x faster execution, ~9x fewer buffer accesses**, on this 25,000-row synthetic
dataset.

## 4. Exchange — `pinitCodeExpr(seller_pinit_id)` Expression Index — DB-GAP-25

**Setup:** an isolated, throwaway Postgres schema (dropped immediately after this test, never the real
`exchange` schema) replicating only the relevant columns of `orders_sealed`, with the **exact same indexes
production currently has on this table** (`idx_ex_orders_buyer`, `idx_ex_orders_asset` — nothing on
`seller_pinit_id`). Seeded 40,000 rows across 400 sellers in production's real `PINIT-EX-xxxxx` id format.

**BEFORE** (production's actual current state — no index on `seller_pinit_id` at all):
```
Sort  (cost=1531.64..1532.14 rows=200 width=26) (actual time=79.765..79.774 rows=100 loops=1)
  Sort Key: sealed_at DESC
  Buffers: shared hit=524
  ->  Seq Scan on orders_sealed  (cost=0.00..1524.00 rows=200 width=26) (actual time=9.209..79.224 rows=100 loops=1)
        Filter: (replace(replace(replace(replace(upper(seller_pinit_id), 'PINIT-EX-', ''), 'PINIT-USER-', ''), 'PINIT-ORG-', ''), 'PINIT-', '') = '00200')
        Rows Removed by Filter: 39900
        Buffers: shared hit=524
Execution Time: 79.974 ms
```

**CONTROL** (a plain, non-expression index added on the raw `seller_pinit_id` column — the fix someone might
reasonably try without this finding):
```
Sort  (cost=1531.64..1532.14 rows=200 width=26) (actual time=99.498..99.508 rows=100 loops=1)
  Sort Key: sealed_at DESC
  Buffers: shared hit=524
  ->  Seq Scan on orders_sealed  (cost=0.00..1524.00 rows=200 width=26) (actual time=0.260..98.948 rows=100 loops=1)
        Filter: (replace(replace(replace(replace(upper(seller_pinit_id), ...)) = '00200')
        Rows Removed by Filter: 39900
        Buffers: shared hit=524
Execution Time: 99.628 ms
```
**The plain index is not used at all** — confirmed: still a sequential scan, execution time actually slightly
*higher* than the no-index case (within normal run-to-run noise for an unused index that nonetheless costs
nothing at read time — the point is it provides **zero** benefit, not that it makes things worse).

**AFTER** (expression index matching `pinitCodeExpr(seller_pinit_id)` exactly):
```
Sort  (cost=263.24..263.49 rows=100 width=26) (actual time=0.545..0.554 rows=100 loops=1)
  Sort Key: sealed_at DESC
  Buffers: shared hit=100 read=2
  ->  Bitmap Heap Scan on orders_sealed  (cost=5.07..259.92 rows=100 width=26) (actual time=0.251..0.468 rows=100 loops=1)
        Recheck Cond: (replace(replace(replace(replace(upper(seller_pinit_id), ...)) = '00200')
        Heap Blocks: exact=100
        Buffers: shared hit=100 read=2
        ->  Bitmap Index Scan on idx_ex_orders_seller_code  (cost=0.00..5.04 rows=100 width=0) (actual time=0.221..0.222 rows=100 loops=1)
              Index Cond: (replace(replace(replace(replace(upper(seller_pinit_id), ...)) = '00200')
              Buffers: shared read=2
Execution Time: 0.771 ms
```

| Metric | Before (no index) | Control (plain index, unused) | After (expression index) |
|---:|---:|---:|---:|
| Execution time | 79.974 ms | 99.628 ms | 0.771 ms |
| Buffer hits | 524 | 524 | 102 |
| Index usage | None | **None — plain index not usable** | `idx_ex_orders_seller_code`, bitmap index scan |

**Measured improvement: ~104x faster than no index, ~129x faster than a (useless) plain index**, on a
40,000-row synthetic dataset in an isolated replica schema — **not the real Exchange schema**, stated
explicitly as a limitation of this evidence.

## 5. What Was Not Measured

- **Exchange's `listings`, `payouts`, `seller_payout_accounts`** — the same `pinitCodeExpr` defeat is
  confirmed by direct code inspection (§`PHASE_2_3_QUERY_OPTIMIZATION_AND_PAGINATION_REPORT.md` §1) but was
  **not independently benchmarked** this phase; the `orders_sealed` case stands as the representative,
  proven example. Labeled `Not measured — time-boxed to one representative case` rather than assumed
  identical.
- **DB-GAP-09** (`local-dna-index.service.ts` N+1) — **Not measured — representative database unavailable.**
  No vault-size distribution data exists anywhere in this repository; a synthetic benchmark here would
  require guessing a realistic vault-file-count-per-user distribution, which this report declines to invent.
- **Production query-plan evidence for any finding** — **Not measured — no production `EXPLAIN` access was
  used or available to this phase**, consistent with the master prompt's explicit restriction against
  profiling a shared production database without separate authorization.
- **Real production row counts, for any table** — **Not measured — this remains a Phase 2.5 data-volume
  measurement task**, identical to Phase 2.1's own stated gap.

## 6. Verdict

Four real, reproducible, measured before/after results were obtained this phase — three on Hub's local dev
database, one on an isolated Exchange-structure replica — all using the project's existing safe local
infrastructure, none against production or staging. Every improvement figure above is copy-pasted from real
`EXPLAIN (ANALYZE, BUFFERS)` output; none is estimated, extrapolated to production scale, or presented as a
production guarantee.
