/**
 * Protects a multi-GB synthetic file through the whole large-file pipeline and checks that memory stays bounded.
 *
 * The file is zero-extended to LARGE_FILE_TEST_GB (default 3 GiB, larger than a 32-bit size and than Node's 2 GiB
 * Buffer limit) with random marker blocks at the start, middle and end. Nothing in the pipeline may hold it whole.
 * The encrypted segments are not kept: each one is decrypted on arrival and the plaintext hashed, which proves the
 * Vault copy round-trips without needing another 3 GB of disk.
 *
 * Skipped when the temp disk has less than the file size plus 1 GiB free.
 */
import './test-env';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { protectLargeFile, type LargeProtectDeps } from '../../src/services/large-files/large-file-protect.service';
import { segmentKey, type SegmentStore } from '../../src/services/large-files/segmented-vault-store';
import { ChunkDecryptStream, chunkedEncryptedSize } from '../../src/services/vault/chunked-encryption';
import { SAMPLE_MAX_BYTES } from '../../src/services/large-files/analysis-input';
import { FakeManifests } from './fakes';

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;
const SIZE = Math.round(Number(process.env['LARGE_FILE_TEST_GB'] ?? '3') * GiB);
/**
 * Peak RSS growth allowed while protecting the file. Measured at about 320 MiB for 3 GiB on Node 24 / Windows: the
 * 32 MiB analysis sample, one 32 MiB storage segment (plus this test's decrypting copy), stream buffers, and garbage
 * the collector has not reclaimed yet. The stronger check is the second one: memory late in the file is no higher
 * than early in the file, i.e. it does not grow with the bytes processed.
 */
const MEMORY_BUDGET_BYTES = 512 * MiB;
/** How much higher the peak may be in the last two-thirds of encryption than in the first third. */
const LATE_GROWTH_ALLOWANCE_BYTES = 64 * MiB;

function freeBytes(dir: string): number {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return 0;
  }
}

const enoughDisk = freeBytes(os.tmpdir()) > SIZE + GiB;
const maybe = enoughDisk ? describe : describe.skip;

/** Decrypts every segment as it arrives (in order) and hashes the plaintext. Keeps nothing. */
class VerifyingStore implements SegmentStore {
  readonly backend = 'memory' as const;
  readonly hash = crypto.createHash('sha256');
  readonly segmentSizes: number[] = [];
  private decrypt: ChunkDecryptStream | null = null;
  plaintextBytes = 0;
  private finished: Promise<void> | null = null;

  start(key: Buffer): void {
    this.decrypt = new ChunkDecryptStream(key);
    this.decrypt.on('data', (d: Buffer) => {
      this.hash.update(d);
      this.plaintextBytes += d.length;
    });
    this.finished = new Promise((resolve, reject) => {
      this.decrypt!.on('end', resolve);
      this.decrypt!.on('error', reject);
    });
  }

  async put(key: string, data: Buffer): Promise<void> {
    expect(key).toBe(segmentKey(key.slice(0, key.lastIndexOf('/')), this.segmentSizes.length));
    this.segmentSizes.push(data.length);
    if (!this.decrypt!.write(Buffer.from(data))) await new Promise((r) => this.decrypt!.once('drain', r));
  }

  async end(): Promise<void> {
    this.decrypt!.end();
    await this.finished;
  }

  async get(): Promise<Buffer> {
    throw new Error('not kept');
  }

  async remove(): Promise<void> {
    /* nothing kept */
  }
}

maybe(`multi-GB file (${(SIZE / GiB).toFixed(1)} GiB) with bounded memory`, () => {
  let dir: string;
  let file: string;
  const markers: Array<{ offset: number; bytes: Buffer }> = [];

  beforeAll(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'multi-gb-'));
    file = path.join(dir, 'huge.mkv');
    const handle = await fs.promises.open(file, 'w');
    try {
      await handle.truncate(SIZE);
      for (const offset of [0, Math.floor(SIZE / 2) - 12_345, SIZE - 65_536]) {
        const bytes = crypto.randomBytes(65_536);
        bytes.write('\x1aE\xdf\xa3', 0, 'latin1'); // EBML magic at the very start
        await handle.write(bytes, 0, bytes.length, offset);
        markers.push({ offset, bytes });
      }
    } finally {
      await handle.close();
    }
  }, 600_000);

  afterAll(async () => {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('protects it end to end: whole-file identity, bounded DNA input, verified Vault copy, flat memory', async () => {
    const store = new VerifyingStore();
    const vaultKey = crypto.randomBytes(32);
    store.start(vaultKey);
    const manifests = new FakeManifests();
    let dnaInputBytes = 0;
    let vaultSize = 0;

    const deps: LargeProtectDeps = {
      manifests: manifests.asRepository(),
      segmentStore: store,
      segmentBytes: 32 * MiB,
      vaultKeyFor: () => vaultKey,
      assertStorageAvailable: async () => undefined,
      checkDuplicate: async ({ analysis, sha256 }) => {
        expect(analysis.buffer.length).toBeLessThanOrEqual(SAMPLE_MAX_BYTES);
        return { isDuplicate: false, isHighRisk: false, sha256Hash: sha256 };
      },
      duplicateMessage: () => '',
      generateDna: async (f) => {
        dnaInputBytes = f.buffer.length;
        return {
          dnaRecordId: 'dna-huge', schemaVersion: 's', fileType: 'VIDEO', engineVersion: 'e', detectedBy: 'magic',
          detectionConfidence: 'HIGH', status: 'COMPLETE', totalProcessingMs: 1, generatedAt: new Date(),
          layerSummary: { total: 1, successful: 1, failed: 0 },
        };
      },
      recordIdentity: async () => undefined,
      createVaultRecord: async ({ written }) => {
        vaultSize = written.encryptedSizeBytes;
        return { assetId: null, createdAt: new Date() };
      },
      discardDna: async () => undefined,
    };

    if (global.gc) global.gc();
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    let earlyPeak = baseline; // while encrypting the first third
    let latePeak = baseline; // while encrypting the rest
    let phase: 'other' | 'early' | 'late' = 'other';
    const sampler = setInterval(() => {
      const rss = process.memoryUsage().rss;
      peak = Math.max(peak, rss);
      if (phase === 'early') earlyPeak = Math.max(earlyPeak, rss);
      if (phase === 'late') latePeak = Math.max(latePeak, rss);
    }, 25);
    const started = Date.now();
    let result;
    try {
      result = await protectLargeFile(
        { filePath: file, sizeBytes: SIZE, originalName: 'huge.mkv', mimeType: 'video/x-matroska', ownerUserId: 'owner-1' },
        deps,
        (stage, progress) => {
          if (stage !== 'encrypting') phase = 'other';
          else phase = (progress ?? 0) < 1 / 3 ? 'early' : 'late';
        },
      );
      await store.end();
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    const growth = peak - baseline;
    // eslint-disable-next-line no-console
    console.log(`[multi-GB] ${(SIZE / GiB).toFixed(2)} GiB protected in ${((Date.now() - started) / 1000).toFixed(1)} s; `
      + `peak RSS growth ${(growth / MiB).toFixed(0)} MiB (budget ${MEMORY_BUDGET_BYTES / MiB} MiB); `
      + `${store.segmentSizes.length} segments; DNA input ${(dnaInputBytes / MiB).toFixed(0)} MiB; `
      + `encrypting peak growth first third ${((earlyPeak - baseline) / MiB).toFixed(0)} MiB, rest ${((latePeak - baseline) / MiB).toFixed(0)} MiB`);

    expect(result.sizeBytes).toBe(SIZE);
    expect(result.analysisMode).toBe('SAMPLED_SEGMENTS');
    expect(dnaInputBytes).toBeLessThanOrEqual(SAMPLE_MAX_BYTES);
    // Every byte went through the Vault and decrypts to exactly the bytes that were hashed.
    expect(vaultSize).toBe(chunkedEncryptedSize(SIZE));
    expect(store.plaintextBytes).toBe(SIZE);
    expect(store.hash.digest('hex')).toBe(result.sha256);
    expect(Math.max(...store.segmentSizes)).toBeLessThanOrEqual(32 * MiB);
    // The manifest holds one digest per 4 MiB chunk and a Merkle root.
    const manifest = Array.from(manifests.manifests.values())[0]!;
    expect(manifest.chunkCount).toBe(Math.ceil(SIZE / (4 * MiB)));
    expect(manifest.sizeBytes).toBe(SIZE);
    // Memory did not grow with the file.
    expect(growth).toBeLessThan(MEMORY_BUDGET_BYTES);
    expect(latePeak - earlyPeak).toBeLessThan(LATE_GROWTH_ALLOWANCE_BYTES);
  }, 1_800_000);
});

if (!enoughDisk) {
  // eslint-disable-next-line no-console
  console.warn(`[multi-GB] skipped: needs ${((SIZE + GiB) / GiB).toFixed(1)} GiB free in ${os.tmpdir()}`);
}
