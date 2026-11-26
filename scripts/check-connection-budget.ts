/**
 * Phase 3 — Connection-budget guard.
 * Phase 5 — extended to include worker-process demand (src/worker.ts), which
 * holds its own Prisma connection pool (same connection_limit default as
 * Hub/Exchange — src/lib/prisma.ts's withSafePoolParams() default of 10 —
 * since the worker imports the same prisma module) and was previously
 * missing entirely from this budget, understating total demand for any
 * deployment that runs one or more worker instances alongside Hub/Exchange.
 *
 * Fails fast if a planned deployment's total database connection demand
 * (instances x per-instance connection_limit, across Hub, Exchange, and now
 * Worker) would exceed the conservative safe budget established in
 * Production Readiness DB-GAP-34 (53 of 60).
 *
 * Usage: ts-node scripts/check-connection-budget.ts --hub=2 --exchange=2 --worker=2 \
 *          [--limit=10] [--worker-limit=10] [--budget=53]
 */

interface BudgetInput {
  hubInstances: number;
  exchangeInstances: number;
  workerInstances: number;
  perInstanceLimit: number;
  workerPerInstanceLimit: number;
  safeBudget: number;
}

export function parseArgs(argv: string[]): BudgetInput {
  const get = (name: string, fallback: number): number => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    if (!arg) return fallback;
    const value = Number(arg.split('=')[1]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid value for --${name}`);
    }
    return value;
  };

  return {
    hubInstances: get('hub', 1),
    exchangeInstances: get('exchange', 1),
    workerInstances: get('worker', 0), // default 0 — no worker.ts instance runs in production today
    perInstanceLimit: get('limit', 10),
    workerPerInstanceLimit: get('worker-limit', 10),
    safeBudget: get('budget', 53),
  };
}

export interface BudgetResult {
  totalDemand: number;
  safeBudget: number;
  withinBudget: boolean;
  headroom: number;
}

export function evaluateBudget(input: BudgetInput): BudgetResult {
  const totalDemand =
    (input.hubInstances + input.exchangeInstances) * input.perInstanceLimit
    + input.workerInstances * input.workerPerInstanceLimit;
  const withinBudget = totalDemand <= input.safeBudget;
  return {
    totalDemand,
    safeBudget: input.safeBudget,
    withinBudget,
    headroom: input.safeBudget - totalDemand,
  };
}

function main(): void {
  const input = parseArgs(process.argv.slice(2));
  const result = evaluateBudget(input);

  console.log(
    `[connection-budget] hub=${input.hubInstances} exchange=${input.exchangeInstances} ` +
      `worker=${input.workerInstances} per-instance-limit=${input.perInstanceLimit} ` +
      `worker-per-instance-limit=${input.workerPerInstanceLimit} -> total demand ${result.totalDemand} ` +
      `vs safe budget ${result.safeBudget} (headroom ${result.headroom})`,
  );

  if (!result.withinBudget) {
    console.error(
      '[connection-budget] FAIL: planned deployment exceeds the conservative connection budget ' +
        '(Production Readiness DB-GAP-34). Lower per-instance connection_limit, reduce instance ' +
        'count, or confirm Supavisor transaction-mode pooling before deploying at this scale.',
    );
    process.exit(1);
  }

  console.log('[connection-budget] PASS');
}

if (require.main === module) {
  main();
}
