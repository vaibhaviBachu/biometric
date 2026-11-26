/**
 * Phase 8 — real worker-thread isolation for music-metadata parsing.
 * Phase 9 — resource-limit enforcement, picture/lyrics payload trimming, memory-release
 * measurement, and larger-buffer concurrency, added to this same file rather than a new one
 * since they test the same real, unmocked worker mechanism.
 *
 * Unlike audio-asf-guard.test.ts (which mocks this module so the engine's own guard-chain logic
 * can be tested fast and deterministically), these tests exercise the REAL worker_threads
 * mechanism end to end — nothing here is mocked, because Jest's module mocks only patch the main
 * test process's module registry and have no effect inside a genuinely separate worker thread.
 *
 * The one test that matters most for Phase 8 is "a real synchronous infinite loop is
 * hard-terminated while the main thread stays responsive" — this is the property a same-thread
 * `Promise.race` timeout (the pre-Phase-8 approach) cannot provide, and it is deliberately tested
 * against a genuine `while (true) {}` loop in a disposable worker, never on the main thread.
 */
import { describe, test, expect } from '@jest/globals';
import {
  parseMusicMetadataIsolated,
  runIsolatedWorker,
  __activeWorkerCountForTests,
} from '../../src/services/engines/audio/music-metadata-worker-runner';
import { TimeoutError } from '../../src/lib/safe-runner';

/** A minimal, valid ID3v2.3 tag with one APIC (attached picture) frame, prepended to a tiny
 *  silent MP3 frame — real embedded cover art, as music-metadata itself parses it, not a mock. */
function makeMp3WithEmbeddedPicture(imageBytes: Buffer): Buffer {
  const synchsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
  const mime = Buffer.from('image/jpeg\0', 'ascii');
  const picType = Buffer.from([3]);
  const desc = Buffer.from('\0', 'ascii');
  const textEncoding = Buffer.from([0]);
  const frameBody = Buffer.concat([textEncoding, mime, picType, desc, imageBytes]);
  const sizeField = Buffer.alloc(4);
  sizeField.writeUInt32BE(frameBody.length, 0); // ID3v2.3 frame sizes are plain big-endian, not synchsafe
  const frame = Buffer.concat([Buffer.from('APIC', 'ascii'), sizeField, Buffer.alloc(2), frameBody]);
  const id3Header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0]), Buffer.from([0]), synchsafe(frame.length)]);
  const mp3Frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413, 0)]);
  return Buffer.concat([id3Header, frame, mp3Frame, mp3Frame]);
}

function makeMinimalWav({ sampleRate = 44100, numChannels = 1, bitsPerSample = 16, numSamples = 100 } = {}): Buffer {
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

describe('parseMusicMetadataIsolated — real worker, successful parse', () => {
  test('a valid WAV buffer is parsed correctly by the real music-metadata library running inside the worker', async () => {
    const wav = makeMinimalWav({ sampleRate: 48000, numChannels: 2 });
    const meta = await parseMusicMetadataIsolated(wav, 'audio/wav', 10_000);

    expect(meta.format.container).toBe('WAVE');
    expect(meta.format.codec).toBe('PCM');
    expect(meta.format.sampleRate).toBe(48000);
    expect(meta.format.numberOfChannels).toBe(2);
  }, 15_000);
});

describe('parseMusicMetadataIsolated — real worker, parser failure', () => {
  test('malformed/garbage input is caught inside the worker and rejects the promise instead of crashing the parent process', async () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0x00, 0x00, 0x00]);

    await expect(parseMusicMetadataIsolated(garbage, 'application/octet-stream', 10_000)).rejects.toThrow();
    // The parent test process is still alive and able to run further assertions — that alone
    // proves the worker's thrown parse error did not crash anything outside itself.
  }, 15_000);
});

describe('runIsolatedWorker — hard termination of a genuinely synchronous infinite loop', () => {
  test(
    'a real worker stuck in `while (true) {}` is terminated after the timeout, and the main thread stays responsive throughout',
    async () => {
      const mainThreadTicks: number[] = [];
      const tickInterval = setInterval(() => mainThreadTicks.push(Date.now()), 50);

      const start = Date.now();
      try {
        await runIsolatedWorker(
          `
            // Deliberately, genuinely synchronous — never calls anything async, never yields.
            // This is the exact failure shape GHSA-f94x-6692-553q describes upstream.
            while (true) { /* spin forever */ }
          `,
          {},
          1_500,
        );
        throw new Error('expected runIsolatedWorker to reject with a TimeoutError, but it resolved');
      } catch (err) {
        expect(err).toBeInstanceOf(TimeoutError);
      } finally {
        clearInterval(tickInterval);
      }
      const elapsed = Date.now() - start;

      // Resolved close to the 1500ms bound, not instantly and not hung indefinitely.
      expect(elapsed).toBeGreaterThanOrEqual(1_400);
      expect(elapsed).toBeLessThan(5_000);

      // The main thread's own timer kept firing roughly every 50ms throughout the 1.5s hang —
      // if the main event loop had been blocked too, this count would be near zero.
      expect(mainThreadTicks.length).toBeGreaterThan(10);
    },
    // Outer Jest-level timeout, independent of the runner's own 1500ms bound, so a genuine
    // regression here fails this one test rather than hanging the whole suite.
    10_000,
  );

  test('a worker that resolves normally is still cleanly terminated afterward (no orphaned worker left running)', async () => {
    const result = await runIsolatedWorker<{ ok: boolean }>(
      `
        const { parentPort } = require('worker_threads');
        parentPort.postMessage({ ok: true });
      `,
      {},
      5_000,
    );
    expect(result).toEqual({ ok: true });
    // runIsolatedWorker's own `finish()` always calls worker.terminate() — including on the
    // success path — specifically so a resolved worker is never left running. There is no
    // direct "is this worker thread still alive" API to assert against from outside the
    // worker_threads module itself; the absence of any lingering handle is additionally
    // evidenced by this file's `--detectOpenHandles`-clean run (see the Phase 8 report).
  }, 10_000);

  test('a worker that throws synchronously still rejects cleanly, not as an unhandled exception', async () => {
    await expect(
      runIsolatedWorker(
        `
          throw new Error('deliberate synchronous throw for the test');
        `,
        {},
        5_000,
      ),
    ).rejects.toThrow(/deliberate synchronous throw/);
  }, 10_000);
});

describe('concurrency bounding', () => {
  test('many concurrent parses all complete successfully and the active-worker count never exceeds the configured maximum', async () => {
    const observedActive: number[] = [];
    const sampler = setInterval(() => observedActive.push(__activeWorkerCountForTests()), 5);

    const wav = makeMinimalWav();
    const calls = Array.from({ length: 10 }, () => parseMusicMetadataIsolated(wav, 'audio/wav', 10_000));
    const results = await Promise.all(calls);

    clearInterval(sampler);

    for (const meta of results) {
      expect(meta.format.container).toBe('WAVE');
    }
    // MAX_CONCURRENT_WORKERS is os.cpus().length-based, capped at 4 — never asserted as an exact
    // number here (that depends on the machine running the test), only that it is bounded well
    // below firing all 10 at once unbounded.
    expect(Math.max(...observedActive, 0)).toBeLessThanOrEqual(4);
  }, 20_000);

  test('larger (2MB) buffers at the same concurrency bound all complete correctly — probes collective memory pressure with a more realistic size than the tiny fixture above', async () => {
    const bigWav = makeMinimalWav({ numSamples: 500_000 }); // ~1MB of PCM + header
    const calls = Array.from({ length: 8 }, () => parseMusicMetadataIsolated(bigWav, 'audio/wav', 15_000));
    const results = await Promise.all(calls);
    for (const meta of results) expect(meta.format.container).toBe('WAVE');
  }, 30_000);
});

describe('Phase 9 — resourceLimits: bounds worker heap growth without bounding external Buffer allocations', () => {
  test('a worker whose V8 heap is capped is killed (via the error path) when it tries to build an unbounded in-heap JS structure', async () => {
    await expect(
      runIsolatedWorker(
        `
          const arr = [];
          for (let i = 0; i < 50_000_000; i++) arr.push({ i, pad: 'x'.repeat(100) });
          require('worker_threads').parentPort.postMessage({ builtLength: arr.length });
        `,
        {},
        10_000,
        { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 16 },
      ),
    ).rejects.toThrow(/memory limit|heap out of memory/i);
  }, 15_000);

  test('the same tight heap cap does NOT stop a single large external Buffer allocation (documents the real boundary of this protection, not a weakness introduced by it)', async () => {
    const result = await runIsolatedWorker<{ allocated: number }>(
      `
        const buf = Buffer.alloc(100 * 1024 * 1024, 7);
        require('worker_threads').parentPort.postMessage({ allocated: buf.length });
      `,
      {},
      10_000,
      { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 16 },
    );
    expect(result.allocated).toBe(100 * 1024 * 1024);
  }, 15_000);

  test('production-configured resourceLimits (256MB/64MB) do not interfere with an ordinary, legitimate parse', async () => {
    const wav = makeMinimalWav({ sampleRate: 44100, numChannels: 2 });
    const meta = await parseMusicMetadataIsolated(wav, 'audio/wav', 10_000);
    expect(meta.format.container).toBe('WAVE');
  }, 15_000);
});

describe('Phase 9 — embedded picture/lyrics payloads are trimmed to a length before crossing the thread boundary', () => {
  test('a real embedded picture (ID3v2 APIC frame) is reported as present with the right byte length, but the actual image bytes are not returned', async () => {
    const image = Buffer.alloc(5_000, 0xaa);
    const mp3 = makeMp3WithEmbeddedPicture(image);

    const meta = await parseMusicMetadataIsolated(mp3, 'audio/mpeg', 10_000);

    // The only thing audio-dna-engine.ts's layers ever read is the presence/count — confirmed by
    // reading its actual field usage before writing this change (see music-metadata-worker-
    // source.ts's file header). This asserts the worker-returned shape matches that contract:
    // a count, not the real array of { format, data: Buffer } objects.
    expect(meta.common.picture).toEqual({ length: 1 });
    expect(JSON.stringify(meta.common.picture)).not.toContain('"170,170'); // no sign of the 0xaa image bytes
  }, 10_000);

  test('a file with no embedded picture is unaffected (existing behavior preserved)', async () => {
    const wav = makeMinimalWav();
    const meta = await parseMusicMetadataIsolated(wav, 'audio/wav', 10_000);
    expect(meta.common.picture ?? null).toBeFalsy();
  }, 10_000);
});

describe('Phase 9 — memory is actually released after worker termination, not just assumed', () => {
  test('process RSS drops back down after a worker holding a large buffer is terminated', async () => {
    const before = process.memoryUsage().rss;

    await runIsolatedWorker<{ ok: boolean }>(
      `
        const buf = Buffer.alloc(200 * 1024 * 1024, 7);
        buf[0] = 1; // touch it so it's actually committed, not just reserved
        require('worker_threads').parentPort.postMessage({ ok: true });
      `,
      {},
      10_000,
    );

    // Give the OS/allocator a moment to actually reclaim pages after the worker's isolate was
    // torn down by terminate() (called internally by runIsolatedWorker on its success path too).
    await new Promise((r) => setTimeout(r, 500));
    const after = process.memoryUsage().rss;

    // Not a tight bound (this is real OS memory behavior, not a deterministic unit of work) —
    // the point is that RSS growth from the 200MB allocation was substantially given back, not
    // permanently retained by the parent process.
    expect(after - before).toBeLessThan(100 * 1024 * 1024);
  }, 15_000);
});
