/**
 * Time limits that STOP the work, not just stop waiting for it (2026-11-16: a 90 s limit "ended" the patch search while it went
 * on for minutes, a recall provider ran 347 s, and steps kept going after their Trace stage had given up).
 */
import { describe, test, expect, afterEach, afterAll, jest } from '@jest/globals';
import http from 'http';
import type { AddressInfo } from 'net';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { AbortedError, currentSignal, isAbortedError, runWithSignal, runWithoutSignal } from '../../src/lib/cancellation';
import { withDeadlineSoft } from '../../src/lib/safe-runner';
import { BackgroundQueue } from '../../src/lib/background-queue';
import { enterpriseRetrievalEngine } from '../../src/services/forensics/enterprise-retrieval-engine.service';
import { forensicImagePreprocessor } from '../../src/services/forensics/forensic-image-preprocessor.service';
import { vaultLocalDnaSearchService } from '../../src/services/forensics/vault-local-dna-search.service';
import { runEnterpriseCandidateProviders } from '../../src/services/forensics/enterprise-candidate-retrieval.service';
import { investigationPerformanceConfig } from '../../src/config/investigation-performance';
import { DnaComparisonService } from '../../src/services/verification/dna-comparison.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Work that only ends when its signal is aborted, the way the patch matcher does (it throws AbortedError). */
const untilAborted = () => new Promise<never>((_resolve, reject) => {
  const signal = currentSignal();
  if (!signal) return; // never ends: no signal to stop it
  signal.addEventListener('abort', () => reject(new AbortedError('stopped')), { once: true });
});

const savedProviderBudget = investigationPerformanceConfig.recallProviderBudgetMs;
afterEach(() => { jest.restoreAllMocks(); investigationPerformanceConfig.recallProviderBudgetMs = savedProviderBudget; });

describe('withDeadlineSoft', () => {
  test('in time: the value, and the work was not aborted', async () => {
    let seen: AbortSignal | undefined;
    const r = await withDeadlineSoft(async () => { seen = currentSignal(); return 7; }, 1_000, 'quick');
    expect(r).toBe(7);
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
  });

  test('too slow: null, AND the work\'s own signal is aborted so it stops', async () => {
    let seen: AbortSignal | undefined;
    const started = Date.now();
    const r = await withDeadlineSoft(async () => { seen = currentSignal(); return untilAborted(); }, 50, 'slow');
    expect(r).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(seen!.aborted).toBe(true);
  });

  test('the parent stopping (browser gone) stops the work too', async () => {
    const parent = new AbortController();
    let seen: AbortSignal | undefined;
    const p = runWithSignal(parent.signal, () => withDeadlineSoft(async () => { seen = currentSignal(); return untilAborted(); }, 10_000, 'child'));
    await sleep(20);
    parent.abort(new AbortedError('the client disconnected'));
    expect(await p).toBeNull();
    expect(seen!.aborted).toBe(true);
  });
});

describe('work that belongs to no request', () => {
  test('runWithoutSignal: no signal inside, including in what it starts later', async () => {
    const c = new AbortController();
    const seen = await runWithSignal(c.signal, async () => runWithoutSignal(async () => { await sleep(5); return currentSignal(); }));
    expect(seen).toBeUndefined();
  });

  test('a queued background job does not inherit the cancel signal of the request that queued it', async () => {
    const queue = new BackgroundQueue(() => ({ concurrency: 1, delayMs: 0, maxWaiting: 10, jobTimeoutMs: 0 }));
    const c = new AbortController();
    c.abort(new AbortedError('Trace stage timed out'));
    const seen = await runWithSignal(c.signal, () => queue.enqueue('k1', 'index', async () => currentSignal()));
    expect(seen).toBeUndefined();
  });
});

describe('the patch search retrieval', () => {
  test('stopped while probes are searched: "could not finish" (AbortedError), never an empty "no match"', async () => {
    jest.spyOn(forensicImagePreprocessor, 'generateVariants').mockResolvedValue([
      { label: 'original', buffer: Buffer.from('a'), mimeType: 'image/jpeg' },
      { label: 'normalized', buffer: Buffer.from('b'), mimeType: 'image/jpeg' },
    ] as never);
    jest.spyOn(vaultLocalDnaSearchService, 'search').mockImplementation(() => untilAborted());
    const c = new AbortController();
    const p = runWithSignal(c.signal, () => enterpriseRetrievalEngine.retrieve(Buffer.from('x'), 'image/jpeg', 'owner', { investigationFast: true }));
    await sleep(20);
    c.abort(new AbortedError('local_dna_search timed out'));
    const err = await p.then(() => null, (e: unknown) => e);
    expect(isAbortedError(err)).toBe(true);
  });

  test('already stopped before it starts: no probe is searched', async () => {
    jest.spyOn(forensicImagePreprocessor, 'generateVariants').mockResolvedValue([{ label: 'original', buffer: Buffer.from('a'), mimeType: 'image/jpeg' }] as never);
    const search = jest.spyOn(vaultLocalDnaSearchService, 'search');
    const c = new AbortController();
    c.abort(new AbortedError('gone'));
    const err = await runWithSignal(c.signal, () => enterpriseRetrievalEngine.retrieve(Buffer.from('x'), 'image/jpeg', 'owner', {})).then(() => null, (e: unknown) => e);
    expect(isAbortedError(err)).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });
});

describe('recall providers', () => {
  test('a provider that runs past its budget is stopped (its signal aborted) and the others still count', async () => {
    investigationPerformanceConfig.recallProviderBudgetMs = 60;
    let slowSignal: AbortSignal | undefined;
    const started = Date.now();
    const results = await runEnterpriseCandidateProviders([
      { name: 'local_feature', enabled: true, retrieve: async () => { slowSignal = currentSignal(); return untilAborted(); } },
      { name: 'metadata', enabled: true, retrieve: async () => [{ provider: 'metadata', vaultId: 'v1', dnaRecordId: 'd1', ownerUserId: 'o', retrievalConfidence: 50, method: 'm', signals: [] }] },
    ] as never);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(slowSignal!.aborted).toBe(true);
    expect(results[0]).toMatchObject({ provider: 'local_feature', candidates: [], error: 'stopped after 60ms' });
    expect(results[1]!.candidates).toHaveLength(1);
  });

  test('a provider that fails is still reported as failed (not as stopped)', async () => {
    const results = await runEnterpriseCandidateProviders([
      { name: 'ocr', enabled: true, retrieve: async () => { throw new Error('ocr down'); } },
    ] as never);
    expect(results[0]!.error).toContain('ocr down');
  });
});

describe('DNA comparison', () => {
  test('a comparison asked for after its stage was stopped does not start (no probe fingerprint, no database write)', async () => {
    const svc = new DnaComparisonService();
    const fingerprint = jest.spyOn((svc as unknown as { fingerprinter: { fingerprint: () => Promise<unknown> } }).fingerprinter, 'fingerprint');
    const c = new AbortController();
    c.abort(new AbortedError('deep compare timed out'));
    const file = { buffer: Buffer.from('x'), originalName: 'x.jpg', declaredMimeType: 'image/jpeg', sizeBytes: 1 };
    const err = await runWithSignal(c.signal, () => svc.compare(file as never, file as never)).then(() => null, (e: unknown) => e);
    expect(isAbortedError(err)).toBe(true);
    expect(fingerprint).not.toHaveBeenCalled();
  });
});

describe('AI calls', () => {
  // A local stand-in for the AI service that never answers /embed (so only a cancel can end the call).
  const hanging: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.end('{}'); return; }
    hanging.push(res);
  });
  afterAll(async () => { for (const r of hanging) r.destroy(); await new Promise((r) => server.close(r)); });

  test('a call made inside stopped work is cancelled, and a cancel is not counted against the AI service', async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env['AI_SERVICE_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A fresh module copy reads the address above; its own copy of lib/cancellation must be used to give it a signal.
    let aiService!: { embed(t: string): Promise<unknown>; _recentFailures: number[]; _isOnline: boolean };
    let isolatedRunWithSignal!: typeof runWithSignal;
    jest.isolateModules(() => {
      aiService = require('../../src/services/ai/ai-embeddings.service').aiService;
      isolatedRunWithSignal = require('../../src/lib/cancellation').runWithSignal;
    });
    aiService._isOnline = true;
    const c = new AbortController();
    const started = Date.now();
    const p = isolatedRunWithSignal(c.signal, () => aiService.embed('hello'));
    await sleep(50);
    c.abort(new AbortedError('Trace stage stopped'));
    expect(await p).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aiService._recentFailures).toEqual([]);
    expect(aiService._isOnline).toBe(true);
  });
});
