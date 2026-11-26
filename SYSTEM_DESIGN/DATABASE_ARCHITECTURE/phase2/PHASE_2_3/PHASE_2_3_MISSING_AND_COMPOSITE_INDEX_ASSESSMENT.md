# Phase 2.3 — Missing and Composite Index Assessment

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44`
Report date: 2026-11-16

---

## 1. Candidate 1 — `ShareLink.ownerUserId` (carried from Phase 1 `APIPERF-H02` / Phase 2.1)

**Model inspection:** `ShareLink` (`prisma/schema.prisma:1628-1727`) has 9 `@@index` declarations (token,
vaultId, dnaRecordId, parentLinkId, shareRecipientId, forwardStatus, assetId, exchangeSealId,
reviewVersionId) and none on `ownerUserId`, which is declared `String?` (nullable).

**Migration history:** no migration ever added an index on this column; it has been absent since the model's
original creation migration.

**All queries using the field, independently re-walked:**

| Site | Shape |
|---|---|
| `src/services/home/home-pulse.service.ts:70-73` | `WHERE ownerUserId = ? ORDER BY createdAt DESC LIMIT 1000` — equality + sort |
| `src/api/controllers/profile.controller.ts:362-365` | Same shape, caller-controlled `limit` |
| `src/lib/tenant-scope.ts:88-91,200,216-219` | `WHERE id/token = ? AND ownerUserId = ?` — equality-only, authorization check |
| `src/services/intelligence/ask-pinit.service.ts:291-297,1036` | `OR` with `ownerUserId` equality; separately, `ownerUserId` equality **+** `createdAt: { gte }` range |
| `src/api/controllers/evidence-report.controller.ts:146,184,216` | `WHERE ownerUserId = ?`, **no `take`**, id-only projection |
| `src/api/controllers/profile.controller.ts:314` | `count({ where: { ownerUserId } })` |
| `src/services/share/share-link.service.ts:635-641` | `WHERE vaultId = ? AND ownerUserId = ? AND linkType = ? AND isActive = ?` — leads with `vaultId`, already indexed separately; this call site does not need a new index |

**Equality vs. range:** every real call site filters `ownerUserId` by equality. Two sites (`home-pulse`,
`ask-pinit.service.ts:1036`) additionally need `createdAt`, one as a sort key, one as a range filter.

**Sorting requirement:** `createdAt DESC`, in both the dashboard and the Profile page.

**Composite appropriateness:** **Yes — `(ownerUserId, createdAt)` is the correct shape**, not a plain
single-column index. `ownerUserId` must lead because it is the equality filter in every single real call
site; a composite with `ownerUserId` first also fully satisfies every equality-only call site (a composite
index serves a leading-column-only query exactly as well as a single-column index would).

**Overlapping index check:** none of the 9 existing indexes cover `ownerUserId` in any position — confirmed
no overlap.

**Uniqueness:** not required — a user may have arbitrarily many share links. Correctly left non-unique.

**Nullability effect:** `ownerUserId` is nullable. Checked where null occurs (`src/services/lifecycle/asset-resolver.ts:103`:
`if (link && (!link.ownerUserId || link.ownerUserId === owner))` treats a null owner as "no owner
restriction" — e.g. certain Exchange-licensed shares). A standard B-tree index still indexes `NULL` rows in
Postgres, but no application query ever filters `WHERE ownerUserId IS NULL` or needs to — every real
consumer filters for a **specific, non-null** owner. Nullability therefore does not reduce this index's
usefulness for any actual query.

**Write/storage overhead estimate:** one additional 2-column B-tree index on a table that already carries 9
others — the same order of overhead as any of those, not qualitatively different. Not independently
measurable in absolute bytes without production row counts (none available), consistent with this phase's
rule against fabricating a number that cannot be verified.

**Verdict: CONFIRMED REQUIRED.** Composite `(ownerUserId, createdAt)`, implemented and benchmarked (§
`PHASE_2_3_QUERY_PLAN_AND_BENCHMARK_REPORT.md`): 97.3ms sequential scan → 1.0ms index scan on a 45,000-row
local benchmark.

## 2. Candidate 2 — `BillingHistory.externalId` (carried from Phase 1 `APIPERF-H04` / Phase 2.1)

**Model inspection:** `BillingHistory` (`prisma/schema.prisma:2361-2383`) has indexes on `subscriptionId` and
`provider` only. `externalId` is `String?` (nullable).

**All queries using the field:**

| Site | Shape |
|---|---|
| `src/services/subscription/billing/razorpay.service.ts:561,678` | `WHERE externalId = ? AND provider = 'RAZORPAY'` |
| `src/services/subscription/billing/stripe.service.ts:275,395` | `WHERE externalId = ? AND provider = 'STRIPE'` |

Every real call site filters **both columns together**, always as an equality pair — this is a webhook
payment-confirmation idempotency check (prevents double-processing the same payment event), run on every
incoming Stripe/Razorpay webhook delivery.

**Equality vs. range:** equality-only on both columns.

**Sorting requirement:** none.

**Composite appropriateness:** **Yes — `(externalId, provider)`**, leading with `externalId` because it is
the far more selective of the two (each payment event has an effectively unique external id; `provider` has
only a handful of possible values and would be a poor leading column). The existing `provider`-only index is
not useful for this lookup (confirmed by this phase's own benchmark, §`PHASE_2_3_QUERY_PLAN_AND_BENCHMARK_REPORT.md`:
Postgres used a **bitmap scan via the provider index**, then filtered ~15,000 candidate rows down to one —
functionally a near-full scan of every row for that provider).

**Overlapping index check:** no existing index covers `externalId` in any position.

**Uniqueness:** not enforced as unique — `externalId` is theoretically unique per provider, but no schema
comment or application invariant confirms this is guaranteed by every provider's id format, and a wrongly
added unique constraint here would be a correctness risk if ever violated by legitimate data (e.g. a provider
reusing an id format across test/live modes). Left non-unique, matching the "do not silently turn an
ordinary index into a unique index" rule in this phase's own instructions.

**Nullability effect:** `externalId` is null for subscriptions with no external payment provider
(`provider: NONE`, e.g. manually-granted or free-tier history rows). These rows are never looked up by this
query shape, so nullability does not reduce the index's usefulness. A **partial index**
(`WHERE "externalId" IS NOT NULL`) was considered per Stage 10's partial-index guidance and would be a valid
refinement (smaller index, same query coverage) — not implemented this phase to keep the change minimal and
directly matching what was benchmarked; noted as a future refinement option, not a requirement.

**Write/storage overhead estimate:** one additional 2-column index; same category as the existing two.

**Verdict: CONFIRMED REQUIRED.** Composite `(externalId, provider)`, implemented and benchmarked: 15.7ms
bitmap-heap-scan → 0.15ms index scan on a 30,000-row local benchmark. This also closes the duplicate-webhook
double-processing risk Phase 2.1 flagged as a side benefit, since the lookup that guards against reprocessing
the same webhook event is now fast and exact rather than a near-full-table scan under load.

## 3. Candidate 3 — `DnaRecord.status` + `createdAt` (carried from Phase 1 `APIPERF-M03` / Phase 2.1)

**Model inspection:** `DnaRecord` has indexes on `organizationId`, `ownerUserId`, `documentDnaRecordId`,
`videoDnaRecordId`, `sha256Hash` — none on `status` or `createdAt`.

**All queries using `status`, independently re-walked (this is the step Phase 2.1 did not have budget for):**

| Site | Shape | Relevant to this candidate? |
|---|---|---|
| `src/services/duplicate/duplicate-check.service.ts:191-194` | `WHERE sha256Hash = ? AND status IN (...)` | **No** — leads with the already-indexed, highly-selective `sha256Hash`; `status` is a secondary in-memory filter on an already-tiny result set |
| `src/services/large-files/large-file-investigate.service.ts:161-162` | `WHERE sha256Hash = ? AND ownerUserId = ? AND status IN (...)` | **No** — same reasoning |
| `src/services/forensics/leaked-file-verify.service.ts:1089-1090` | `WHERE sha256Hash = ? AND ownerUserId = ? AND status IN (...)` | **No** |
| `src/services/scan/public-scan.service.ts:367-368,399-400` | `WHERE id IN (...) AND status IN (...)` / `WHERE id = ? AND status IN (...)` | **No** — keyed on `id`, the primary key |
| `src/services/scan/public-scan-direct.ts:47-48` | `WHERE sha256Hash = ? AND status IN (...)` | **No** |
| `src/api/controllers/monitoring.controller.ts:173-177` | `WHERE status IN (...) AND ownerUserId = ?` | **No** — `ownerUserId` (already indexed) is the more useful discriminator; no `createdAt` sort |
| `src/api/controllers/super-admin/assets.ts:111-124` (`listAllDna`) | `WHERE status = ? (optional) ORDER BY createdAt DESC LIMIT 500` | **Yes — this is the one real match** |

Of seven call sites that touch `status`, **six** pair it with an already-indexed, highly-selective column
(`sha256Hash`, `id`, or `ownerUserId`) and do not need this new composite. Only `listAllDna` matches the
candidate's exact shape.

**Composite appropriateness:** `(status, createdAt)` is correct **for the one confirmed consumer** —
`status` leads because the filter is optional (sometimes omitted entirely) while the sort is always present;
leading with `createdAt` would not let Postgres use the index for the filtered case efficiently when
`status` is also supplied.

**Overlapping index check:** no existing index covers either column.

**Uniqueness:** not applicable.

**Nullability:** `status` and `createdAt` are both non-nullable (`status` has a default, `createdAt` has
`@default(now())`) — no nullability effect to consider.

**Context that matters for prioritization:** `listAllDna` is a **super-admin-only** endpoint, bounded to 500
rows, not a high-traffic user-facing path. This is a real, confirmed-matching query — but with materially
lower traffic and urgency than DB-GAP-22/23.

**Verdict: CONFIRMED REQUIRED, LOW PRIORITY.** Composite `(status, createdAt)`, implemented and benchmarked:
12.7ms sequential scan → 0.6ms index scan on a 25,000-row local benchmark. Implemented alongside the other
two for consistency and because the benchmark evidence was already in hand, but correctly understood as the
least urgent of the three.

## 4. Summary Table

| Candidate | Verdict | Index | Priority |
|---|---|---|---|
| `ShareLink.ownerUserId` | Confirmed required — as a composite, not the originally-scoped single column | `(ownerUserId, createdAt)` | High — user-facing dashboard + Profile page |
| `BillingHistory.externalId` | Confirmed required — as a composite | `(externalId, provider)` | High — payment-webhook correctness/performance |
| `DnaRecord.status`+`createdAt` | Confirmed required, for exactly one real consumer | `(status, createdAt)` | Low — admin-only |

All three were re-evaluated independently against the *current* schema and source, not inherited from either
Phase 1 or Phase 2.1's "statically plausible" labeling — and all three now carry real, measured, local
`EXPLAIN (ANALYZE, BUFFERS)` evidence neither prior phase had access to.
