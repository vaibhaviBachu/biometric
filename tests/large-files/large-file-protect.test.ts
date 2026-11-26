import './test-env';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LargeFileDuplicateError,
  protectLargeFile,
  type LargeProtectDeps,
} from '../../src/services/large-files/large-file-protect.service';
import { MemorySegmentStore, openDecryptedStream } from '../../src/services/large-files/segmented-vault-store';
import { SAMPLE_MAX_BYTES } from '../../src/services/large-files/analysis-input';
import { merkleRoot } from '../../src/services/large-files/stream-digest';
import type { FileInput } from '../../src/services/universal-file-router';
import { FakeManifests } from './fakes';

const MiB = 1024 * 1024;
const OWNER = 'owner-1';
let dir: string;
let file: string;
let data: Buffer;

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'large-protect-'));
  file = path.join(dir, 'movie.mp4');
  data = crypto.randomBytes(SAMPLE_MAX_BYTES + 9 * MiB + 77);
  data.write('\0\0\0\x18ftypmp42', 0, 'latin1');
  await fs.promises.writeFile(file, data);
});
afterAll(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<LargeProtectDeps> = {}) {
  const manifests = new FakeManifests();
  const store = new MemorySegmentStore();
  const calls = {
    generateDna: [] as FileInput[],
    identity: [] as Array<{ dnaRecordId: string; sha256: string; size: number }>,
    vault: [] as Array<Record<string, unknown>>,
    discarded: [] as string[],
  };
  const vaultKeys = new Map<string, Buffer>();
  const deps: LargeProtectDeps = {
    manifests: manifests.asRepository(),
    segmentStore: store,
    segmentBytes: 4 * MiB,
    vaultKeyFor: (id) => {
      if (!vaultKeys.has(id)) vaultKeys.set(id, crypto.randomBytes(32));
      return vaultKeys.get(id)!;
    },
    assertStorageAvailable: async () => undefined,
    checkDuplicate: async ({ sha256 }) => ({ isDuplicate: false, isHighRisk: false, sha256Hash: sha256 }),
    duplicateMessage: () => 'This file belongs to someone else.',
    generateDna: async (f) => {
      calls.generateDna.push(f);
      return {
        dnaRecordId: 'dna-1', schemaVersion: 's', fileType: 'VIDEO', engineVersion: 'e', detectedBy: 'magic',
        detectionConfidence: 'HIGH', status: 'COMPLETE', totalProcessingMs: 5, generatedAt: new Date(),
        layerSummary: { total: 10, successful: 10, failed: 0 },
      };
    },
    recordIdentity: async ({ dnaRecordId, digest }) => {
      calls.identity.push({ dnaRecordId, sha256: digest.sha256, size: digest.sizeBytes });
    },
    createVaultRecord: async (input) => {
      calls.vault.push(input as unknown as Record<string, unknown>);
      return { assetId: 'asset-1', createdAt: new Date() };
    },
    discardDna: async (id) => {
      calls.discarded.push(id);
    },
    ...overrides,
  };
  return { deps, manifests, store, calls, vaultKeys };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(p as Buffer);
  return Buffer.concat(parts);
}

describe('large-file protect pipeline', () => {
  it('protects from disk: DNA on a bounded sample, whole-file identity, chunked Vault in segments', async () => {
    const { deps, manifests, store, calls, vaultKeys } = makeDeps();
    const stages: string[] = [];
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const result = await protectLargeFile(
      { filePath: file, sizeBytes: data.length, originalName: 'movie.mp4', mimeType: 'video/mp4', ownerUserId: OWNER, expectedSha256: sha256 },
      deps,
      (s) => { if (stages[stages.length - 1] !== s) stages.push(s); },
    );

    expect(stages).toEqual(['checking-quota', 'hashing', 'analysing', 'checking-duplicates', 'generating-dna', 'recording-identity', 'encrypting', 'finishing']);
    // The engines saw a bounded sample that starts with the real header.
    expect(calls.generateDna[0]!.buffer.length).toBeLessThanOrEqual(SAMPLE_MAX_BYTES);
    expect(calls.generateDna[0]!.buffer.subarray(0, 12).equals(data.subarray(0, 12))).toBe(true);
    expect(calls.generateDna[0]!.sizeBytes).toBe(data.length);
    // The record gets the hash of every byte.
    expect(calls.identity).toEqual([{ dnaRecordId: 'dna-1', sha256, size: data.length }]);
    expect(result.sha256).toBe(sha256);

    const manifest = Array.from(manifests.manifests.values())[0]!;
    expect(manifest.vaultId).toBe(result.vaultId);
    expect(manifest.chunkCount).toBe(Math.ceil(data.length / (4 * MiB)));
    expect(manifest.merkleRoot).toBe(merkleRoot(manifests.chunks.get(manifest.id)!));
    expect(manifest.analysisMode).toBe('SAMPLED_SEGMENTS');
    expect(manifest.storage!.segmentCount).toBe(store.objects.size);

    // The vault copy decrypts to the original, byte for byte.
    const vault = calls.vault[0]!;
    expect(String(vault['encryptedFilePath'])).toBe(`segments:memory:${OWNER}/${result.vaultId}.enc.seg`);
    const plain = await collect(openDecryptedStream(store, `${OWNER}/${result.vaultId}.enc.seg`, manifest.storage!.segmentCount, vaultKeys.get(result.vaultId)!));
    expect(plain.equals(data)).toBe(true);
  });

  it('refuses a duplicate before generating any DNA or storing anything', async () => {
    const { deps, store, calls } = makeDeps({
      checkDuplicate: async ({ sha256 }) => ({ isDuplicate: true, isHighRisk: true, matchType: 'EXACT_HASH', sha256Hash: sha256, ownerShortId: 'PIN-X' }),
    });
    await expect(protectLargeFile({ filePath: file, sizeBytes: data.length, originalName: 'm.mp4', mimeType: 'video/mp4', ownerUserId: OWNER }, deps))
      .rejects.toBeInstanceOf(LargeFileDuplicateError);
    expect(calls.generateDna).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it('refuses a file that does not fit in storage before reading it', async () => {
    const quota = Object.assign(new Error('Not enough Vault storage.'), { name: 'StorageLimitError' });
    const { deps, calls } = makeDeps({ assertStorageAvailable: async () => { throw quota; } });
    await expect(protectLargeFile({ filePath: file, sizeBytes: data.length, originalName: 'm.mp4', mimeType: 'video/mp4', ownerUserId: OWNER }, deps)).rejects.toBe(quota);
    expect(calls.generateDna).toHaveLength(0);
  });

  it('refuses a file whose bytes do not match the checksum it was uploaded with', async () => {
    const { deps, calls } = makeDeps();
    await expect(protectLargeFile({ filePath: file, sizeBytes: data.length, originalName: 'm.mp4', mimeType: 'video/mp4', ownerUserId: OWNER, expectedSha256: 'a'.repeat(64) }, deps))
      .rejects.toThrow(/checksum/);
    expect(calls.generateDna).toHaveLength(0);
  });

  it('cleans up the DNA record and every stored segment when storage fails part-way', async () => {
    const { deps, store, calls } = makeDeps();
    let puts = 0;
    const realPut = store.put.bind(store);
    store.put = async (key, buf) => {
      if (++puts === 3) throw new Error('storage went away');
      return realPut(key, buf);
    };
    await expect(protectLargeFile({ filePath: file, sizeBytes: data.length, originalName: 'm.mp4', mimeType: 'video/mp4', ownerUserId: OWNER }, deps))
      .rejects.toThrow('storage went away');
    expect(store.objects.size).toBe(0);
    expect(calls.discarded).toEqual(['dna-1']);
    expect(calls.vault).toHaveLength(0);
  });
});
