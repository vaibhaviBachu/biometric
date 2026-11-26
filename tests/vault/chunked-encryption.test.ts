import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  CHUNKED_HEADER_BYTES,
  ChunkDecryptStream,
  ChunkEncryptStream,
  chunkedEncryptedSize,
  decryptChunkedBuffer,
  decryptFileChunked,
  encryptChunkedBuffer,
  encryptFileChunked,
  isChunkedFormat,
} from '../../src/services/vault/chunked-encryption';
import { decrypt, deriveVaultKey, encrypt } from '../../src/services/vault/encryption.service';

const KEY = crypto.randomBytes(32);
const SMALL = 12; // 4 KiB chunks, so every boundary case is cheap
const CHUNK = 2 ** SMALL;

const sizes = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 3, CHUNK * 3 + 17];

function tmp(name: string): string {
  return path.join(os.tmpdir(), `pinit-chunked-${process.pid}-${crypto.randomBytes(4).toString('hex')}-${name}`);
}


/** Pushes the pieces through a transform and returns everything it produced. */
async function run(pieces: Buffer[], transform: Transform): Promise<Buffer> {
  const parts: Buffer[] = [];
  const sink = new Writable({ write(chunk, _enc, cb) { parts.push(chunk as Buffer); cb(); } });
  await pipeline(Readable.from(pieces), transform, sink);
  return Buffer.concat(parts);
}

describe('chunked vault format (v2)', () => {
  test.each(sizes)('buffer round trip, %i bytes', (size) => {
    const plain = crypto.randomBytes(size);
    const enc = encryptChunkedBuffer(plain, KEY, SMALL);
    expect(isChunkedFormat(enc)).toBe(true);
    expect(enc.length).toBe(chunkedEncryptedSize(size, SMALL));
    expect(decryptChunkedBuffer(enc, KEY).equals(plain)).toBe(true);
  });

  test('every encryption is different (fresh salt) and carries no plaintext', () => {
    const plain = Buffer.from('the same bytes '.repeat(500));
    const a = encryptChunkedBuffer(plain, KEY, SMALL);
    const b = encryptChunkedBuffer(plain, KEY, SMALL);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('the same bytes'))).toBe(false);
  });

  test('a wrong key fails', () => {
    const enc = encryptChunkedBuffer(crypto.randomBytes(CHUNK * 2), KEY, SMALL);
    expect(() => decryptChunkedBuffer(enc, crypto.randomBytes(32))).toThrow();
  });

  describe('tampering is detected', () => {
    const plain = crypto.randomBytes(CHUNK * 3 + 100);
    const enc = encryptChunkedBuffer(plain, KEY, SMALL);
    const wire = CHUNK + 16;

    test('a changed ciphertext byte', () => {
      const bad = Buffer.from(enc);
      bad[CHUNKED_HEADER_BYTES + 10] ^= 1;
      expect(() => decryptChunkedBuffer(bad, KEY)).toThrow();
    });
    test('a changed tag byte', () => {
      const bad = Buffer.from(enc);
      bad[CHUNKED_HEADER_BYTES + CHUNK + 3] ^= 1;
      expect(() => decryptChunkedBuffer(bad, KEY)).toThrow();
    });
    test('a changed header (salt)', () => {
      const bad = Buffer.from(enc);
      bad[14] ^= 1;
      expect(() => decryptChunkedBuffer(bad, KEY)).toThrow();
    });
    test('two chunks swapped', () => {
      const bad = Buffer.from(enc);
      const first = Buffer.from(bad.subarray(CHUNKED_HEADER_BYTES, CHUNKED_HEADER_BYTES + wire));
      const second = Buffer.from(bad.subarray(CHUNKED_HEADER_BYTES + wire, CHUNKED_HEADER_BYTES + 2 * wire));
      second.copy(bad, CHUNKED_HEADER_BYTES);
      first.copy(bad, CHUNKED_HEADER_BYTES + wire);
      expect(() => decryptChunkedBuffer(bad, KEY)).toThrow();
    });
    test('the last chunk dropped', () => {
      expect(() => decryptChunkedBuffer(enc.subarray(0, enc.length - (100 + 16)), KEY)).toThrow();
    });
    test('extra bytes appended', () => {
      expect(() => decryptChunkedBuffer(Buffer.concat([enc, Buffer.from('x')]), KEY)).toThrow();
    });
    test('a truncated file in the stream decryptor', async () => {
      await expect(run([enc.subarray(0, enc.length - 20)], new ChunkDecryptStream(KEY))).rejects.toThrow();
    });
  });

  describe('streams and files', () => {
    test.each(sizes)('stream encrypt then decrypt, %i bytes, odd read sizes', async (size) => {
      const plain = crypto.randomBytes(size);
      const pieces: Buffer[] = [];
      for (let at = 0; at < plain.length; at += 1000) pieces.push(plain.subarray(at, Math.min(at + 1000, plain.length)));
      const enc = await run(pieces, new ChunkEncryptStream(KEY, size, SMALL));
      expect(enc.length).toBe(chunkedEncryptedSize(size, SMALL));
      expect(decryptChunkedBuffer(enc, KEY).equals(plain)).toBe(true);

      const oddly: Buffer[] = [];
      for (let at = 0; at < enc.length; at += 777) oddly.push(enc.subarray(at, Math.min(at + 777, enc.length)));
      const back = await run(oddly, new ChunkDecryptStream(KEY));
      expect(back.equals(plain)).toBe(true);
    });

    test('an input that does not match the declared length is refused', async () => {
      await expect(run([crypto.randomBytes(100)], new ChunkEncryptStream(KEY, 200, SMALL))).rejects.toThrow();
      await expect(run([crypto.randomBytes(300)], new ChunkEncryptStream(KEY, 200, SMALL))).rejects.toThrow();
    });

    test('file to file round trip', async () => {
      const input = tmp('in.bin');
      const enc = tmp('enc.bin');
      const out = tmp('out.bin');
      const plain = crypto.randomBytes(CHUNK * 5 + 9);
      fs.writeFileSync(input, plain);
      try {
        const result = await encryptFileChunked(input, enc, KEY, SMALL);
        expect(result.originalSizeBytes).toBe(plain.length);
        expect(fs.statSync(enc).size).toBe(result.encryptedSizeBytes);
        await decryptFileChunked(enc, out, KEY);
        expect(fs.readFileSync(out).equals(plain)).toBe(true);
      } finally {
        for (const f of [input, enc, out]) fs.rmSync(f, { force: true });
      }
    });
  });

  describe('compatibility with the original format (v1)', () => {
    test('decrypt() still reads v1 files, and reads v2 files', () => {
      const vaultId = 'vault-compat-1';
      const plain = crypto.randomBytes(5000);
      const v1 = encrypt(plain, vaultId).encryptedBuffer;
      expect(isChunkedFormat(v1)).toBe(false);
      expect(decrypt(v1, vaultId).equals(plain)).toBe(true);

      const v2 = encryptChunkedBuffer(plain, deriveVaultKey(vaultId), SMALL);
      expect(decrypt(v2, vaultId).equals(plain)).toBe(true);
    });

    test('a v1 file whose first bytes look like anything else is never mistaken for v2', () => {
      for (let i = 0; i < 500; i++) {
        const v1 = encrypt(crypto.randomBytes(64), `vault-${i}`).encryptedBuffer;
        expect(isChunkedFormat(v1)).toBe(false);
      }
    });
  });

  test('memory stays bounded while encrypting and decrypting a large file', async () => {
    const input = tmp('big-in.bin');
    const enc = tmp('big-enc.bin');
    const out = tmp('big-out.bin');
    const total = 400 * 1024 * 1024;
    const block = crypto.randomBytes(1 << 20);
    const writer = fs.createWriteStream(input);
    for (let written = 0; written < total; written += block.length) {
      if (!writer.write(block)) await new Promise((resolve) => writer.once('drain', resolve));
    }
    await new Promise((resolve) => writer.end(resolve));

    // Buffers and heap together: this is what the process itself holds (the OS file cache is not counted).
    const held = () => { const m = process.memoryUsage(); return m.arrayBuffers + m.heapUsed; };
    global.gc?.();
    const baseline = held();
    let peak = baseline;
    const sampler = setInterval(() => { peak = Math.max(peak, held()); }, 25);
    try {
      await encryptFileChunked(input, enc, deriveVaultKey('vault-big'));
      await decryptFileChunked(enc, out, deriveVaultKey('vault-big'));
    } finally {
      clearInterval(sampler);
    }
    const grewMb = (peak - baseline) / (1024 * 1024);
    // 400 MB went through. A whole-file implementation holds several copies of it (well over 1 GB).
    expect(grewMb).toBeLessThan(250);
    expect(fs.statSync(out).size).toBe(total);
    const a = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
    const b = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
    expect(b).toBe(a);
    for (const f of [input, enc, out]) fs.rmSync(f, { force: true });
  }, 240000);
});
