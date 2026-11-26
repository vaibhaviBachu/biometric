import { MemoryGate } from '../../src/lib/memory-gate';

const MB = 1024 * 1024;

/** A job that holds its place until the test lets it go. */
function job(gate: MemoryGate, needMb: number, label: string, log: string[]) {
  let letGo: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => { letGo = resolve; });
  const done = gate.run(needMb * MB, label, async () => {
    log.push(`start ${label}`);
    await hold;
    log.push(`end ${label}`);
    return label;
  });
  return { done, letGo };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('memory gate', () => {
  test('runs jobs together while they fit the budget and holds the rest', async () => {
    const gate = new MemoryGate(() => 100 * MB);
    const log: string[] = [];
    const a = job(gate, 40, 'a', log);
    const b = job(gate, 40, 'b', log);
    const c = job(gate, 40, 'c', log);
    await tick();
    expect(log).toEqual(['start a', 'start b']);
    expect(gate.stats()).toMatchObject({ active: 2, queued: 1, inUseMb: 80 });
    a.letGo();
    await tick();
    expect(log).toContain('start c');
    b.letGo(); c.letGo();
    await Promise.all([a.done, b.done, c.done]);
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0, inUseMb: 0 });
  });

  test('first come, first served: a big job is not starved by smaller ones behind it', async () => {
    const gate = new MemoryGate(() => 100 * MB);
    const log: string[] = [];
    const a = job(gate, 60, 'a', log);
    const big = job(gate, 80, 'big', log);
    const small = job(gate, 10, 'small', log);
    await tick();
    expect(log).toEqual(['start a']);
    a.letGo();
    await tick();
    expect(log.indexOf('start big')).toBeGreaterThan(-1);
    expect(log.indexOf('start big')).toBeLessThan(log.indexOf('start small'));
    big.letGo(); small.letGo();
    await Promise.all([a.done, big.done, small.done]);
  });

  test('a job bigger than the whole budget is never refused: it runs alone', async () => {
    const gate = new MemoryGate(() => 100 * MB);
    const log: string[] = [];
    const huge = job(gate, 5000, 'huge', log);
    const next = job(gate, 10, 'next', log);
    await tick();
    expect(log).toEqual(['start huge']);
    huge.letGo();
    await tick();
    expect(log).toContain('start next');
    next.letGo();
    expect(await huge.done).toBe('huge');
    await next.done;
  });

  test('an oversized job waits for running jobs to finish, then runs alone', async () => {
    const gate = new MemoryGate(() => 100 * MB);
    const log: string[] = [];
    const a = job(gate, 30, 'a', log);
    const huge = job(gate, 900, 'huge', log);
    await tick();
    expect(log).toEqual(['start a']);
    a.letGo();
    await tick();
    expect(log).toContain('start huge');
    huge.letGo();
    await Promise.all([a.done, huge.done]);
  });

  test('frees its place when the job throws, so the next one still runs', async () => {
    const gate = new MemoryGate(() => 50 * MB);
    const failing = gate.run(50 * MB, 'fails', async () => { throw new Error('boom'); });
    const after = gate.run(50 * MB, 'after', async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
    expect(gate.stats()).toMatchObject({ active: 0, inUseMb: 0, queued: 0 });
  });

  test('a step inside a running job does not wait for memory a second time', async () => {
    const gate = new MemoryGate(() => 100 * MB);
    const result = await gate.run(90 * MB, 'outer', async () => gate.run(90 * MB, 'inner', async () => 'inner done'));
    expect(result).toBe('inner done');
    expect(gate.stats().inUseMb).toBe(0);
  });

  test('work left running after its job ended does not borrow the finished lease', async () => {
    const gate = new MemoryGate(() => 100 * MB);
    const log: string[] = [];
    let later: Promise<string> | undefined;
    let letGo: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { letGo = resolve; });
    await gate.run(60 * MB, 'parent', async () => {
      later = (async () => {
        await hold; // runs after the parent has finished
        return gate.run(60 * MB, 'background', async () => { log.push('background ran'); return 'done'; });
      })();
    });
    // The parent is finished. Fill the budget, then let the background step try to start.
    const blocker = job(gate, 90, 'blocker', log);
    await tick();
    letGo();
    await tick();
    expect(log).toEqual(['start blocker']);
    expect(gate.stats().queued).toBe(1);
    blocker.letGo();
    await blocker.done;
    expect(await later).toBe('done');
  });

  test('does nothing when switched off', async () => {
    const gate = new MemoryGate(() => 10 * MB, () => false);
    const log: string[] = [];
    const a = job(gate, 500, 'a', log);
    const b = job(gate, 500, 'b', log);
    await tick();
    expect(log).toEqual(['start a', 'start b']);
    expect(gate.stats().active).toBe(0);
    a.letGo(); b.letGo();
    await Promise.all([a.done, b.done]);
  });
});

describe('estimates', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require('sharp') as typeof import('sharp');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { estimateFromDimensions, estimateImageJobBytes, withMemoryGate, memoryGate } = require('../../src/lib/memory-gate') as typeof import('../../src/lib/memory-gate');

  test('grows with pixel count, not file size', () => {
    const small = estimateFromDimensions(1000, 1000, 5 * 1024 * 1024);
    const big = estimateFromDimensions(8000, 6000, 5 * 1024 * 1024);
    expect(big).toBeGreaterThan(small * 20); // 48 MP vs a 1 MP image, which sits at the 32 MB floor
    expect(estimateFromDimensions(10, 10, 100)).toBe(32 * 1024 * 1024);
  });

  test('reads an image header, and returns null for anything that is not an image', async () => {
    const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#808080' } }).png().toBuffer();
    const estimate = await estimateImageJobBytes(png);
    expect(estimate).not.toBeNull();
    expect(estimate!).toBeGreaterThanOrEqual(32 * 1024 * 1024);
    expect(await estimateImageJobBytes(Buffer.from('%PDF-1.7 not an image'))).toBeNull();
    expect(await estimateImageJobBytes(Buffer.alloc(0))).toBeNull();
  });

  test('a file that is not an image never waits in the queue, however large it is', async () => {
    const before = memoryGate.stats();
    const result = await withMemoryGate(Buffer.alloc(64 * 1024 * 1024, 7), 'video', async () => memoryGate.stats());
    expect(result.active).toBe(before.active);
    expect(result.inUseMb).toBe(before.inUseMb);
  });
});
