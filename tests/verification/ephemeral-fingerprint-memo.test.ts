/**
 * One fingerprint per file, shared: a Trace used to fingerprint the same probe 12 times (a full DNA generation saved to the
 * database each time), because every candidate comparison asked for it again, most of them at the same moment.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

// Loaded first, in the app's order: importing the fingerprinter on its own enters an existing import cycle
// (fingerprinter → universal-file-router → document-page-protection, which constructs a fingerprinter while it is still loading).
import '../../src/services/universal-file-router';
import { EphemeralFingerprinter, resetEphemeralFingerprintMemo, type EphemeralFingerprint } from '../../src/services/verification/ephemeral-fingerprinter';

type FileIn = Parameters<EphemeralFingerprinter['fingerprint']>[0];
const file = (over: Partial<FileIn> = {}): FileIn => ({
  filePath: '', originalName: 'probe.jpg', declaredMimeType: 'image/jpeg', sizeBytes: 5, buffer: Buffer.from('bytes'), ownerUserId: 'owner-1', ...over,
} as FileIn);
const result = (tag: string): EphemeralFingerprint => ({
  fileType: 'IMAGE', mimeType: 'image/jpeg', filename: tag, sizeBytes: 5, detectedBy: 'magic_bytes',
  layers: [{ layer: 1, name: 'Cryptographic', implementation: 'x', fingerprint: `fp-${tag}`, data: {}, success: true }],
});

let uncached: jest.Mock<(f: FileIn) => Promise<EphemeralFingerprint>>;
const fp = new EphemeralFingerprinter();

beforeEach(() => {
  resetEphemeralFingerprintMemo();
  delete process.env['EPHEMERAL_FINGERPRINT_MEMO'];
  uncached = jest.fn(async (f: FileIn) => { await new Promise((r) => setTimeout(r, 20)); return result(f.originalName); });
  (fp as unknown as { fingerprintUncached: typeof uncached }).fingerprintUncached = uncached;
});
afterEach(() => { jest.useRealTimers(); });

describe('ephemeral fingerprint memo', () => {
  test('8 comparisons asking at the same moment: ONE fingerprint, each caller gets its own copy', async () => {
    const all = await Promise.all(Array.from({ length: 8 }, () => fp.fingerprint(file())));
    expect(uncached).toHaveBeenCalledTimes(1);
    expect(new Set(all.map((a) => a.layers[0]!.fingerprint))).toEqual(new Set(['fp-probe.jpg']));
    expect(all[0]).not.toBe(all[1]);
    all[0]!.layers.push({ layer: 99, name: 'x', implementation: 'x', fingerprint: 'x', data: {}, success: true });
    all[0]!.layers[0]!.fingerprint = 'changed';
    expect(all[1]!.layers).toHaveLength(1);
    expect(all[1]!.layers[0]!.fingerprint).toBe('fp-probe.jpg');
  });

  test('later asks for the same file reuse it', async () => {
    await fp.fingerprint(file());
    await fp.fingerprint(file());
    expect(uncached).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['different bytes', { buffer: Buffer.from('other'), sizeBytes: 5 }],
    ['a different owner (never shared between accounts)', { ownerUserId: 'owner-2' }],
    ['a different name', { originalName: 'other.jpg' }],
    ['a different declared type', { declaredMimeType: 'image/png' }],
  ])('%s: its own fingerprint', async (_label, over) => {
    await fp.fingerprint(file());
    await fp.fingerprint(file(over as Partial<FileIn>));
    expect(uncached).toHaveBeenCalledTimes(2);
  });

  test('a failed fingerprint is not kept: the next ask tries again', async () => {
    uncached.mockRejectedValueOnce(new Error('engine failed'));
    await expect(fp.fingerprint(file())).rejects.toThrow('engine failed');
    await expect(fp.fingerprint(file())).resolves.toMatchObject({ filename: 'probe.jpg' });
    expect(uncached).toHaveBeenCalledTimes(2);
  });

  test('after 10 minutes it is generated again', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await fp.fingerprint(file());
    clock.mockReturnValue(now + 10 * 60_000 + 1);
    await fp.fingerprint(file());
    expect(uncached).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });

  test('EPHEMERAL_FINGERPRINT_MEMO=off: every ask generates (the old behaviour)', async () => {
    process.env['EPHEMERAL_FINGERPRINT_MEMO'] = 'off';
    await Promise.all([fp.fingerprint(file()), fp.fingerprint(file())]);
    expect(uncached).toHaveBeenCalledTimes(2);
  });
});
