/**
 * When the delivery mark's worker fails, the mark is NEVER done on the main thread instead, whatever the reason, not even when
 * workers could not start (the other worker jobs do fall back then). The caller gets a "could not finish" error, the reason is
 * logged, and a shared picture still goes out, without the pixel mark, and is tried again on the next view.
 */
import '../watermark/helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { describe, test, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';

const mockWarn = jest.fn();
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: (...a: unknown[]) => mockWarn(...a), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/services/layers/lineage-log', () => ({ appendExportLineage: jest.fn() }));

import { forensicWorkerPool, markDeliveryCopyOffThread, poisonInputs } from '../../src/services/forensics/forensic-workers';
import * as robustWatermark from '../../src/services/dna-vnext/robust-watermark';
import { deliverSharedImage, resetSharedImageCache } from '../../src/services/share/shared-image-cache';
import {
  WorkerCrashedError, WorkerOutOfMemoryError, WorkerProtocolError, WorkerStartupError, WorkerTimeoutError,
} from '../../src/lib/worker-pool';
import { WorkerWorkFailedError, isInconclusiveWorkerFailure } from '../../src/lib/worker-failure';

let n = 0;
const picture = () => Buffer.from(`picture ${++n} ${'x'.repeat(64)}`);
const params = (buffer: Buffer) => ({ buffer, mimeType: 'image/jpeg', vaultId: 'v1', dnaRecordId: 'd1', recipientKey: 'r1' });

let onMain: jest.SpiedFunction<typeof robustWatermark.markDeliveryCopy>;
let use: jest.SpiedFunction<typeof forensicWorkerPool.use>;

beforeEach(() => {
  process.env['FORENSIC_WORKERS'] = 'on';
  poisonInputs.clear();
  resetSharedImageCache();
  mockWarn.mockReset();
  onMain = jest.spyOn(robustWatermark, 'markDeliveryCopy').mockResolvedValue({ buffer: Buffer.from('marked'), embedded: true, method: 'robust-dwt-v1' });
  use = jest.spyOn(forensicWorkerPool, 'use');
});
afterEach(() => { jest.restoreAllMocks(); process.env['FORENSIC_WORKERS'] = 'off'; });
afterAll(async () => { await forensicWorkerPool.close(); });

describe('a failed delivery-mark worker', () => {
  const failures: Array<[string, () => Error]> = [
    ['crash', () => new WorkerCrashedError('it exited with code 3')],
    ['oom', () => new WorkerOutOfMemoryError('heap limit')],
    ['timeout', () => new WorkerTimeoutError(60_000)],
    ['job-error', () => Object.assign(new Error('Input buffer contains unsupported image format'), { name: 'Error' })],
    ['startup', () => new WorkerStartupError('could not load the worker file')],
    ['protocol', () => new WorkerProtocolError('Unknown worker operation: mark.embed')],
  ];

  test.each(failures)('%s: "could not finish", logged, and never repeated on the main thread', async (kind, make) => {
    use.mockRejectedValue(make());
    const err = await markDeliveryCopyOffThread(params(picture())).then(() => null, (e: unknown) => e) as WorkerWorkFailedError;
    expect(err).toBeInstanceOf(WorkerWorkFailedError);
    expect(isInconclusiveWorkerFailure(err)).toBe(true);
    expect(err.kind).toBe(kind);
    expect(onMain).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      '[Workers] delivery mark could not be completed: the file goes out without the pixel mark',
      expect.objectContaining({ kind, vaultId: 'v1' }),
    );
  });

  test('a shared picture still goes out (the original, unmarked), is not kept, and the next view tries the worker again', async () => {
    use.mockRejectedValue(new WorkerCrashedError('it exited with code 3'));
    const original = picture();
    const link = { vaultId: 'v1', dnaRecordId: 'd1', ownerUserId: null, recipientLabel: 'Client A' };
    const first = await deliverSharedImage({ link, original, mime: 'image/jpeg' });
    expect(first).toEqual({ buffer: original, cacheHit: false });
    const second = await deliverSharedImage({ link, original, mime: 'image/jpeg' });
    expect(second.buffer).toBe(original);
    expect(use).toHaveBeenCalledTimes(2);
    expect(onMain).not.toHaveBeenCalled();
  });

  test('FORENSIC_WORKERS=off (an operator\'s switch) runs it on the main thread, as before, without the pool', async () => {
    process.env['FORENSIC_WORKERS'] = 'off';
    const made = await markDeliveryCopyOffThread(params(picture()));
    expect(made.embedded).toBe(true);
    expect(onMain).toHaveBeenCalledTimes(1);
    expect(use).not.toHaveBeenCalled();
  });
});
