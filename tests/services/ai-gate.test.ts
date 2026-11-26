/**
 * The line in front of the AI service's heavy /cv/* endpoints (src/services/ai/ai-gate.ts).
 *
 * 2026-11-16: a Trace sent ~30 /cv/* requests at once to a service that runs 3 at a time; the rest waited inside it while their
 * 25 s timeouts ran, and three timed out although the service was healthy. Now they wait in Node, the timeout starts when a
 * request is sent, and neither a long wait nor a cancel counts against the AI service.
 */
import { describe, test, expect, afterAll, jest } from '@jest/globals';
import http from 'http';
import type { AddressInfo } from 'net';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { AiGate, AiQueueTimeoutError, isGatedAiPath } from '../../src/services/ai/ai-gate';
import { AbortedError, isAbortedError } from '../../src/lib/cancellation';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AiGate', () => {
  test('never more than the limit at once; the slot passes to the next in line', async () => {
    const gate = new AiGate(() => 2, () => 10_000);
    let inFlight = 0; let peak = 0;
    await Promise.all(Array.from({ length: 7 }, async () => {
      const release = await gate.acquire();
      inFlight++; peak = Math.max(peak, inFlight);
      await sleep(15);
      inFlight--; release();
    }));
    expect(peak).toBe(2);
    expect(gate.stats()).toMatchObject({ running: 0, waiting: 0 });
  });

  test('a release called twice frees one slot only', async () => {
    const gate = new AiGate(() => 1, () => 10_000);
    const release = await gate.acquire();
    release(); release();
    const a = await gate.acquire();
    let second = false;
    void gate.acquire().then(() => { second = true; });
    await sleep(10);
    expect(second).toBe(false);
    a();
    await sleep(5);
    expect(second).toBe(true);
  });

  test('waiting longer than the limit: AiQueueTimeoutError, and it leaves the line', async () => {
    const gate = new AiGate(() => 1, () => 30);
    const hold = await gate.acquire();
    await expect(gate.acquire()).rejects.toBeInstanceOf(AiQueueTimeoutError);
    expect(gate.stats()).toMatchObject({ waiting: 0, refusedTimeout: 1 });
    hold();
  });

  test('stopped work leaves the line at once (and an already stopped one never queues)', async () => {
    const gate = new AiGate(() => 1, () => 10_000);
    const hold = await gate.acquire();
    const c = new AbortController();
    const waiting = gate.acquire(c.signal);
    c.abort(new AbortedError('Trace stage stopped'));
    expect(isAbortedError(await waiting.then(() => null, (e: unknown) => e))).toBe(true);
    expect(gate.stats().waiting).toBe(0);
    expect(isAbortedError(await gate.acquire(c.signal).then(() => null, (e: unknown) => e))).toBe(true);
    hold();
  });

  test('only the heavy computer-vision paths are gated', () => {
    expect(isGatedAiPath('/cv/compare')).toBe(true);
    expect(isGatedAiPath('cv/local-source-score')).toBe(true);
    expect(isGatedAiPath('/health')).toBe(false);
    expect(isGatedAiPath('/similar')).toBe(false);
    expect(isGatedAiPath('/embed')).toBe(false);
  });
});

describe('the AI client behind the line (real HTTP, local stand-in service)', () => {
  let inFlight = 0; let peak = 0; let delayMs = 150;
  const held: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/health') { res.end('{}'); return; }
      if (delayMs < 0) { held.push(res); return; } // never answers
      inFlight++; peak = Math.max(peak, inFlight);
      setTimeout(() => { inFlight--; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ similarity: 0.5, method: 'orb' })); }, delayMs);
    });
  });
  afterAll(async () => { for (const r of held) r.destroy(); await new Promise((r) => server.close(r)); });

  type Svc = { compareImages(a: Buffer, b: Buffer): Promise<unknown>; _recentFailures: number[]; _isOnline: boolean };
  async function loadService(env: Record<string, string>): Promise<Svc> {
    if (!server.listening) await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env['AI_SERVICE_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    Object.assign(process.env, env);
    let svc!: Svc;
    jest.isolateModules(() => { svc = require('../../src/services/ai/ai-embeddings.service').aiService; });
    svc._isOnline = true;
    return svc;
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  test('10 compares at once: at most AI_CV_MAX_PARALLEL reach the service together, and all succeed', async () => {
    inFlight = 0; peak = 0; delayMs = 150;
    const svc = await loadService({ AI_CV_MAX_PARALLEL: '3', AI_CV_QUEUE_WAIT_MS: '60000' });
    const results = await Promise.all(Array.from({ length: 10 }, () => svc.compareImages(png, png)));
    expect(results.every((r) => r && (r as { similarity: number }).similarity === 0.5)).toBe(true);
    expect(peak).toBe(3);
  });

  test('a request that waited too long in line is not sent and does not count against the AI service', async () => {
    delayMs = -1; // the first request occupies the only slot and is never answered
    const svc = await loadService({ AI_CV_MAX_PARALLEL: '1', AI_CV_QUEUE_WAIT_MS: '100' });
    void svc.compareImages(png, png);
    await sleep(50);
    const started = Date.now();
    expect(await svc.compareImages(png, png)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(svc._recentFailures).toEqual([]);
    expect(svc._isOnline).toBe(true);
    delayMs = 150;
  });
});
