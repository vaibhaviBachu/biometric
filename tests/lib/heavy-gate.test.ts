/** The bounded line for heavy forensic work. */
import { describe, test, expect } from '@jest/globals';
import { HeavyGate, GateBusyError, type GateLimits } from '../../src/lib/heavy-gate';
import { AbortedError } from '../../src/lib/cancellation';

const limits = (over: Partial<GateLimits> = {}): (() => GateLimits) => () => ({ slots: 2, perUser: 1, queue: 3, waitMs: 5_000, ...over });

/** A job that runs until `finish()` is called. */
function hold() {
  let finish!: () => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const work = () => new Promise<string>((resolve) => { started(); finish = () => resolve('done'); });
  return { work, begun, finish: () => finish() };
}

describe('HeavyGate', () => {
  test('runs up to `slots` jobs at once and queues the rest in order', async () => {
    const gate = new HeavyGate('t', limits({ slots: 2, perUser: 5 }));
    const order: string[] = [];
    const jobs = ['a', 'b', 'c', 'd'].map((id) => {
      const h = hold();
      const p = gate.run({ userId: id, label: id }, async () => { order.push(`start:${id}`); return h.work(); });
      return { id, h, p };
    });
    await jobs[0]!.h.begun;
    await jobs[1]!.h.begun;
    expect(gate.stats()).toMatchObject({ running: 2, waiting: 2 });
    expect(order).toEqual(['start:a', 'start:b']);
    jobs[0]!.h.finish();
    await jobs[2]!.h.begun;
    expect(order).toEqual(['start:a', 'start:b', 'start:c']);
    jobs[1]!.h.finish();
    await jobs[3]!.h.begun;
    jobs[2]!.h.finish();
    jobs[3]!.h.finish();
    await Promise.all(jobs.map((j) => j.p));
    expect(gate.stats()).toMatchObject({ running: 0, waiting: 0, admitted: 4, peakWaiting: 2 });
  });

  test('one user cannot take every slot: a second job of the same user waits while another user runs', async () => {
    const gate = new HeavyGate('t', limits({ slots: 2, perUser: 1 }));
    const a1 = hold(); const a2 = hold(); const b1 = hold();
    const p1 = gate.run({ userId: 'ana', label: 'a1' }, a1.work);
    const p2 = gate.run({ userId: 'ana', label: 'a2' }, a2.work);
    const p3 = gate.run({ userId: 'ben', label: 'b1' }, b1.work);
    await a1.begun;
    await b1.begun; // ben jumps ahead of ana's second job: a slot was free and ana is at her own limit
    expect(gate.stats()).toMatchObject({ running: 2, waiting: 1 });
    a1.finish();
    await a2.begun;
    a2.finish(); b1.finish();
    await Promise.all([p1, p2, p3]);
  });

  test('a full line refuses at once with "busy" and a Retry-After', async () => {
    const gate = new HeavyGate('t', limits({ slots: 1, perUser: 9, queue: 1 }));
    const a = hold(); const b = hold();
    const pa = gate.run({ userId: 'a', label: 'a' }, a.work);
    await a.begun;
    const pb = gate.run({ userId: 'b', label: 'b' }, b.work); // waits
    await expect(gate.run({ userId: 'c', label: 'c' }, async () => 'x')).rejects.toBeInstanceOf(GateBusyError);
    const err = await gate.run({ userId: 'c', label: 'c' }, async () => 'x').catch((e) => e as GateBusyError);
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/try again/i);
    a.finish(); await b.begun; b.finish();
    await Promise.all([pa, pb]);
    expect(gate.stats().refused).toBe(2);
  });

  test('a job that waits too long is refused, and leaves the line', async () => {
    const gate = new HeavyGate('t', limits({ slots: 1, perUser: 9, queue: 5, waitMs: 40 }));
    const a = hold();
    const pa = gate.run({ userId: 'a', label: 'a' }, a.work);
    await a.begun;
    await expect(gate.run({ userId: 'b', label: 'b' }, async () => 'x')).rejects.toBeInstanceOf(GateBusyError);
    expect(gate.stats().waiting).toBe(0);
    a.finish(); await pa;
  });

  test('a waiting job whose caller went away leaves the line without running', async () => {
    const gate = new HeavyGate('t', limits({ slots: 1, perUser: 9 }));
    const a = hold();
    const pa = gate.run({ userId: 'a', label: 'a' }, a.work);
    await a.begun;
    const controller = new AbortController();
    let ran = false;
    const pb = gate.run({ userId: 'b', label: 'b', signal: controller.signal }, async () => { ran = true; return 'x'; });
    expect(gate.stats().waiting).toBe(1);
    controller.abort();
    await expect(pb).rejects.toBeInstanceOf(AbortedError);
    expect(gate.stats()).toMatchObject({ waiting: 0, abandoned: 1 });
    a.finish(); await pa;
    expect(ran).toBe(false);
  });

  test('the slot is given back when a job throws', async () => {
    const gate = new HeavyGate('t', limits({ slots: 1 }));
    await expect(gate.run({ userId: 'a', label: 'a' }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await gate.run({ userId: 'a', label: 'a2' }, async () => 'ok')).toBe('ok');
    expect(gate.stats().running).toBe(0);
  });

  test('switched off, everything runs at once', async () => {
    const gate = new HeavyGate('t', limits({ slots: 1, queue: 0 }), () => false);
    const jobs = [hold(), hold(), hold()];
    const ps = jobs.map((j, i) => gate.run({ userId: 'a', label: String(i) }, j.work));
    await Promise.all(jobs.map((j) => j.begun));
    jobs.forEach((j) => j.finish());
    await Promise.all(ps);
    expect(gate.stats().admitted).toBe(0);
  });
});
