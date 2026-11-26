import {
  evaluateSample,
  parseCgroupLimit,
  usedFraction,
  type RuntimeSample,
  type WatchState,
} from '../../src/lib/runtime-watch';

function sample(over: Partial<RuntimeSample> = {}): RuntimeSample {
  return {
    rssMb: 400,
    heapUsedMb: 120,
    externalMb: 40,
    arrayBuffersMb: 30,
    containerUsedMb: 450,
    containerLimitMb: 2048,
    loopBlockedMs: 0,
    ...over,
  };
}

const T0 = 1_000_000;
const quiet: WatchState = { lastLoggedRssMb: 400, lastLoggedAt: T0, lastHighAt: 0 };

describe('runtime watch', () => {
  test('reads cgroup limits: a number is a limit, "max" and huge values are not', () => {
    expect(parseCgroupLimit('2147483648\n')).toBe(2147483648);
    expect(parseCgroupLimit('max\n')).toBeNull();
    expect(parseCgroupLimit('9223372036854771712')).toBeNull();
    expect(parseCgroupLimit('')).toBeNull();
    expect(parseCgroupLimit(null)).toBeNull();
    expect(parseCgroupLimit('garbage')).toBeNull();
    expect(parseCgroupLimit('0')).toBeNull();
  });

  test('uses container memory for the share when known, the process otherwise, nothing without a limit', () => {
    expect(usedFraction(sample({ containerUsedMb: 1024, containerLimitMb: 2048 }))).toBeCloseTo(0.5);
    expect(usedFraction(sample({ containerUsedMb: null, rssMb: 512, containerLimitMb: 2048 }))).toBeCloseTo(0.25);
    expect(usedFraction(sample({ containerLimitMb: null }))).toBeNull();
  });

  test('stays quiet when nothing notable happens', () => {
    expect(evaluateSample(sample({ rssMb: 450 }), quiet, T0 + 2_000)).toBeNull();
  });

  test('flags high memory at 75% of the limit, then waits before repeating', () => {
    const high = sample({ containerUsedMb: 1600, containerLimitMb: 2048 });
    const first = evaluateSample(high, quiet, T0 + 2_000);
    expect(first?.reason).toBe('MEMORY_HIGH');
    expect(evaluateSample(high, first!.next, T0 + 4_000)).toBeNull();
    expect(evaluateSample(high, first!.next, T0 + 13_000)?.reason).toBe('MEMORY_HIGH');
  });

  test('does not flag high memory when the limit is unknown', () => {
    const big = sample({ containerUsedMb: null, containerLimitMb: null, rssMb: 400 });
    expect(evaluateSample(big, quiet, T0 + 2_000)).toBeNull();
  });

  test('flags a 150 MB jump in either direction and a blocked loop', () => {
    expect(evaluateSample(sample({ rssMb: 600 }), quiet, T0 + 2_000)?.reason).toBe('MEMORY_JUMP');
    expect(evaluateSample(sample({ rssMb: 240 }), quiet, T0 + 2_000)?.reason).toBe('MEMORY_JUMP');
    expect(evaluateSample(sample({ loopBlockedMs: 1500 }), quiet, T0 + 2_000)?.reason).toBe('EVENT_LOOP_BLOCKED');
    expect(evaluateSample(sample({ loopBlockedMs: 400 }), quiet, T0 + 2_000)).toBeNull();
  });

  test('writes a heartbeat after five quiet minutes', () => {
    expect(evaluateSample(sample(), quiet, T0 + 299_000)).toBeNull();
    const beat = evaluateSample(sample(), quiet, T0 + 300_000);
    expect(beat?.reason).toBe('HEARTBEAT');
    expect(beat?.next.lastLoggedAt).toBe(T0 + 300_000);
  });
});
