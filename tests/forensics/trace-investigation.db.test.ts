/**
 * Background Trace against a REAL (throwaway, local) database: the record exists before processing, duplicates and limits are enforced
 * by the database, nothing mixes between investigations, restarts end investigations honestly, and every outcome is announced exactly
 * once, after the result is saved.
 *
 * Needs TEST_DATABASE_URL pointing at a local Postgres that has run scripts/ensure-trace-investigations.cjs (the suite is skipped
 * otherwise, and the database guard refuses anything that looks like production). The analysis itself is stubbed: this suite is about
 * the surrounding system, not the matching, which is covered elsewhere and is not changed.
 */
import { describe, test, expect, jest, beforeEach, afterAll, beforeAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describeWithTestDatabase } from '../helpers/db-guard';
import { currentSignal, AbortedError } from '../../src/lib/cancellation';

const emitted: Array<Record<string, unknown>> = [];
const startedEvents: Array<Record<string, unknown>> = [];
let analysis: (input: { filePath: string; ownerUserId: string }) => Promise<unknown> = async () => ({});
let evidence: () => Promise<string | null> = async () => 'EVD-TEST-0001';
let atEmit: (e: Record<string, unknown>) => Promise<void> = async () => undefined;

jest.mock('../../src/services/forensics/unified-investigation.orchestrator', () => ({ unifiedInvestigationOrchestrator: { investigate: jest.fn() } }));
jest.mock('../../src/services/large-files/investigate-from-disk', () => ({
  detectMimeFromHead: jest.fn(async () => 'image/jpeg'),
  investigateFromDisk: jest.fn(async (input: { filePath: string; ownerUserId: string }) => analysis(input)),
}));
jest.mock('../../src/services/large-files/large-file-investigate.service', () => ({ defaultLargeInvestigateDeps: jest.fn(() => ({})) }));
jest.mock('../../src/services/evidence/investigation-evidence.service', () => ({
  recordInvestigationEvidence: jest.fn(async () => evidence()),
  buildReportSnapshot: jest.fn((r: Record<string, unknown>) => ({ ...r })),
}));
jest.mock('../../src/services/platform-events/trace-events', () => ({
  emitTraceStarted: jest.fn((e: Record<string, unknown>) => { startedEvents.push(e); }),
  emitTraceFinal: jest.fn((e: Record<string, unknown>) => { emitted.push(e); void atEmit(e); }),
}));

import { prisma } from '../../src/lib/prisma';
import {
  createTrace, getTrace, claimNext, finishTrace, failStalled, recoverAfterRestart, failOwnedForShutdown, listTraces, TraceLimitError, TRACE_INSTANCE_ID,
} from '../../src/services/forensics/trace-investigation.service';
import { traceRunner, buildStoredResult } from '../../src/services/forensics/trace-runner.service';

jest.setTimeout(60_000);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
let seq = 0;
function probe(bytes = 100): { path: string; size: number; sha: string } {
  seq++;
  const p = path.join(dir, `probe-${seq}.bin`);
  const buf = Buffer.alloc(bytes, seq);
  fs.writeFileSync(p, buf);
  return { path: p, size: bytes, sha: require('crypto').createHash('sha256').update(buf).digest('hex') };
}
async function make(user: string, opts: { bytes?: number; request?: string } = {}) {
  const f = probe(opts.bytes ?? 100);
  const r = await createTrace({ ownerUserId: user, clientRequestId: opts.request ?? `req-${user}-${seq}-${Date.now()}`, fileName: `copy-${seq}.jpg`, mimeType: 'image/jpeg', sizeBytes: f.size, sha256: f.sha, probePath: f.path, discovery: null });
  return { ...r, file: f };
}
const rows = async (): Promise<number> => Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT COUNT(*) AS n FROM trace_investigations'))[0]!.n);
async function until(id: string, owner: string, pred: (s: string) => boolean, ms = 20_000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const t = await getTrace(owner, id);
    if (t && pred(t.status)) return t.status;
    if (Date.now() > end) throw new Error(`timed out waiting; status is ${t?.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const finished = (s: string): boolean => ['COMPLETED', 'FAILED', 'INCONCLUSIVE'].includes(s);

const report = (id: string, verdict = 'VERIFIED_ORIGINAL', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  success: true, investigationId: id, investigatedAt: new Date().toISOString(),
  summary: { acceptanceVerdict: verdict, reportState: verdict === 'NOT_PINIT' ? 'NO_SIGNATURE' : 'VERIFIED' }, owner: { dnaRecordId: null, vaultId: null },
  outcome: { kind: verdict === 'NOT_PINIT' ? 'NOT_FOUND' : 'VERIFIED' }, ...extra,
});

describeWithTestDatabase('Background Trace', () => {
  beforeAll(async () => {
    process.env['TRACE_MAX_CONCURRENT'] = '2';
    await prisma.$executeRawUnsafe('DELETE FROM trace_investigations');
  });
  beforeEach(async () => {
    emitted.length = 0; startedEvents.length = 0;
    analysis = async (i) => report(`inv-${path.basename(i.filePath)}`);
    evidence = async () => 'EVD-TEST-0001';
    atEmit = async () => undefined;
    for (const k of ['TRACE_MAX_OUTSTANDING', 'TRACE_MAX_PER_USER', 'TRACE_MAX_QUEUED_BYTES', 'TRACE_JOB_TIMEOUT_MS']) delete process.env[k];
    await prisma.$executeRawUnsafe('DELETE FROM trace_investigations');
  });
  afterAll(async () => { traceRunner.stop(); await prisma.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

  describe('the record', () => {
    test('is stored as QUEUED before anything is processed, and can be read back by its owner only', async () => {
      const { trace, duplicate } = await make('u1');
      expect(duplicate).toBe(false);
      expect(trace.status).toBe('QUEUED');
      expect((await getTrace('u1', trace.id))!.status).toBe('QUEUED');
      expect(await getTrace('someone-else', trace.id)).toBeNull();
      expect((await listTraces('someone-else')).length).toBe(0);
    });
  });

  describe('duplicate protection (server side)', () => {
    test('the same click twice is one investigation', async () => {
      const a = await make('u1', { request: 'click-aaaaaaaa' });
      const again = await createTrace({ ownerUserId: 'u1', clientRequestId: 'click-aaaaaaaa', fileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 5, sha256: 'f'.repeat(64), probePath: a.file.path, discovery: null });
      expect(again.duplicate).toBe(true);
      expect(again.trace.id).toBe(a.trace.id);
      expect(await rows()).toBe(1);
    });

    test('the same file while it is still running returns the running one', async () => {
      const a = await make('u1');
      const b = await createTrace({ ownerUserId: 'u1', clientRequestId: 'another-click-1', fileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: a.file.size, sha256: a.file.sha, probePath: a.file.path, discovery: null });
      expect(b.duplicate).toBe(true);
      expect(b.trace.id).toBe(a.trace.id);
      expect(await rows()).toBe(1);
    });

    test('once it has finished, the same file can be started again on purpose', async () => {
      const a = await make('u1');
      await finishTrace(a.trace.id, { status: 'COMPLETED' });
      const again = await createTrace({ ownerUserId: 'u1', clientRequestId: 'second-run-001', fileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: a.file.size, sha256: a.file.sha, probePath: a.file.path, discovery: null });
      expect(again.duplicate).toBe(false);
      expect(await rows()).toBe(2);
    });

    test('ten simultaneous requests for the same file create exactly one investigation', async () => {
      const f = probe();
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => createTrace({ ownerUserId: 'u1', clientRequestId: `race-click-${i}-xx`, fileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: f.size, sha256: f.sha, probePath: f.path, discovery: null })));
      expect(await rows()).toBe(1);
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(results.map((r) => r.trace.id)).size).toBe(1);
    });
  });

  describe('limits', () => {
    test('a user may have 1 processing and 2 queued, and no more', async () => {
      await make('u1'); await make('u1'); await make('u1');
      await expect(make('u1')).rejects.toMatchObject({ name: 'TraceLimitError', code: 'USER_LIMIT' });
      await make('u2'); // another person is not affected
      expect(await rows()).toBe(4);
    });

    test('the global limit refuses further investigations when the server is full', async () => {
      process.env['TRACE_MAX_OUTSTANDING'] = '2';
      await make('u1'); await make('u2');
      await expect(make('u3')).rejects.toBeInstanceOf(TraceLimitError);
      await expect(make('u3')).rejects.toMatchObject({ code: 'BUSY' });
    });

    test('the queued-bytes cap protects the disk', async () => {
      process.env['TRACE_MAX_QUEUED_BYTES'] = '1000';
      await make('u1', { bytes: 600 });
      await expect(make('u2', { bytes: 600 })).rejects.toMatchObject({ code: 'DISK' });
    });
  });

  describe('the queue', () => {
    test('one processing per user, oldest first, and another user is not held up', async () => {
      const a1 = await make('ua'); const a2 = await make('ua'); const b1 = await make('ub');
      const first = await claimNext();
      const second = await claimNext();
      const third = await claimNext();
      expect([first!.id, second!.id]).toEqual([a1.trace.id, b1.trace.id]); // ua's first, then ub's: ua's second waits
      expect(third).toBeNull();
      await finishTrace(a1.trace.id, { status: 'COMPLETED' });
      expect((await claimNext())!.id).toBe(a2.trace.id);
    });

    test('a finished investigation never changes again', async () => {
      const a = await make('u1'); await claimNext();
      expect((await finishTrace(a.trace.id, { status: 'COMPLETED', evidenceCode: 'EVD-1' }))!.status).toBe('COMPLETED');
      expect(await finishTrace(a.trace.id, { status: 'FAILED', failureCode: 'ENGINE_ERROR' })).toBeNull();
      expect((await getTrace('u1', a.trace.id))!.status).toBe('COMPLETED');
    });
  });

  describe('interruptions are honest', () => {
    test('a processing investigation whose heartbeat stopped is failed as STALLED', async () => {
      const a = await make('u1'); await claimNext();
      await prisma.$executeRawUnsafe(`UPDATE trace_investigations SET "heartbeatAt" = NOW() - INTERVAL '5 minutes' WHERE id = '${a.trace.id}'`);
      const failed = await failStalled();
      expect(failed.map((f) => f.id)).toEqual([a.trace.id]);
      const t = (await getTrace('u1', a.trace.id))!;
      expect(t.status).toBe('FAILED');
      expect(t.failureCode).toBe('STALLED');
      expect(t.failureMessage).toMatch(/upload the file again/);
    });

    test('after a restart: another process\'s PROCESSING row fails, a waiting row with its file is adopted, one without its file fails', async () => {
      const running = await make('ua'); const waitingOk = await make('ub'); const waitingLost = await make('uc');
      await prisma.$executeRawUnsafe(`UPDATE trace_investigations SET status = 'PROCESSING', "instanceId" = 'old-process-1' WHERE id = '${running.trace.id}'`);
      await prisma.$executeRawUnsafe(`UPDATE trace_investigations SET "instanceId" = 'old-process-1' WHERE id IN ('${waitingOk.trace.id}','${waitingLost.trace.id}')`);
      fs.rmSync(waitingLost.file.path);
      const { failed, adopted } = await recoverAfterRestart();
      expect(adopted).toBe(1);
      expect(failed.map((f) => f.failureCode).sort()).toEqual(['FILE_LOST', 'INTERRUPTED']);
      expect((await getTrace('ub', waitingOk.trace.id))!.status).toBe('QUEUED');
      expect((await getTrace('ub', waitingOk.trace.id))!.instanceId).toBe(TRACE_INSTANCE_ID);
      expect((await getTrace('ua', running.trace.id))!.failureCode).toBe('INTERRUPTED');
    });

    test('a deploy ends this process\'s investigations as RESTART and removes their files', async () => {
      const a = await make('u1'); const b = await make('u2'); await claimNext();
      const ended = await failOwnedForShutdown();
      expect(ended).toHaveLength(2);
      for (const r of [a, b]) {
        const t = (await getTrace(r === a ? 'u1' : 'u2', r.trace.id))!;
        expect(t.status).toBe('FAILED');
        expect(t.failureCode).toBe('RESTART');
        expect(fs.existsSync(r.file.path)).toBe(false);
      }
    });
  });

  describe('the runner', () => {
    beforeAll(async () => { await traceRunner.start(); });

    test('completes an investigation: result saved, evidence saved, and exactly one notification, sent only after both are stored', async () => {
      let statusAtEmit = '', evidenceAtEmit: string | null = null;
      atEmit = async (e) => { const t = await getTrace('u1', String(e['caseId'])); statusAtEmit = t!.status; evidenceAtEmit = t!.evidenceCode; };
      const a = await make('u1');
      traceRunner.poke();
      expect(await until(a.trace.id, 'u1', finished)).toBe('COMPLETED');
      await new Promise((r) => setTimeout(r, 300));
      const t = (await getTrace('u1', a.trace.id))!;
      expect(t.evidenceCode).toBe('EVD-TEST-0001');
      expect(t.evidenceStatus).toBe('SAVED');
      expect(t.resultSnapshot).toBeTruthy();
      expect(t.reportInvestigationId).toMatch(/^inv-/);
      expect(t.probePath).toBeNull();
      expect(fs.existsSync(a.file.path)).toBe(false); // the probe is removed once it is done
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ outcome: 'COMPLETED', caseId: a.trace.id, evidenceCode: 'EVD-TEST-0001' });
      expect(statusAtEmit).toBe('COMPLETED');
      expect(evidenceAtEmit).toBe('EVD-TEST-0001');
      expect(startedEvents).toHaveLength(1);
    });

    test('"no match found" is a completed investigation', async () => {
      analysis = async (i) => report(`inv-${path.basename(i.filePath)}`, 'NOT_PINIT');
      const a = await make('u1');
      traceRunner.poke();
      expect(await until(a.trace.id, 'u1', finished)).toBe('COMPLETED');
      expect(emitted.at(-1)).toMatchObject({ outcome: 'COMPLETED' });
    });

    test('an analysis that could not finish is INCONCLUSIVE, with no evidence and one notification', async () => {
      analysis = async (i) => report(`inv-${path.basename(i.filePath)}`, 'INSUFFICIENT_EVIDENCE', { outcome: { kind: 'INCONCLUSIVE', reason: 'TIMEOUT' } });
      let evidenceCalls = 0; evidence = async () => { evidenceCalls++; return 'EVD-X'; };
      const a = await make('u1');
      traceRunner.poke();
      expect(await until(a.trace.id, 'u1', finished)).toBe('INCONCLUSIVE');
      await new Promise((r) => setTimeout(r, 300));
      const t = (await getTrace('u1', a.trace.id))!;
      expect(evidenceCalls).toBe(0);
      expect(t.evidenceStatus).toBe('SKIPPED');
      expect(t.resultSnapshot).toBeTruthy(); // it can still be opened and read
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ outcome: 'INCONCLUSIVE' });
    });

    test('an engine error is FAILED with a plain reason, never the raw error', async () => {
      analysis = async () => { throw new Error('PrismaClientKnownRequestError: connect ECONNREFUSED 10.0.0.5:5432 at SELECT * FROM secret'); };
      const a = await make('u1');
      traceRunner.poke();
      expect(await until(a.trace.id, 'u1', finished)).toBe('FAILED');
      await new Promise((r) => setTimeout(r, 300));
      const t = (await getTrace('u1', a.trace.id))!;
      expect(t.failureCode).toBe('ENGINE_ERROR');
      expect(JSON.stringify(t)).not.toMatch(/Prisma|ECONNREFUSED|SELECT|secret/);
      expect(emitted).toHaveLength(1);
      expect(JSON.stringify(emitted)).not.toMatch(/Prisma|ECONNREFUSED|SELECT|secret/);
      expect(emitted[0]).toMatchObject({ outcome: 'FAILED' });
    });

    test('a job that runs past its time limit ends as INCONCLUSIVE (could not finish), not as a result', async () => {
      process.env['TRACE_JOB_TIMEOUT_MS'] = '1000';
      analysis = () => new Promise((_, reject) => {
        const s = currentSignal();
        s?.addEventListener('abort', () => reject(new AbortedError('time limit')));
      });
      const a = await make('u1');
      traceRunner.poke();
      expect(await until(a.trace.id, 'u1', finished, 15_000)).toBe('INCONCLUSIVE');
      const t = (await getTrace('u1', a.trace.id))!;
      expect(t.outcome).toMatchObject({ kind: 'INCONCLUSIVE', reason: 'TIMEOUT' });
      expect(emitted).toHaveLength(1);
    });

    test('if the evidence cannot be saved the result is still kept, and the person is told exactly that', async () => {
      evidence = async () => null;
      const a = await make('u1');
      traceRunner.poke();
      expect(await until(a.trace.id, 'u1', finished, 30_000)).toBe('COMPLETED');
      await new Promise((r) => setTimeout(r, 300));
      const t = (await getTrace('u1', a.trace.id))!;
      expect(t.evidenceStatus).toBe('FAILED');
      expect(t.evidenceCode).toBeNull();
      expect(t.resultSnapshot).toBeTruthy();
      expect(emitted[0]).toMatchObject({ outcome: 'COMPLETED', evidenceSaved: false });
    });

    test('a file that is gone ends as FAILED (file lost)', async () => {
      const a = await make('u1');
      fs.rmSync(a.file.path);
      traceRunner.poke();
      expect(await until(a.trace.id, 'u1', finished)).toBe('FAILED');
      expect((await getTrace('u1', a.trace.id))!.failureCode).toBe('FILE_LOST');
    });

    test('several investigations never mix their results or their notifications', async () => {
      analysis = async (i) => { await new Promise((r) => setTimeout(r, 150)); return report(`inv-${path.basename(i.filePath)}-${i.ownerUserId}`); };
      const jobs = [await make('ua'), await make('ub'), await make('uc'), await make('ua')];
      traceRunner.poke();
      for (const j of jobs) await until(j.trace.id, j.trace.ownerUserId, finished);
      await new Promise((r) => setTimeout(r, 300));
      const seen = new Set<string>();
      for (const j of jobs) {
        const t = (await getTrace(j.trace.ownerUserId, j.trace.id))!;
        expect(t.status).toBe('COMPLETED');
        expect(t.reportInvestigationId).toContain(path.basename(j.file.path)); // each result came from its own file
        expect(t.reportInvestigationId).toContain(j.trace.ownerUserId);
        seen.add(t.reportInvestigationId!);
      }
      expect(seen.size).toBe(4);
      expect(emitted).toHaveLength(4);
      expect(new Set(emitted.map((e) => e['caseId'])).size).toBe(4);
    });
  });

  describe('large reports', () => {
    test('a report too big to keep whole keeps what a person reads, and says it was trimmed', () => {
      const huge = { ...report('inv-big'), heatmap: 'x'.repeat(900_000), extra: 'y'.repeat(900_000), summary: { acceptanceVerdict: 'POSSIBLE_MATCH' } };
      // The whole-report snapshot refuses (too large), as the real builder does above its size cap.
      (jest.requireMock('../../src/services/evidence/investigation-evidence.service') as { buildReportSnapshot: jest.Mock }).buildReportSnapshot.mockReturnValueOnce(null as never);
      const stored = buildStoredResult(huge as never)!;
      expect(stored).toBeTruthy();
      expect(stored['investigationId']).toBe('inv-big');
      expect(stored['summary']).toEqual({ acceptanceVerdict: 'POSSIBLE_MATCH' });
      expect(JSON.stringify(stored).length).toBeLessThan(700_000);
    });
  });
});
