import './test-env';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  computeLargeFileEvidence,
  investigateLargeFile,
  type LargeInvestigateDeps,
} from '../../src/services/large-files/large-file-investigate.service';
import { digestBuffer, verifyMerkleProof } from '../../src/services/large-files/stream-digest';
import type { UnifiedInvestigationReport } from '../../src/types/unified-investigation.types';
import { FakeManifests } from './fakes';

const MiB = 1024 * 1024;
const CHUNK = 4 * MiB;
const OWNER = 'owner-1';

async function setup() {
  const manifests = new FakeManifests();
  const original = crypto.randomBytes(10 * CHUNK + 123);
  const digest = digestBuffer(original, CHUNK);
  await manifests.create({ dnaRecordId: 'dna-orig', ownerUserId: OWNER, filename: 'film.mov', mimeType: 'video/quicktime', digest, analysisMode: 'SAMPLED_SEGMENTS', segments: [] });
  const id = Array.from(manifests.manifests.keys())[0]!;
  await manifests.attachVault(id, 'vault-orig', { segmented: true, backend: 'memory', prefix: 'p', segmentCount: 1, segmentBytes: 1, encryptedSizeBytes: 1, format: 'PINITV2' });
  // Someone else's file with the same bytes must never show up.
  await manifests.create({ dnaRecordId: 'dna-other', ownerUserId: 'owner-2', filename: 'x', mimeType: 'video/quicktime', digest, analysisMode: 'SAMPLED_SEGMENTS', segments: [] });
  const deps: Pick<LargeInvestigateDeps, 'manifests' | 'findExactRecords'> = {
    manifests: manifests.asRepository(),
    findExactRecords: async (owner, sha256) =>
      owner === OWNER && sha256 === digest.sha256 ? [{ dnaRecordId: 'dna-orig', vaultId: 'vault-orig', filename: 'film.mov', createdAt: new Date(0) }] : [],
  };
  return { original, digest, deps };
}

describe('large-file investigation evidence', () => {
  it('reports an exact copy by its whole-file hash', async () => {
    const { digest, deps } = await setup();
    const evidence = await computeLargeFileEvidence(digest, OWNER, deps);
    expect(evidence.exactMatches.map((m) => m.dnaRecordId)).toEqual(['dna-orig']);
    expect(evidence.fragmentMatches).toEqual([]); // not repeated as a fragment
  });

  it('finds a truncated copy (the first part of the original) and proves it against the Merkle root', async () => {
    const { original, deps } = await setup();
    const probe = original.subarray(0, 6 * CHUNK + 999); // a download that stopped part-way
    const evidence = await computeLargeFileEvidence(digestBuffer(probe, CHUNK), OWNER, deps);
    expect(evidence.exactMatches).toEqual([]);
    const match = evidence.fragmentMatches[0]!;
    expect(match.dnaRecordId).toBe('dna-orig');
    expect(match.matchedChunks).toBe(6);
    expect(match.coverageOfOriginal).toBeCloseTo(6 / 11);
    expect(match.longestRun).toEqual({ probeStartChunk: 0, storedStartChunk: 0, length: 6 });
    expect(match.probeOffsetInOriginal).toBe(0);
    expect(match.proof!.verified).toBe(true);
    expect(verifyMerkleProof(match.proof!.chunkSha256, match.proof!.chunkIndex, match.proof!.treeSize, match.proof!.auditPath, match.storedMerkleRoot)).toBe(true);
  });

  it('finds an aligned middle section and says where it sits in the original', async () => {
    const { original, deps } = await setup();
    const probe = original.subarray(3 * CHUNK, 8 * CHUNK);
    const match = (await computeLargeFileEvidence(digestBuffer(probe, CHUNK), OWNER, deps)).fragmentMatches[0]!;
    expect(match.matchedChunks).toBe(5);
    expect(match.probeOffsetInOriginal).toBe(3 * CHUNK);
    expect(match.longestRun.storedStartChunk).toBe(3);
  });

  it('does not match unrelated files or runs of zero bytes', async () => {
    const { deps } = await setup();
    const unrelated = await computeLargeFileEvidence(digestBuffer(crypto.randomBytes(3 * CHUNK), CHUNK), OWNER, deps);
    expect(unrelated.fragmentMatches).toEqual([]);
    const zeros = await computeLargeFileEvidence(digestBuffer(Buffer.alloc(2 * CHUNK), CHUNK), OWNER, deps);
    expect(zeros.fragmentMatches).toEqual([]);
    expect(zeros.notes.join(' ')).toMatch(/zero bytes/);
  });

  it('only looks at the investigating owner\'s files', async () => {
    const { original, deps } = await setup();
    const evidence = await computeLargeFileEvidence(digestBuffer(original.subarray(0, 2 * CHUNK), CHUNK), 'owner-3', deps);
    expect(evidence.fragmentMatches).toEqual([]);
  });

  it('investigates a large probe from disk and attaches the evidence to the report', async () => {
    const { original, deps } = await setup();
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'large-investigate-'));
    const file = path.join(dir, 'leak.mov');
    await fs.promises.writeFile(file, original.subarray(0, 9 * CHUNK));
    const seen: Array<{ size: number; mime: string }> = [];
    try {
      const report = await investigateLargeFile(
        { filePath: file, sizeBytes: 9 * CHUNK, originalName: 'leak.mov', mimeType: 'video/quicktime', ownerUserId: OWNER },
        {
          ...deps,
          runInvestigation: async (buffer, mime) => {
            seen.push({ size: buffer.length, mime });
            return { success: true, investigationId: 'inv-1' } as unknown as UnifiedInvestigationReport;
          },
        },
      );
      expect(seen[0]!.size).toBeLessThan(9 * CHUNK); // the orchestrator got the bounded sample
      expect(report.investigationId).toBe('inv-1');
      expect(report.largeFileEvidence.fragmentMatches[0]!.matchedChunks).toBe(9);
      expect(report.largeFileEvidence.probe.analysisMode).toBe('SAMPLED_SEGMENTS');
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
