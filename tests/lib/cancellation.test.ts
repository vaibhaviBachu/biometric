/** Deadlines that carry a signal, and loops that stop when it fires. */
import { describe, test, expect } from '@jest/globals';
import {
  AbortedError, abortOnDisconnect, createDeadline, createYielder, currentSignal, isAbortedError, runWithSignal, throwIfAborted,
} from '../../src/lib/cancellation';
import { executeStage } from '../../src/services/forensics/investigation-stage.executor';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('createDeadline', () => {
  test('aborts after the time, and cancel() stops it', async () => {
    const d = createDeadline(30, 'x');
    expect(d.signal.aborted).toBe(false);
    await sleep(60);
    expect(d.signal.aborted).toBe(true);
    expect(isAbortedError(d.signal.reason)).toBe(true);

    const kept = createDeadline(30, 'y');
    kept.cancel();
    await sleep(60);
    expect(kept.signal.aborted).toBe(false);
  });

  test('aborts when its parent aborts', () => {
    const parent = new AbortController();
    const child = createDeadline(10_000, 'child', parent.signal);
    parent.abort(new AbortedError('request closed'));
    expect(child.signal.aborted).toBe(true);
    child.cancel();
  });

  test('abort() stops it at once', () => {
    const d = createDeadline(10_000, 'z');
    d.abort('gone');
    expect(d.signal.aborted).toBe(true);
  });
});

describe('runWithSignal and currentSignal', () => {
  test('the signal follows the async call chain', async () => {
    const c = new AbortController();
    expect(currentSignal()).toBeUndefined();
    const seen = await runWithSignal(c.signal, async () => {
      await sleep(1);
      return currentSignal();
    });
    expect(seen).toBe(c.signal);
    expect(currentSignal()).toBeUndefined();
  });
});

describe('createYielder', () => {
  test('gives the event loop a turn when a slice is used up, and throws once aborted', async () => {
    const c = new AbortController();
    const maybeYield = createYielder(2, c.signal);
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 1);
    const end = Date.now() + 15;
    while (Date.now() < end) { /* a busy loop longer than a slice */ }
    await maybeYield();
    await sleep(0);
    expect(timerFired).toBe(true);
    c.abort(new AbortedError('stop'));
    await expect(maybeYield()).rejects.toBeInstanceOf(AbortedError);
    expect(() => throwIfAborted(c.signal)).toThrow(AbortedError);
  });
});

describe('abortOnDisconnect', () => {
  test('aborts when the connection closes before the answer ended, not after', () => {
    const handlers: Array<() => void> = [];
    const res = { writableEnded: false, once: (_e: 'close', cb: () => void) => { handlers.push(cb); } };
    const signal = abortOnDisconnect(res);
    res.writableEnded = true;
    handlers[0]!();
    expect(signal.aborted).toBe(false);

    const res2 = { writableEnded: false, once: (_e: 'close', cb: () => void) => { handlers.push(cb); } };
    const signal2 = abortOnDisconnect(res2);
    handlers[1]!();
    expect(signal2.aborted).toBe(true);
  });
});

describe('executeStage deadlines', () => {
  /** A stage that loops and checks the signal, like the patch search. Returns how many turns it took before it stopped. */
  const loopingStage = (counter: { n: number; stopped: boolean }) => async () => {
    const maybeYield = createYielder(1);
    try {
      for (;;) {
        counter.n++;
        await maybeYield();
        await sleep(2);
        if (counter.n > 2000) return 'ran away';
      }
    } catch (err) {
      counter.stopped = isAbortedError(err);
      throw err;
    }
  };

  test('a timed-out stage is told to stop (FORENSIC_DEADLINES on)', async () => {
    const counter = { n: 0, stopped: false };
    const result = await executeStage('slow', loopingStage(counter), { timeoutMs: 60 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
    const atTimeout = counter.n;
    await sleep(80);
    expect(counter.stopped).toBe(true);
    expect(counter.n - atTimeout).toBeLessThanOrEqual(3); // it stopped; it did not keep running
  });

  test('with FORENSIC_DEADLINES=off the old behaviour returns: the work runs on after the timeout', async () => {
    process.env['FORENSIC_DEADLINES'] = 'off';
    try {
      const counter = { n: 0, stopped: false };
      const result = await executeStage('slow', loopingStage(counter), { timeoutMs: 60 });
      expect(result.success).toBe(false);
      const atTimeout = counter.n;
      await sleep(400);
      expect(counter.n - atTimeout).toBeGreaterThan(3);
      expect(counter.stopped).toBe(false);
    } finally {
      delete process.env['FORENSIC_DEADLINES'];
    }
  });

  test('a stage that finishes in time is unaffected', async () => {
    const result = await executeStage('quick', async () => 42, { timeoutMs: 500 });
    expect(result).toMatchObject({ success: true, data: 42 });
  });
});
