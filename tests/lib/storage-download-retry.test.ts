/** A temporary storage failure is retried and is never mistaken for a missing file. */
import { describe, test, expect, jest } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/supabase-node', () => ({ createSupabaseNodeClient: jest.fn() }));

import {
  downloadObjectWithRetry, isMissingObjectMessage, StorageUnavailableError,
} from '../../src/lib/supabase-storage';

const noSleep = async () => undefined;

describe('isMissingObjectMessage', () => {
  test.each([
    ['Supabase download failed: Object not found', true],
    ['Supabase download failed: The resource was not found', true],
    ['Supabase download failed: fetch failed', false],
    ['Supabase download failed: no answer after 120s', false],
    ['Supabase download failed: Bucket not found', false],
    ['socket hang up', false],
  ])('%s -> missing=%s', (msg, expected) => expect(isMissingObjectMessage(msg)).toBe(expected));
});

describe('downloadObjectWithRetry', () => {
  test('a network failure followed by success returns the file', async () => {
    const download = jest.fn<(p: string) => Promise<Buffer>>()
      .mockRejectedValueOnce(new Error('Supabase download failed: fetch failed'))
      .mockResolvedValueOnce(Buffer.from('bytes'));
    const out = await downloadObjectWithRetry('a/b.enc', { download, sleep: noSleep });
    expect(out.toString()).toBe('bytes');
    expect(download).toHaveBeenCalledTimes(2);
  });

  test('pauses grow between attempts (0.5 s, then 1 s)', async () => {
    const pauses: number[] = [];
    const download = jest.fn<(p: string) => Promise<Buffer>>().mockRejectedValue(new Error('fetch failed'));
    await expect(downloadObjectWithRetry('x.enc', { download, sleep: async (ms) => { pauses.push(ms); } })).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(pauses).toEqual([500, 1000]);
  });

  test('three failed attempts say "storage unavailable", not "missing"', async () => {
    const download = jest.fn<(p: string) => Promise<Buffer>>().mockRejectedValue(new Error('Supabase download failed: fetch failed'));
    const err = await downloadObjectWithRetry('x.enc', { download, sleep: noSleep }).catch((e) => e as StorageUnavailableError);
    expect(err).toBeInstanceOf(StorageUnavailableError);
    expect(err.code).toBe('STORAGE_UNAVAILABLE');
    expect(err.attempts).toBe(3);
    expect(download).toHaveBeenCalledTimes(3);
  });

  test('an object that is really not there fails at once, without retrying', async () => {
    const download = jest.fn<(p: string) => Promise<Buffer>>().mockRejectedValue(new Error('Supabase download failed: Object not found'));
    const err = await downloadObjectWithRetry('x.enc', { download, sleep: noSleep }).catch((e) => e as Error);
    expect(err).not.toBeInstanceOf(StorageUnavailableError);
    expect(download).toHaveBeenCalledTimes(1);
  });

  test('a permanent error (permissions) fails at once', async () => {
    const download = jest.fn<(p: string) => Promise<Buffer>>().mockRejectedValue(new Error('Unauthorized'));
    await downloadObjectWithRetry('x.enc', { download, sleep: noSleep }).catch(() => undefined);
    expect(download).toHaveBeenCalledTimes(1);
  });
});
