/**
 * A vault upload must never hang the protect request and must survive a transient failure: each attempt has a time limit that
 * grows with the file's size, a failed or stalled attempt is retried, and an error that a retry cannot fix fails at once with its
 * real message.
 */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const mockUpload = jest.fn();
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/lib/supabase-node', () => ({
  createSupabaseNodeClient: () => ({
    storage: {
      listBuckets: async () => ({ data: [{ name: 'vault-files' }], error: null }),
      from: () => ({ upload: (...args: unknown[]) => mockUpload(...args) }),
    },
  }),
}));

process.env['SUPABASE_URL'] = 'https://example.invalid';
process.env['SUPABASE_SERVICE_KEY'] = 'test-key-not-real';

import { uploadWithRetry, uploadTimeoutMs, isPermanentStorageError, uploadVaultFile, UPLOAD_ATTEMPTS } from '../../src/lib/supabase-storage';

const noSleep = async () => undefined;
const buf = Buffer.from('encrypted bytes');

beforeEach(() => mockUpload.mockReset());

describe('uploadWithRetry', () => {
  test('a clean upload takes one attempt', async () => {
    mockUpload.mockResolvedValue({ data: {}, error: null });
    await uploadWithRetry('owner/v1.enc', buf, { vaultId: 'v1' }, 3, noSleep);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload.mock.calls[0]![0]).toBe('owner/v1.enc');
    expect((mockUpload.mock.calls[0]![2] as { upsert: boolean }).upsert).toBe(true); // a repeat is safe
  });

  test('a transient failure is retried and the upload then succeeds', async () => {
    mockUpload.mockResolvedValueOnce({ data: null, error: { message: 'fetch failed' } }).mockResolvedValueOnce({ data: {}, error: null });
    await expect(uploadWithRetry('p', buf, {}, 3, noSleep)).resolves.toBeUndefined();
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  test('a thrown network error is retried too', async () => {
    mockUpload.mockRejectedValueOnce(new Error('ECONNRESET')).mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce({ data: {}, error: null });
    await uploadWithRetry('p', buf, {}, 3, noSleep);
    expect(mockUpload).toHaveBeenCalledTimes(3);
  });

  test('a stalled attempt is abandoned after the time limit and retried', async () => {
    mockUpload.mockImplementationOnce(() => new Promise(() => undefined)).mockResolvedValueOnce({ data: {}, error: null });
    await uploadWithRetry('p', buf, {}, 3, noSleep, 20);
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  test('after the last attempt the real error is raised, and it names the upload', async () => {
    mockUpload.mockResolvedValue({ data: null, error: { message: 'gateway timeout' } });
    await expect(uploadWithRetry('p', buf, {}, 3, noSleep)).rejects.toThrow('Supabase upload failed: gateway timeout');
    expect(mockUpload).toHaveBeenCalledTimes(3);
  });

  test('a stall on every attempt ends in an error, not a hang', async () => {
    mockUpload.mockImplementation(() => new Promise(() => undefined));
    await expect(uploadWithRetry('p', buf, {}, 2, noSleep, 15)).rejects.toThrow(/no answer after/);
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  test.each([
    'The object exceeded the maximum allowed size',
    'new row violates row-level security policy',
    'Invalid API key',
    'Bucket not found',
    'project is restricted',
  ])('an error a retry cannot fix fails at once: %s', async (message) => {
    mockUpload.mockResolvedValue({ data: null, error: { message } });
    await expect(uploadWithRetry('p', buf, {}, 3, noSleep)).rejects.toThrow(message);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  test('waits longer before each repeat (1 s, then 2 s)', async () => {
    mockUpload.mockResolvedValue({ data: null, error: { message: 'fetch failed' } });
    const waits: number[] = [];
    await uploadWithRetry('p', buf, {}, 3, async (ms) => { waits.push(ms); }).catch(() => undefined);
    expect(waits).toEqual([1000, 2000]);
  });
});

describe('limits', () => {
  test('the time limit grows with the file and is capped', () => {
    expect(uploadTimeoutMs(1)).toBe(50_000);
    expect(uploadTimeoutMs(17 * 1024 * 1024)).toBe(45_000 + 17 * 5_000);
    expect(uploadTimeoutMs(10 * 1024 * 1024 * 1024)).toBe(300_000);
    expect(uploadTimeoutMs(40 * 1024 * 1024)).toBeGreaterThan(uploadTimeoutMs(17 * 1024 * 1024));
  });

  test('three attempts by default', () => expect(UPLOAD_ATTEMPTS).toBe(3));

  test('classification of permanent errors', () => {
    expect(isPermanentStorageError('fetch failed')).toBe(false);
    expect(isPermanentStorageError('socket hang up')).toBe(false);
    expect(isPermanentStorageError('Payload too large')).toBe(true);
  });
});

describe('uploadVaultFile', () => {
  test('uses the owner folder and returns the path after a retried upload', async () => {
    jest.useFakeTimers();
    mockUpload.mockResolvedValueOnce({ data: null, error: { message: 'fetch failed' } }).mockResolvedValueOnce({ data: {}, error: null });
    const promise = uploadVaultFile('vault-9', buf, 'owner-1');
    await jest.advanceTimersByTimeAsync(1500);
    await expect(promise).resolves.toBe('owner-1/vault-9.enc');
    jest.useRealTimers();
  });
});
