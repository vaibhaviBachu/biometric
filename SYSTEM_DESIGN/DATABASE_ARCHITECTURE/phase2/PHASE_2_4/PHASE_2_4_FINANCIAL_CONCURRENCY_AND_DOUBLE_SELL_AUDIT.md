# Phase 2.4 — Financial Concurrency and Double-Sell Audit

**PINITHUB / PINIT-DNA — Phase 2: Database Architecture & Optimization**
Branch `vaibhavi-new` · HEAD `395766f2825124778024c37f798da721418abc44` (unchanged by this report)
Report date: 2026-11-16

---

## 1. Methodology

Both financial workflows below were tested by exercising the **real, unmodified application code**
(`exchange/server/database.js`, `seal-order.js`, `payouts.js`, `db.js`) against the project's existing local
per-developer Docker Postgres, in an isolated schema created by the application's own boot sequence — never
a hand-simulated approximation of the logic, and never production or staging. Every test script and every
seeded row was deleted after use, verified by direct row counts afterward.

## 2. Workflow 1 — Exclusive-License Double-Sell (`seal-order.js`)

**Business invariant:** a listing must never be sold exclusively to more than one buyer.

**Call graph:** `sealListingSale()` → `withImmediateTransaction(...)`: reads the listing fresh, checks
`isListingPurchasable`, checks `asset_commerce_locks` for an existing lock, checks the listing isn't already
`sold_exclusive`, inserts the order, and — only for `licenseTier === 'exclusive'` — inserts a lock row keyed
`asset_commerce_locks.asset_id` (`TEXT PRIMARY KEY`) and updates the listing to `sold_exclusive`.

**Test 1 — two concurrent buyers, one exclusive listing:** ran once, then as a 10-round × 8-concurrent-buyer
stress test (80 total attempts) against the unfixed code.

**Result: 10/10 rounds safe** — exactly one buyer succeeded, exactly one `orders_sealed` row and one
`asset_commerce_locks` row existed afterward, every round, both before and after this phase's connection-pinning
fix.

**Why it was safe despite the real connection-pinning defect (§`PHASE_2_4_TRANSACTION_ARCHITECTURE_AND_INTEGRITY_REPORT.md`):**
`asset_commerce_locks.asset_id` is a genuine Postgres `PRIMARY KEY`. Postgres enforces primary-key uniqueness
at the statement level, independent of which connection sends the statement or whether a surrounding
"transaction" is really pinned — whichever concurrent `INSERT` reaches the table first wins; the second
throws a real `23505 unique_violation` regardless. This is an **incidental** safety net, not a designed one:
it protects this one invariant only because it happens to be backed by a real uniqueness constraint, not
because the surrounding code is correct.

**What this does NOT prove:** that Exchange's financial code is safe generally. The connection-pinning
defect is still real and still a genuine risk for any financial write that is *not* backed by an independent
uniqueness constraint — which is exactly what §3 found.

**Disposition:** the connection-pinning root cause is fixed regardless (§`PHASE_2_4_TRANSACTION_ARCHITECTURE_AND_INTEGRITY_REPORT.md`);
re-tested after the fix, still 10/10 safe, now for the structurally correct reason rather than by
incidental luck plus a lucky constraint.

## 3. Workflow 2 — Double Payout (`payouts.js` withdrawal) — The Real Financial Defect Found This Phase

**Business invariant:** a seller's accrued earnings must be paid out at most once.

**Call graph (verbatim from source):** `withImmediateTransaction(...)`: `SELECT` every `seller_earnings` row
for this seller where `status = 'accrued' AND payout_id IS NULL`, sum `net_amount`, `INSERT` a new `payouts`
row for that sum, `UPDATE seller_earnings SET payout_id = ? WHERE id IN (...) AND payout_id IS NULL`. The
code **did not check how many rows that `UPDATE` actually affected** before returning success.

**Test: two concurrent withdrawal requests, same seller, $425 of real unclaimed earnings (5 rows × $85).**

**Result on the unfixed code — reproduced on the first attempt, no stress-testing needed:**

```
Results: [
  { "ok": true, "payoutId": "PO-8ddb58ff-...", "amount": 425, "count": 5 },
  { "ok": true, "payoutId": "PO-04f51f92-...", "amount": 425, "count": 5 }
]
payouts rows created: 2 rows, $425 each = $850 total
seller_earnings: all 5 rows linked to only the FIRST payout
VERDICT: UNSAFE — $850 of payout committed against only $425 of real earnings.
```

**Exact mechanism:** both concurrent requests' `SELECT` ran before either had updated anything, so both saw
the same $425 unclaimed and both computed the same amount. Both unconditionally `INSERT`ed a `payouts` row
for $425 — nothing prevents two payout rows from existing. The first request's `UPDATE` correctly linked all
5 earnings rows to its payout. The second request's `UPDATE` then matched **zero** rows (its `WHERE ...
payout_id IS NULL` correctly found them already claimed) — but the code never checked this, so it returned
success anyway, with a `payouts` row claiming $425 that was never actually backed by any linked earnings.
**If payouts are ever processed by reading the `payouts` table and transferring `amount` to the seller's
bank account, this would pay the seller twice for the same underlying $425.**

**This is independent of, and not fixed by, the connection-pinning repair alone.** Even with a fully pinned,
real transaction under Postgres's default `READ COMMITTED` isolation, both transactions' `SELECT`s would
still see the same unclaimed set (a `SELECT` does not block a concurrent `SELECT`), and both would still
`INSERT` a `payouts` row — the missing row-count check was the actual gap.

**Fix implemented:** `payouts.js` now checks the `UPDATE`'s own reported row count against `rows.length`
and throws (aborting the whole transaction, including the `payouts` `INSERT`) on any mismatch:

```js
if ((linked?.changes ?? 0) !== rows.length) {
  const err = new Error('Earnings changed while requesting this withdrawal. Please try again.');
  err.status = 409; err.code = 'WITHDRAWAL_CONFLICT';
  throw err;
}
```

This works correctly under `READ COMMITTED` because `UPDATE`'s own row-level locking causes a concurrent
second `UPDATE` targeting the same rows to **wait** for the first transaction to resolve, then re-evaluate
its `WHERE` clause against the now-committed state — seeing the rows are no longer `payout_id IS NULL`, and
correctly affecting zero rows. The row-count check turns that correct-but-silent zero into a correct,
loud abort.

**Re-tested after both fixes (pinning + row-count check):**

```
Results: [
  { "ok": true, "payoutId": "PO-b58b529b-...", "amount": 425, "count": 5 },
  { "ok": false, "error": "Nothing is available to withdraw." }
]
payouts rows created: 1 row, $425
Total underlying earnings: $425. Total payout rows requested: $425.
VERDICT: SAFE.
```

(The loser received the earlier, unrelated "nothing available" rejection in this particular run rather than
the new `WITHDRAWAL_CONFLICT` — both are correct outcomes depending on exact timing; which one fires is not
load-bearing for the safety property, only that the sum of committed payouts never exceeds real earnings,
which now holds.)

## 4. Rollback and Retry Behavior

**Rollback:** re-confirmed after the fix — an aborted transaction (either path) now genuinely rolls back via
the one pinned client, including the `payouts` `INSERT`, not just whatever happened to share its connection
by chance.

**Retry safety:** neither workflow is retried automatically anywhere in the code (no retry wrapper was found
around either `withImmediateTransaction` call). No change was needed here; this phase did not introduce any
automatic retry of a non-idempotent write.

**Duplicate webhook delivery:** `recordBridgeEvent`'s `idempotencyKey`-based dedup (used by `sealListingSale`
for the `SOLD` bridge event) was re-confirmed present and unchanged — a second delivery of the same
`paymentIntentId`/`orderId` combination returns the existing row rather than reprocessing. Not touched or
retested this phase beyond re-reading the code, since it was not implicated in either finding above.

## 5. Verdict

**One confirmed, severe, previously-undocumented financial defect (the double-payout race) was found,
reproduced, fixed, and re-verified.** The double-sell path, while resting on a real underlying architectural
defect, was found to be incidentally protected by an unrelated database constraint — documented honestly as
such rather than either overstating the risk or understating the underlying code quality issue.
