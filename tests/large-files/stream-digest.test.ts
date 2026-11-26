import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  digestBuffer,
  digestFile,
  merkleProof,
  merkleRoot,
  verifyFragment,
  verifyMerkleProof,
} from '../../src/services/large-files/stream-digest';

const sha = (...parts: Buffer[]) => {
  const h = crypto.createHash('sha256');
  parts.forEach((p) => h.update(p));
  return h.digest();
};

/** RFC 6962 MTH written independently of the implementation, straight from the definition. */
function referenceRoot(digests: Buffer[]): Buffer {
  if (digests.length === 0) return sha();
  if (digests.length === 1) return sha(Buffer.from([0]), digests[0]!);
  let k = 1;
  while (k * 2 < digests.length) k *= 2;
  return sha(Buffer.from([1]), referenceRoot(digests.slice(0, k)), referenceRoot(digests.slice(k)));
}

describe('stream digest', () => {
  it('splits into fixed chunks and hashes the whole file and every chunk', () => {
    const data = crypto.randomBytes(10_000);
    const d = digestBuffer(data, 4096);
    expect(d.sizeBytes).toBe(10_000);
    expect(d.sha256).toBe(sha(data).toString('hex'));
    expect(d.chunkDigests).toEqual([
      sha(data.subarray(0, 4096)).toString('hex'),
      sha(data.subarray(4096, 8192)).toString('hex'),
      sha(data.subarray(8192)).toString('hex'),
    ]);
  });

  it('reads a file in a streaming pass and gives the same answer as the buffer', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'digest-'));
    const file = path.join(dir, 'f.bin');
    const data = crypto.randomBytes(3 * 1024 * 1024 + 17);
    await fs.promises.writeFile(file, data);
    try {
      expect(await digestFile(file, 1024 * 1024)).toEqual(digestBuffer(data, 1024 * 1024));
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('matches an independent RFC 6962 Merkle root for many tree sizes', () => {
    for (let n = 0; n <= 40; n++) {
      const digests = Array.from({ length: n }, (_, i) => sha(Buffer.from(`chunk-${i}`)));
      expect(merkleRoot(digests.map((d) => d.toString('hex')))).toBe(referenceRoot(digests).toString('hex'));
    }
  });

  it('proves every chunk of every tree size, and rejects wrong chunks, indexes and roots', () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 13, 16, 17, 31, 33]) {
      const hex = Array.from({ length: n }, (_, i) => sha(Buffer.from(`c${n}-${i}`)).toString('hex'));
      const root = merkleRoot(hex);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(hex, i);
        expect(verifyMerkleProof(hex[i]!, i, n, proof, root)).toBe(true);
        const other = sha(Buffer.from('not this chunk')).toString('hex');
        expect(verifyMerkleProof(other, i, n, proof, root)).toBe(false);
        if (n > 1) expect(verifyMerkleProof(hex[i]!, (i + 1) % n, n, proof, root)).toBe(false);
        expect(verifyMerkleProof(hex[i]!, i, n, proof, sha(Buffer.from('x')).toString('hex'))).toBe(false);
        if (proof.length) {
          const tampered = [...proof];
          tampered[0] = sha(Buffer.from('tamper')).toString('hex');
          expect(verifyMerkleProof(hex[i]!, i, n, tampered, root)).toBe(false);
        }
      }
    }
  });

  describe('fragment verification', () => {
    const chunk = 1000;
    const original = crypto.randomBytes(10_500);
    const stored = { ...digestBuffer(original, chunk) };

    it('verifies an aligned fragment chunk by chunk with proofs', () => {
      const v = verifyFragment(stored, 2000, original.subarray(2000, 6000));
      expect(v.checkedChunks.map((c) => c.chunkIndex)).toEqual([2, 3, 4, 5]);
      expect(v.allMatch).toBe(true);
      expect(v.verifiedBytes).toBe(4000);
      for (const c of v.checkedChunks) {
        expect(verifyMerkleProof(stored.chunkDigests[c.chunkIndex]!, c.chunkIndex, stored.chunkDigests.length, c.proof!, stored.merkleRoot)).toBe(true);
      }
    });

    it('checks only whole chunks inside an unaligned fragment, including the short last chunk', () => {
      const v = verifyFragment(stored, 1500, original.subarray(1500));
      expect(v.checkedChunks.map((c) => c.chunkIndex)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(v.allMatch).toBe(true);
      expect(v.verifiedBytes).toBe(8500);
    });

    it('finds the changed chunk in a tampered fragment', () => {
      const copy = Buffer.from(original.subarray(0, 5000));
      copy[3500] ^= 0xff;
      const v = verifyFragment(stored, 0, copy);
      expect(v.allMatch).toBe(false);
      expect(v.checkedChunks.filter((c) => !c.matches).map((c) => c.chunkIndex)).toEqual([3]);
    });

    it('refuses a fragment that does not fit in the file', () => {
      expect(() => verifyFragment(stored, 10_000, Buffer.alloc(600))).toThrow();
    });
  });
});
