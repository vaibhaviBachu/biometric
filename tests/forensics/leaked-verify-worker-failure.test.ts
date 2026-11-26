/**
 * F6: when the hidden-mark search could not be completed in a worker, "check a leaked file" must say so, not "no match".
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));

import { LeakedFileVerifyService } from '../../src/services/forensics/leaked-file-verify.service';
import * as workers from '../../src/services/forensics/forensic-workers';
import { WorkerWorkFailedError } from '../../src/lib/worker-failure';

const IMG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const NO_MATCH = { found: false, message: 'No matching document found in your vault.' };

let service: LeakedFileVerifyService;
// The service's private steps are replaced so that only the policy decision is under test.
const priv = () => service as unknown as { traceShareTag: unknown; _verifyOwned: unknown };

beforeEach(() => {
  service = new LeakedFileVerifyService();
  jest.spyOn(service, 'traceShareTag').mockResolvedValue(null);
  jest.spyOn(priv() as { _verifyOwned: () => Promise<unknown> }, '_verifyOwned').mockResolvedValue(NO_MATCH as never);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('LeakedFileVerifyService when the mark search could not finish', () => {
  test('nothing else found: the answer is "incomplete", never the plain "no match"', async () => {
    jest.spyOn(workers, 'readMark').mockRejectedValue(new WorkerWorkFailedError('crash', 'worker exited'));
    const r = await service.verify(IMG, 'image/jpeg', 'x.jpg', { ownerUserId: 'u1' });
    expect(r.found).toBe(false);
    expect(r.incomplete).toBe(true);
    expect(r.message).toMatch(/could not be completed/i);
    expect(r.message).not.toMatch(/no matching document/i);
  });

  test('a file refused after earlier failures is reported the same way', async () => {
    jest.spyOn(workers, 'readMark').mockRejectedValue(new WorkerWorkFailedError('oom', 'refused', true));
    const r = await service.verify(IMG, 'image/jpeg', 'x.jpg', { ownerUserId: 'u1' });
    expect(r).toMatchObject({ found: false, incomplete: true });
  });

  test('if another check does find the file, that answer is returned unchanged', async () => {
    jest.spyOn(workers, 'readMark').mockRejectedValue(new WorkerWorkFailedError('timeout', 'slow'));
    const found = { found: true, valid: true, message: 'This file matches your asset.' };
    jest.spyOn(priv() as { _verifyOwned: () => Promise<unknown> }, '_verifyOwned').mockResolvedValue(found as never);
    const r = await service.verify(IMG, 'image/jpeg', 'x.jpg', { ownerUserId: 'u1' });
    expect(r).toEqual(found);
    expect(r.incomplete).toBeUndefined();
  });

  test('an ordinary lookup error (not a worker failure) keeps the old behaviour: a plain "no match", not "incomplete"', async () => {
    jest.spyOn(workers, 'readMark').mockRejectedValue(new Error('decode failed'));
    const r = await service.verify(IMG, 'image/jpeg', 'x.jpg', { ownerUserId: 'u1' });
    expect(r).toEqual(NO_MATCH);
  });

  test('a clean mark search with no mark is still a plain "no match"', async () => {
    jest.spyOn(workers, 'readMark').mockResolvedValue(null);
    expect(await service.verify(IMG, 'image/jpeg', 'x.jpg', { ownerUserId: 'u1' })).toEqual(NO_MATCH);
  });
});
