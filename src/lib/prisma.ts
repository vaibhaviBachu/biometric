/**
 * PINIT-DNA — Prisma Client Singleton
 *
 * Exports a single PrismaClient instance. In development, re-uses the instance
 * across hot-reloads to avoid exhausting the connection pool.
 */

import { PrismaClient } from '@prisma/client';
import { performance } from 'perf_hooks';
import { logger } from './logger';
import { recordQuery } from './request-timing';
import { withReadRetry } from './db-retry';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

/** Query logging is expensive and floods the event loop — opt in with PRISMA_LOG_QUERIES=1. */
const prismaLog: Array<{ emit: 'event'; level: 'query' | 'error' | 'warn' }> = [
  { emit: 'event', level: 'error' },
  { emit: 'event', level: 'warn' },
];
if (process.env['PRISMA_LOG_QUERIES'] === '1' || process.env['PRISMA_LOG_QUERIES'] === 'true') {
  prismaLog.unshift({ emit: 'event', level: 'query' });
}

function withSafePoolParams(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    // Keep pool modest so background jobs cannot starve interactive API requests.
    // (Phase 2.4/DB-GAP-29: this used to read `NODE_ENV === 'production' ? '10' : '10'`
    // — a dev/prod distinction that resolved to the same value on both branches, i.e.
    // dead code, re-confirmed from Phase 1's APIPERF-I02. Collapsed to one constant
    // rather than inventing a different production number with no load data behind
    // it; a real per-environment value is Phase 2.5's job once usage is measured.
    // Can still be overridden per-environment via DATABASE_URL's own query string.)
    if (!u.searchParams.has('connection_limit')) {
      u.searchParams.set('connection_limit', '10');
    }
    if (!u.searchParams.has('pool_timeout')) {
      u.searchParams.set('pool_timeout', '20');
    }
    // DB-GAP-28 (Phase 2.4): Phase 2.1 confirmed no statement_timeout existed
    // anywhere — only connection-pool *wait* time was bounded, not query
    // *execution* time once a connection was acquired, so one runaway query
    // could hold a pool slot indefinitely. 30s is a conservative first bound:
    // long enough not to kill legitimate slow admin/export/report queries
    // (audit.service.ts's own CSV export already caps at 10,000 rows, not
    // time), short enough that one stuck query cannot starve the pool
    // forever. Workload-specific tuning needs Phase 2.5's real latency data.
    //
    // A plain `?statement_timeout=30000` query param does NOT work — verified
    // directly: Prisma's Postgres connector does not translate that key into
    // a session GUC, and a `pg_sleep(5)` ran for its full 5s despite it being
    // set. The parameter Postgres's own libpq actually honors is `options`,
    // passed through Prisma's connector unmodified — confirmed by the same
    // `pg_sleep(5)` test instead erroring at ~2.1s with Postgres error 57014
    // ("canceling statement due to statement timeout") once `options` carries
    // `-c statement_timeout=<ms>`.
    if (!u.searchParams.has('options')) {
      u.searchParams.set('options', '-c statement_timeout=30000');
    }
    return u.toString();
  } catch {
    return url;
  }
}

const databaseUrl = withSafePoolParams(process.env['DATABASE_URL']);

const prismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: prismaLog,
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
  });

/** DNA records are immutable — hard deletes are blocked application-wide. */
if (!(globalForPrisma as { dnaGuardInstalled?: boolean }).dnaGuardInstalled) {
  prismaClient.$use(async (params, next) => {
    if (
      params.model === 'DnaRecord'
      && (params.action === 'delete' || params.action === 'deleteMany')
    ) {
      logger.error('Blocked DNA delete attempt', { action: params.action, args: params.args });
      throw new Error(
        'DNA_IMMUTABLE: DNA records cannot be deleted. Users may only delete vault files.',
      );
    }
    return next(params);
  });
  (globalForPrisma as { dnaGuardInstalled?: boolean }).dnaGuardInstalled = true;
}

/** Records how long each query takes, for the per-request timing line (lib/request-timing.ts). */
if (!(globalForPrisma as { timingInstalled?: boolean }).timingInstalled) {
  // PRISMA_SLOW_QUERY_MS (opt-in diagnostic): a query slower than this is logged with the project code that asked for it.
  const slowMs = Number(process.env['PRISMA_SLOW_QUERY_MS'] ?? '');
  prismaClient.$use(async (params, next) => {
    const start = performance.now();
    const caller = Number.isFinite(slowMs) && slowMs > 0 ? new Error().stack : undefined;
    try {
      return await next(params);
    } finally {
      const end = performance.now();
      recordQuery(`${params.model ?? 'raw'}.${params.action}`, start, end);
      if (caller && end - start >= slowMs) {
        const frames = caller.split('\n').filter((l) => /[\\/]src[\\/]/.test(l) && !/[\\/]lib[\\/]prisma\.ts/.test(l))
          .slice(0, 3).map((l) => l.trim().replace(/^at /, '').replace(/\(?[A-Z]:.*?[\\/]src[\\/]/, 'src/').replace(/\)$/, ''));
        // What was asked for identifies the caller when the stack does not (Prisma middleware loses the async caller).
        const args = (params.args ?? {}) as { where?: object; select?: object; include?: object };
        const shape = {
          where: args.where ? Object.keys(args.where) : undefined,
          select: args.select ? Object.keys(args.select).length > 12 ? `${Object.keys(args.select).length} fields` : Object.keys(args.select) : undefined,
          include: args.include ? Object.keys(args.include) : undefined,
        };
        logger.warn('[SlowQuery]', { query: `${params.model ?? 'raw'}.${params.action}`, ms: Math.round(end - start), from: frames, shape });
      }
    }
  });
  (globalForPrisma as { timingInstalled?: boolean }).timingInstalled = true;
}

/** A read that failed only because the connection dropped is retried once (writes never are). */
if (!(globalForPrisma as { retryInstalled?: boolean }).retryInstalled) {
  prismaClient.$use(async (params, next) => withReadRetry(params, () => next(params)));
  (globalForPrisma as { retryInstalled?: boolean }).retryInstalled = true;
}

export const prisma = prismaClient;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$on('error', (e: { message: string }) => logger.error('Prisma error', { message: e.message }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(prisma as any).$on('warn',  (e: { message: string }) => logger.warn('Prisma warning', { message: e.message }));

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
