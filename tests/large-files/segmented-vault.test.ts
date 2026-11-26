import './test-env';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LocalSegmentStore,
  MemorySegmentStore,
  decodeSegmentedPath,
  encodeSegmentedPath,
  isSegmentedPath,
  openDecryptedStream,
  removeSegments,
  segmentKey,
  writeEncryptedSegments,
} from '../../src/services/large-files/segmented-vault-store';
import { chunkedEncryptedSize } from '../../src/services/vault/chunked-encryption';
import { decrypt } from '../../src/services/vault/encryption.service';

const MiB = 1024 * 1024;
const key = crypto.randomBytes(32);
let dir: string;

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(p as Buffer);
  return Buffer.concat(parts);
}

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'segmented-'));
});
afterAll(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

async function writeFile(name: string, size: number): Promise<{ file: string; data: Buffer }> {
  const data = crypto.randomBytes(size);
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, data);
  return { file, data };
}

describe('segmented vault storage', () => {
  it('encrypts into segments no larger than the segment size and decrypts back exactly', async () => {
    const size = 9 * MiB + 1234;
    const { file, data } = await writeFile('a.bin', size);
    const store = new MemorySegmentStore();
    const segmentBytes = 2 * MiB;
    const written = await writeEncryptedSegments({ filePath: file, sizeBytes: size, vaultKey: key, store, prefix: 'owner/v1.enc.seg', segmentBytes });

    expect(written.encryptedSizeBytes).toBe(chunkedEncryptedSize(size));
    expect(written.segmentCount).toBe(Math.ceil(written.encryptedSizeBytes / segmentBytes));
    expect(store.objects.size).toBe(written.segmentCount);
    for (const obj of store.objects.values()) expect(obj.length).toBeLessThanOrEqual(segmentBytes);

    const plain = await collect(openDecryptedStream(store, 'owner/v1.enc.seg', written.segmentCount, key));
    expect(plain.equals(data)).toBe(true);

    // The joined segments are an ordinary v2 vault file: the existing decrypt() reads it too.
    const joined = Buffer.concat(Array.from({ length: written.segmentCount }, (_, i) => store.objects.get(segmentKey('owner/v1.enc.seg', i))!));
    expect(joined.subarray(0, 8).toString('latin1')).toBe('PINITV2\0');
  });

  it('works on local disk and removes every segment', async () => {
    const size = 3 * MiB;
    const { file, data } = await writeFile('b.bin', size);
    const store = new LocalSegmentStore(path.join(dir, 'vault'));
    const written = await writeEncryptedSegments({ filePath: file, sizeBytes: size, vaultKey: key, store, prefix: 'u1/v2.enc.seg', segmentBytes: MiB });
    expect((await collect(openDecryptedStream(store, 'u1/v2.enc.seg', written.segmentCount, key))).equals(data)).toBe(true);
    await removeSegments(store, 'u1/v2.enc.seg', written.segmentCount);
    expect(fs.readdirSync(path.join(dir, 'vault', 'u1', 'v2.enc.seg'))).toEqual([]);
  });

  it('detects a changed, missing or swapped segment', async () => {
    const size = 6 * MiB;
    const { file } = await writeFile('c.bin', size);
    const make = async () => {
      const store = new MemorySegmentStore();
      const w = await writeEncryptedSegments({ filePath: file, sizeBytes: size, vaultKey: key, store, prefix: 'p', segmentBytes: MiB });
      return { store, count: w.segmentCount };
    };

    const changed = await make();
    changed.store.objects.get(segmentKey('p', 2))![100] ^= 1;
    await expect(collect(openDecryptedStream(changed.store, 'p', changed.count, key))).rejects.toThrow();

    const missing = await make();
    await expect(collect(openDecryptedStream(missing.store, 'p', missing.count - 1, key))).rejects.toThrow();

    const swapped = await make();
    const a = swapped.store.objects.get(segmentKey('p', 1))!;
    swapped.store.objects.set(segmentKey('p', 1), swapped.store.objects.get(segmentKey('p', 3))!);
    swapped.store.objects.set(segmentKey('p', 3), a);
    await expect(collect(openDecryptedStream(swapped.store, 'p', swapped.count, key))).rejects.toThrow();

    const wrongKey = await make();
    await expect(collect(openDecryptedStream(wrongKey.store, 'p', wrongKey.count, crypto.randomBytes(32)))).rejects.toThrow();
  });

  it('leaves nothing behind when the source is shorter than declared', async () => {
    const { file } = await writeFile('d.bin', 2 * MiB);
    const store = new MemorySegmentStore();
    await expect(writeEncryptedSegments({ filePath: file, sizeBytes: 3 * MiB, vaultKey: key, store, prefix: 'q', segmentBytes: MiB })).rejects.toThrow();
    expect(store.objects.size).toBe(0);
  });

  it('a small v2 file still opens through the existing decrypt()', async () => {
    const { file, data } = await writeFile('e.bin', 50_000);
    const store = new MemorySegmentStore();
    const vaultId = crypto.randomUUID();
    const { deriveVaultKey } = await import('../../src/services/vault/encryption.service');
    const w = await writeEncryptedSegments({ filePath: file, sizeBytes: data.length, vaultKey: deriveVaultKey(vaultId), store, prefix: 'r', segmentBytes: MiB });
    expect(w.segmentCount).toBe(1);
    expect(decrypt(store.objects.get(segmentKey('r', 0))!, vaultId).equals(data)).toBe(true);
  });

  it('encodes and recognises segmented paths', () => {
    const p = encodeSegmentedPath('cloud', 'owner/vault.enc.seg');
    expect(isSegmentedPath(p)).toBe(true);
    expect(isSegmentedPath('owner/vault.enc')).toBe(false);
    expect(decodeSegmentedPath(p)).toEqual({ backend: 'cloud', prefix: 'owner/vault.enc.seg' });
    expect(() => new MemorySegmentStore().put('../escape', Buffer.alloc(1))).rejects.toThrow();
  });
});
