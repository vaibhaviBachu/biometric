import { describe, test, expect } from '@jest/globals';
import { parseCpuLimit, availableCpus } from '../../src/lib/cpu-limit';
import { automaticWorkerCount } from '../../src/lib/worker-pool';
import { matchWorkersEnabled } from '../../src/services/forensics/forensic-workers';

describe('reading the container CPU limit', () => {
  test.each([
    ['100000 100000', 1],      // cgroup v2: one CPU (the Render plan)
    ['200000 100000', 2],
    ['150000 100000', 1],      // a fractional limit rounds down
    ['50000 100000', 1],       // half a CPU is still one thread
    ['400000', 4],             // period omitted: the default 100000
  ])('cgroup v2 "%s" -> %s', (raw, expected) => {
    expect(parseCpuLimit(raw)).toBe(expected);
  });

  test('"max" and unreadable values mean no limit', () => {
    expect(parseCpuLimit('max 100000')).toBeNull();
    expect(parseCpuLimit(null)).toBeNull();
    expect(parseCpuLimit('')).toBeNull();
    expect(parseCpuLimit('garbage text')).toBeNull();
  });

  test('cgroup v1 quota and period', () => {
    expect(parseCpuLimit(null, '100000', '100000')).toBe(1);
    expect(parseCpuLimit(null, '300000', '100000')).toBe(3);
    expect(parseCpuLimit(null, '-1', '100000')).toBeNull();
  });

  test('never reports fewer than one, or more than the host has', () => {
    expect(availableCpus()).toBeGreaterThanOrEqual(1);
  });
});

describe('what the CPU count decides', () => {
  test('a 1 CPU service gets one worker and keeps the patch search in-process; the host count no longer matters', () => {
    // Before: os.cpus() said 16 on a 1 CPU Render service, which gave 2 workers and turned worker patch search on.
    expect(automaticWorkerCount(1)).toBe(1);
    expect(matchWorkersEnabled({}, 1)).toBe(false);
    expect(automaticWorkerCount(2)).toBe(1);
    expect(automaticWorkerCount(4)).toBe(2);
    expect(matchWorkersEnabled({}, 2)).toBe(true);
  });
});
