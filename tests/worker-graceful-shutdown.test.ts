/**
 * Phase 5 — worker graceful shutdown.
 *
 * Verifies the Phase 5 fix to src/worker.ts: `requestShutdown()` must not
 * force-exit while the current in-flight poll cycle (`loopSettled`) is still
 * running, and must force-exit only once `WORKER_SHUTDOWN_TIMEOUT_MS`
 * genuinely elapses without that cycle settling — the behavior that
 * previously regressed when this process also called the shared, HTTP-API-
 * oriented `registerGracefulShutdown()`, which exited immediately on SIGTERM
 * with no awareness of an in-flight job.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

process.env['JOB_QUEUE_BACKEND'] = 'local';
process.env['WORKER_SHUTDOWN_TIMEOUT_MS'] = '5000';

jest.mock('../src/services/vault/vault.service', () => ({
  VaultService: jest.fn().mockImplementation(() => ({ retrieve: jest.fn() })),
}));
jest.mock('../src/services/layers/layers-11-15.service', () => ({
  processAdvancedLayers: jest.fn(),
}));
jest.mock('../src/services/videos/video-page-protection.service', () => ({
  videoPageProtectionService: { protectVideoFrames: jest.fn() },
}));
jest.mock('../src/lib/prisma', () => ({ prisma: { $disconnect: jest.fn(async () => undefined) } }));

import { requestShutdown } from '../src/worker';

describe('worker — requestShutdown (Phase 5 graceful shutdown)', () => {
  let exitSpy: jest.SpiedFunction<typeof process.exit>;

  beforeEach(() => {
    jest.useFakeTimers();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
  });

  afterEach(() => {
    jest.useRealTimers();
    exitSpy.mockRestore();
  });

  test('does not force-exit once the in-flight poll cycle settles before the timeout elapses', async () => {
    let resolveLoop: () => void = () => undefined;
    const loopSettled = new Promise<void>((resolve) => { resolveLoop = resolve; });

    requestShutdown('SIGTERM', loopSettled);

    // Well inside the WORKER_SHUTDOWN_TIMEOUT_MS=5000 window — the "job" is still in flight.
    jest.advanceTimersByTime(3_000);
    expect(exitSpy).not.toHaveBeenCalled();

    // Now let the in-flight cycle finish — this must clear the force-exit timer,
    // not trigger it later even if time keeps advancing past the original deadline.
    resolveLoop();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(60_000);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('force-exits with code 1 once the timeout genuinely elapses without the poll cycle settling', async () => {
    const neverSettles = new Promise<void>(() => { /* simulates a stuck/hung job */ });

    requestShutdown('SIGTERM', neverSettles);

    jest.advanceTimersByTime(4_999);
    expect(exitSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('a second signal arriving before drain completes still exits cleanly once the shared loop settles', async () => {
    // Each call registers its own force-exit timer against the same
    // loopSettled promise; both are cleared the same way once it resolves,
    // so an overlapping second signal (e.g. SIGINT right after SIGTERM) does
    // not cause a spurious force-exit.
    let resolveLoop: () => void = () => undefined;
    const loopSettled = new Promise<void>((resolve) => { resolveLoop = resolve; });

    requestShutdown('SIGTERM', loopSettled);
    requestShutdown('SIGINT', loopSettled);

    resolveLoop();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(10_000);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
