/**
 * F6: the investigation's marked-copy shortcut is only a shortcut. If the worker could not finish reading the mark, the shortcut is
 * skipped (the ordinary search runs and reports for itself); any other error still surfaces as before.
 */
import { describe, test, expect, afterEach, jest } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));

import { UnifiedInvestigationOrchestrator } from '../../src/services/forensics/unified-investigation.orchestrator';
import * as workers from '../../src/services/forensics/forensic-workers';
import { WorkerWorkFailedError } from '../../src/lib/worker-failure';

type Shortcut = (params: Record<string, unknown>) => Promise<unknown>;
const params = { buffer: Buffer.from('x'), mimeType: 'image/jpeg', originalName: 'x.jpg', sizeBytes: 1, ownerUserId: 'u1', investigationId: 'i1', pipeline: [], progressTimeline: [], currentFileHash: 'h', emit: () => undefined };
const shortcut = (): Shortcut => (new UnifiedInvestigationOrchestrator() as unknown as { tryMarkedCopyFastReport: Shortcut })
  .tryMarkedCopyFastReport.bind(new UnifiedInvestigationOrchestrator());

afterEach(() => { jest.restoreAllMocks(); });

describe('the marked-copy shortcut when the mark search could not finish', () => {
  test.each(['crash', 'oom', 'timeout'] as const)('after a worker %s the shortcut is skipped (null), so the ordinary search runs', async (kind) => {
    jest.spyOn(workers, 'readMark').mockRejectedValue(new WorkerWorkFailedError(kind, 'worker stopped'));
    expect(await shortcut()(params)).toBeNull();
  });

  test('a refused file also skips the shortcut', async () => {
    jest.spyOn(workers, 'readMark').mockRejectedValue(new WorkerWorkFailedError('crash', 'refused', true));
    expect(await shortcut()(params)).toBeNull();
  });

  test('an unrelated error is not swallowed', async () => {
    jest.spyOn(workers, 'readMark').mockRejectedValue(new Error('something else broke'));
    await expect(shortcut()(params)).rejects.toThrow('something else broke');
  });

  test('no mark means no shortcut, as before', async () => {
    jest.spyOn(workers, 'readMark').mockResolvedValue(null);
    expect(await shortcut()(params)).toBeNull();
  });
});
