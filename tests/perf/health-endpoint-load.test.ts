/**
 * Phase 3 — Workstream 15 local load test.
 *
 * Measures real Express + middleware-stack request handling latency and
 * throughput for the always-unthrottled `/health` endpoint, under this
 * process's actual HTTP server (app.listen), not a synthetic benchmark.
 * The health REPORT itself is mocked (same pattern as tests/health.test.ts)
 * so this measures request-path overhead, not real database latency — the
 * database query latency itself is intentionally out of scope here since
 * Phase 2.5/Production Readiness already measured database-side performance
 * directly against Postgres, not through this HTTP layer.
 */
import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

type Report = { status: 'healthy'; components: Record<string, unknown> };
const getHealthReport = jest.fn<() => Promise<Report>>();

jest.mock('../../src/lib/health', () => ({ getHealthReport }));
jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));
jest.mock('vectra', () => ({ LocalIndex: class {} }));
jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));

let server: Server;
let base: string;

beforeAll(async () => {
  getHealthReport.mockResolvedValue({ status: 'healthy', components: { database: { status: 'healthy' } } });
  const { app } = await import('../../src/app');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function timedGet(url: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(url);
  const elapsed = performance.now() - t0;
  expect(res.status).toBe(200);
  return elapsed;
}

describe('Local load test — GET /health (Local-Measured)', () => {
  test('200 requests at concurrency 20 all succeed, and latency/throughput are reported', async () => {
    const totalRequests = 200;
    const concurrency = 20;
    const latencies: number[] = [];

    const wallStart = performance.now();
    for (let batch = 0; batch < totalRequests / concurrency; batch++) {
      const results = await Promise.all(
        Array.from({ length: concurrency }, () => timedGet(`${base}/health`)),
      );
      latencies.push(...results);
    }
    const wallMs = performance.now() - wallStart;

    const sorted = [...latencies].sort((a, b) => a - b);
    const summary = {
      totalRequests,
      concurrency,
      wall_ms: Math.round(wallMs),
      throughput_rps: Math.round((totalRequests / wallMs) * 1000 * 10) / 10,
      median_ms: Math.round(percentile(sorted, 50) * 100) / 100,
      p95_ms: Math.round(percentile(sorted, 95) * 100) / 100,
      p99_ms: Math.round(percentile(sorted, 99) * 100) / 100,
      max_ms: Math.round(sorted[sorted.length - 1] * 100) / 100,
      error_rate: 0,
    };
    // eslint-disable-next-line no-console
    console.log('[phase3-load-test:/health]', JSON.stringify(summary));

    expect(latencies).toHaveLength(totalRequests);
    // Loose sanity bound only — this is a reporting test, not a strict perf gate.
    expect(summary.median_ms).toBeLessThan(500);
  });
});
