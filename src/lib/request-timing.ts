/**
 * Request timing: shows where the time of a slow API request went.
 *
 * For every request this records each database query (model.action and how long it took). When a request
 * takes longer than REQUEST_TIMING_MS (default 800 ms) one line is logged:
 *
 *   [Timing] GET /api/v1/vault/<id> 2140ms status=200 | db: 7 queries, 1680ms of waiting (summed 1980ms) |
 *   slowest: VaultRecord.findUnique 480ms, Asset.findFirst 410ms, MetadataLayer.findMany 390ms
 *
 * "of waiting" is the time during which at least one query was running (queries that overlap are counted
 * once), "summed" adds every query up. A request that is slow with few queries is slow outside the database
 * (decrypting, image work, a call to another service); one with many queries in a row is slow because of the
 * distance to the database.
 *
 * REQUEST_TIMING=off turns it off, REQUEST_TIMING=all logs every request (health and ping excluded).
 * Server-sent-event streams are never logged (they stay open on purpose).
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { performance } from 'perf_hooks';
import { logger } from './logger';
import { redactUrl } from './log-redaction';

interface QueryTiming {
  name: string;
  start: number;
  end: number;
}

const requestStore = new AsyncLocalStorage<{ queries: QueryTiming[] }>();

function mode(): 'off' | 'all' | 'slow' {
  const v = (process.env['REQUEST_TIMING'] ?? '').toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return 'off';
  if (v === 'all') return 'all';
  return 'slow';
}

function thresholdMs(): number {
  const n = Number(process.env['REQUEST_TIMING_MS']);
  return Number.isFinite(n) && n >= 0 ? n : 800;
}

/** Called by the Prisma hook for every query. Does nothing outside a request. */
export function recordQuery(name: string, start: number, end: number): void {
  requestStore.getStore()?.queries.push({ name, start, end });
}

/** Milliseconds during which at least one of the intervals was running (overlaps counted once). */
function unionMs(queries: QueryTiming[]): number {
  const sorted = [...queries].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = 0;
  let curEnd = -1;
  for (const q of sorted) {
    if (curEnd < 0 || q.start > curEnd) {
      if (curEnd >= 0) total += curEnd - curStart;
      curStart = q.start;
      curEnd = q.end;
    } else if (q.end > curEnd) {
      curEnd = q.end;
    }
  }
  if (curEnd >= 0) total += curEnd - curStart;
  return total;
}

export function requestTiming(req: Request, res: Response, next: NextFunction): void {
  const m = mode();
  if (m === 'off') {
    next();
    return;
  }
  const path = redactUrl(req.originalUrl.split('?')[0] ?? req.originalUrl); // no query string (it can carry tokens); share tokens in the path redacted
  if (path.endsWith('/ping') || path.endsWith('/health')) {
    next();
    return;
  }

  const startedAt = performance.now();
  const store = { queries: [] as QueryTiming[] };

  res.on('finish', () => {
    const total = performance.now() - startedAt;
    const type = String(res.getHeader('content-type') ?? '');
    const q = store.queries;
    if (type.includes('event-stream')) {
      // A stream (a Trace) is long by design, so its total time says little; its database work is what matters, and it was
      // never reported before (2026-11-17). One line: how many queries, how long the database was waited on, and which kinds.
      if (m === 'slow' && q.length === 0) return;
      const byKind = new Map<string, { n: number; ms: number }>();
      for (const x of q) { const k = byKind.get(x.name) ?? { n: 0, ms: 0 }; k.n++; k.ms += x.end - x.start; byKind.set(x.name, k); }
      const top = [...byKind.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)
        .map(([name, k]) => `${name} ×${k.n} ${Math.round(k.ms)}ms`).join(', ');
      logger.info(
        `[Timing] stream ${req.method} ${path} ${Math.round(total)}ms | db: ${q.length} queries, `
        + `${Math.round(unionMs(q))}ms of waiting (summed ${Math.round(q.reduce((s, x) => s + (x.end - x.start), 0))}ms)`
        + (top ? ` | by kind: ${top}` : ''),
      );
      return;
    }
    if (m === 'slow' && total < thresholdMs()) return;

    const summed = q.reduce((s, x) => s + (x.end - x.start), 0);
    const slowest = [...q]
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))
      .slice(0, 3)
      .map((x) => `${x.name} ${Math.round(x.end - x.start)}ms`)
      .join(', ');
    logger.info(
      `[Timing] ${req.method} ${path} ${Math.round(total)}ms status=${res.statusCode} | `
      + `db: ${q.length} queries, ${Math.round(unionMs(q))}ms of waiting (summed ${Math.round(summed)}ms)`
      + (slowest ? ` | slowest: ${slowest}` : ''),
    );
  });

  requestStore.run(store, next);
}
