/**
 * music-metadata <= 11.12.1 has an infinite loop in its ASF (WMA/WMV) parser
 * (npm audit: high). Upgrading is a breaking major bump (ESM-only), so instead a
 * file carrying an ASF header never reaches the parser — even when it is
 * declared as mp3/wav, because the library also picks a parser from the bytes.
 *
 * music-metadata <= 11.12.3 additionally has uncontrolled-memory-allocation bugs
 * (CWE-789) in its APEv2 tag parser (GHSA-53v6-4h7p-p4gj) and its ID3v2 tag parser
 * (GHSA-jjpr-9cvf-cq55) — a declared tag size is used to allocate a buffer without
 * checking it against the bytes actually available. These tests use small,
 * deterministic, bounded buffers that only assert a declared size doesn't fit the
 * buffer; none of them constructs an actually oversized allocation or attempts to
 * exhaust memory, per this task's explicit restriction.
 *
 * Phase 8: the engine no longer calls music-metadata directly — it calls
 * `parseMusicMetadataIsolated` (music-metadata-worker-runner.ts), which runs the real parser
 * inside a disposable, hard-terminable worker thread. This file mocks that function (one level
 * up from where it was mocking `music-metadata` itself) so these tests stay fast, deterministic,
 * and focused on the ENGINE's own guard-chain/fallback logic — not on whether the worker
 * mechanism itself works, which has its own dedicated, real-worker test file
 * (music-metadata-worker-runner.test.ts) because Jest's module mocks cannot reach into a
 * separate worker thread's own independent module registry anyway.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { TimeoutError } from '../../src/lib/safe-runner';

type AnyAsync = (...args: unknown[]) => Promise<unknown>;
const parseMusicMetadataIsolated = jest.fn<AnyAsync>();
jest.mock('../../src/services/engines/audio/music-metadata-worker-runner', () => ({
  parseMusicMetadataIsolated,
}));
// The engine writes its result to the DB; never let a unit test reach a real database.
jest.mock('../../src/lib/prisma', () => ({
  prisma: { dnaRecord: { update: jest.fn(async () => ({})) } },
}));
jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { AudioDnaEngine, looksLikeAsf } from '../../src/services/engines/audio/audio-dna-engine';
import { looksLikeApeTag, hasOversizedId3v2Tag } from '../../src/lib/asf-guard';

const ASF_GUID = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex');

/** A minimal, well-formed ID3v2 header declaring `size` bytes of tag data follow it. */
function id3v2Header(size: number): Buffer {
  const h = Buffer.alloc(10);
  h.write('ID3', 0, 'ascii');
  h[3] = 3; h[4] = 0; h[5] = 0; // version 2.3.0, no flags
  h[6] = (size >> 21) & 0x7f;
  h[7] = (size >> 14) & 0x7f;
  h[8] = (size >> 7) & 0x7f;
  h[9] = size & 0x7f;
  return h;
}

beforeEach(() => {
  parseMusicMetadataIsolated.mockReset();
  parseMusicMetadataIsolated.mockResolvedValue({ format: {}, common: {} });
});

const file = (buffer: Buffer, mime = 'audio/mpeg') => ({
  filePath: '', originalName: 'x.mp3', declaredMimeType: mime, sizeBytes: buffer.length, buffer,
});

describe('looksLikeAsf', () => {
  test('recognises the ASF header GUID', () => {
    expect(looksLikeAsf(Buffer.concat([ASF_GUID, Buffer.alloc(64)]))).toBe(true);
  });
  test('rejects ordinary audio and short buffers', () => {
    expect(looksLikeAsf(Buffer.from('ID3\u0003\u0000\u0000', 'latin1'))).toBe(false);
    expect(looksLikeAsf(Buffer.from('RIFF....WAVEfmt ', 'latin1'))).toBe(false);
    expect(looksLikeAsf(Buffer.alloc(4))).toBe(false);
    expect(looksLikeAsf(Buffer.alloc(0))).toBe(false);
  });
});

describe('looksLikeApeTag', () => {
  test('recognises the APETAGEX signature as a footer trailing ordinary audio bytes', () => {
    expect(looksLikeApeTag(Buffer.concat([Buffer.alloc(64, 1), Buffer.from('APETAGEX', 'ascii'), Buffer.alloc(24)]))).toBe(true);
  });
  test('recognises the signature at the start of a standalone .ape-shaped buffer', () => {
    expect(looksLikeApeTag(Buffer.concat([Buffer.from('APETAGEX', 'ascii'), Buffer.alloc(64)]))).toBe(true);
  });
  test('rejects ordinary audio with no APEv2 signature anywhere', () => {
    expect(looksLikeApeTag(Buffer.from('RIFF....WAVEfmt ', 'latin1'))).toBe(false);
    expect(looksLikeApeTag(Buffer.alloc(0))).toBe(false);
  });
});

describe('hasOversizedId3v2Tag', () => {
  test('a legitimate ID3v2 header whose declared size fits the buffer is not flagged', () => {
    const buf = Buffer.concat([id3v2Header(20), Buffer.alloc(200)]); // declares 20, has 200+ available
    expect(hasOversizedId3v2Tag(buf)).toBe(false);
  });
  test('a declared size that does not fit inside the actual buffer is flagged (bounded check, no allocation attempted)', () => {
    // Max synchsafe size (0x7f x4 = 268,435,455) declared on a 50-byte buffer — this test only
    // compares two integers; it never allocates or attempts to read that many bytes.
    const buf = Buffer.concat([id3v2Header(0x0fffffff), Buffer.alloc(40)]);
    expect(hasOversizedId3v2Tag(buf)).toBe(true);
  });
  test('a malformed synchsafe byte (high bit set) is treated as suspicious', () => {
    const buf = Buffer.concat([id3v2Header(10), Buffer.alloc(50)]);
    buf[9] = 0xff; // high bit set — not valid synchsafe encoding
    expect(hasOversizedId3v2Tag(buf)).toBe(true);
  });
  test('buffers with no ID3v2 header at all are never flagged', () => {
    expect(hasOversizedId3v2Tag(Buffer.from('RIFF....WAVEfmt ', 'latin1'))).toBe(false);
    expect(hasOversizedId3v2Tag(Buffer.alloc(5))).toBe(false);
  });
});

describe('AudioDnaEngine metadata parsing', () => {
  test('an ASF-header file declared as audio/mpeg never reaches the metadata parser', async () => {
    const asf = Buffer.concat([ASF_GUID, Buffer.alloc(4096, 7)]);
    const r = await new AudioDnaEngine().generate(file(asf), 'dna-asf');
    expect(parseMusicMetadataIsolated).not.toHaveBeenCalled();
    expect(r).toBeDefined(); // the engine still completes via its binary-analysis fallback
  });

  test('a file carrying an APEv2 tag signature never reaches the metadata parser', async () => {
    const withApeTag = Buffer.concat([Buffer.alloc(64, 2), Buffer.from('APETAGEX', 'ascii'), Buffer.alloc(24)]);
    const r = await new AudioDnaEngine().generate(file(withApeTag), 'dna-ape');
    expect(parseMusicMetadataIsolated).not.toHaveBeenCalled();
    expect(r).toBeDefined();
  });

  test('a file with an ID3v2 tag declaring a size larger than the file never reaches the metadata parser', async () => {
    const oversized = Buffer.concat([id3v2Header(0x0fffffff), Buffer.alloc(40)]);
    const r = await new AudioDnaEngine().generate(file(oversized), 'dna-id3-oversized');
    expect(parseMusicMetadataIsolated).not.toHaveBeenCalled();
    expect(r).toBeDefined();
  });

  test('a file with a legitimate, correctly-sized ID3v2 tag is still parsed (existing behavior preserved)', async () => {
    const legit = Buffer.concat([id3v2Header(20), Buffer.alloc(4096)]);
    await new AudioDnaEngine().generate(file(legit), 'dna-id3-ok');
    expect(parseMusicMetadataIsolated).toHaveBeenCalledTimes(1);
  });

  test('an ordinary audio file is still parsed', async () => {
    const wav = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4096, 3)]);
    await new AudioDnaEngine().generate(file(wav, 'audio/wav'), 'dna-wav');
    expect(parseMusicMetadataIsolated).toHaveBeenCalledTimes(1);
    expect(parseMusicMetadataIsolated).toHaveBeenCalledWith(wav, 'audio/wav', 10_000);
  });

  describe('timeout handling (engine-level — real worker termination is covered separately in music-metadata-worker-runner.test.ts)', () => {
    test('a TimeoutError from the isolated parser is caught and falls back to binary analysis instead of propagating', async () => {
      parseMusicMetadataIsolated.mockRejectedValue(new TimeoutError('music-metadata parseBuffer (worker)', 10_000));
      const wav = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4096, 3)]);

      const r = await new AudioDnaEngine().generate(file(wav, 'audio/wav'), 'dna-hang');

      expect(r).toBeDefined(); // completed via the fallback path instead of throwing/hanging
    });

    test('a non-timeout parse failure (e.g. a worker-reported parse error) is also caught and falls back', async () => {
      parseMusicMetadataIsolated.mockRejectedValue(new Error('music-metadata worker reported an unspecified parse failure'));
      const wav = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4096, 3)]);

      const r = await new AudioDnaEngine().generate(file(wav, 'audio/wav'), 'dna-parse-error');

      expect(r).toBeDefined();
    });
  });
});
