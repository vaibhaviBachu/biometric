/**
 * A database read that fails because the connection dropped (the link to the database blinked, the pooler closed an
 * idle connection) is tried once more on a fresh connection instead of becoming a 500. Only reads are retried: a write
 * that failed half-way must never be sent twice.
 */

const READ_ACTIONS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
]);

const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

const TRANSIENT_MESSAGE =
  /Can't reach database server|Server has closed the connection|Connection reset|forcibly closed|Error in PostgreSQL connection/i;

export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return TRANSIENT_MESSAGE.test(message);
}

export const DB_RETRY_DELAY_MS = 300;

type MiddlewareParams = { action: string; runInTransaction?: boolean };

export async function withReadRetry<T>(
  params: MiddlewareParams,
  run: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    // A retry inside an open transaction cannot help: the transaction is gone with its connection.
    if (!READ_ACTIONS.has(params.action) || params.runInTransaction || !isTransientDbError(err)) throw err;
    await sleep(DB_RETRY_DELAY_MS);
    return run();
  }
}
