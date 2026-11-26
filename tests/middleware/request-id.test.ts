/**
 * PGAP-11 — request correlation middleware contract.
 *
 * No correlation-ID mechanism existed anywhere in this codebase before this
 * (confirmed by a repo-wide search for X-Request-ID/X-Correlation-ID/
 * req.requestId/trace-id conventions — none found). This pins the behavior
 * the new middleware (request-id.middleware.ts, mounted first in app.ts)
 * must provide: generate when absent, accept a well-formed incoming ID,
 * replace a malformed one rather than reject the request, always return it
 * in the response header (including on an auth-rejected request), isolate
 * concurrent requests from each other, and never let a client-supplied ID
 * influence any authentication or authorization decision.
 *
 * Boots the real app the same way tests/health.test.ts does — a real
 * listening server, real middleware stack, hit with plain fetch — so this
 * exercises the actual Express pipeline rather than a mocked stand-in.
 */
import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

type Report = { status: 'healthy' | 'degraded' | 'unhealthy'; components: Record<string, unknown> };
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
  getHealthReport.mockResolvedValue({ status: 'healthy', components: {} });
  const { app } = await import('../../src/app');
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('request-id middleware', () => {
  test('generates a request ID when none is supplied', async () => {
    const res = await fetch(`${base}/health`);
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id).toMatch(UUID_RE);
  });

  test('accepts and echoes back a well-formed incoming request ID', async () => {
    const mine = 'my-own-correlation-id-123';
    const res = await fetch(`${base}/health`, { headers: { 'X-Request-ID': mine } });
    expect(res.headers.get('x-request-id')).toBe(mine);
  });

  test('replaces a malformed incoming request ID rather than rejecting the request', async () => {
    // A literal newline is rejected by fetch's own Headers implementation
    // before the request is even sent (the most egregious injection attempt
    // never reaches the server to test against) — a space is still a legal
    // HTTP header byte, so this exercises the server's own validation.
    const malformed = 'contains a space; and a semicolon';
    const res = await fetch(`${base}/health`, { headers: { 'X-Request-ID': malformed } });
    expect(res.status).not.toBe(400);
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe(malformed);
    expect(id).toMatch(UUID_RE);
  });

  test('replaces an oversized incoming request ID', async () => {
    const oversized = 'a'.repeat(500);
    const res = await fetch(`${base}/health`, { headers: { 'X-Request-ID': oversized } });
    const id = res.headers.get('x-request-id');
    expect(id).not.toBe(oversized);
    expect(id).toMatch(UUID_RE);
  });

  test('concurrent requests receive different request IDs (no cross-request leakage)', async () => {
    const [a, b] = await Promise.all([fetch(`${base}/health`), fetch(`${base}/health`)]);
    const idA = a.headers.get('x-request-id');
    const idB = b.headers.get('x-request-id');
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });

  test('an error/auth-rejected response still carries a request ID', async () => {
    const res = await fetch(`${base}/api/v1/profile/government-id`);
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toMatch(UUID_RE);
  });

  test('a client-supplied request ID never grants or affects an authentication decision', async () => {
    // An attacker choosing their own "trusted-looking" correlation ID must
    // not be able to influence the 401 — the ID is for log correlation
    // only, and is still echoed back even on a rejected request.
    const attackerChosen = 'admin-trusted-session-override';
    const res = await fetch(`${base}/api/v1/profile/government-id`, {
      headers: { 'X-Request-ID': attackerChosen, Authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toBe(attackerChosen);
  });
});
