/** Evidence from whole-file and per-chunk hashes, attached to an investigation report (docs/LARGE_FILE_STREAMING_PROTECTION.md). */
export interface LargeFileEvidence {
  probe: {
    sizeBytes: number;
    sha256: string;
    merkleRoot: string;
    chunkSizeBytes: number;
    chunkCount: number;
    /** How the content-based part of the investigation saw this file, when it was too large to analyse whole. */
    analysisMode?: 'IMAGE_REDUCED_COPY' | 'SAMPLED_SEGMENTS' | 'WHOLE_FILE';
  };
  /** Protected files of this owner with exactly the same bytes. */
  exactMatches: Array<{
    dnaRecordId: string;
    vaultId: string | null;
    filename: string | null;
    protectedAt: string;
  }>;
  /** Protected large files of this owner that share whole chunks with the probe (a partial or truncated copy). */
  fragmentMatches: Array<{
    dnaRecordId: string;
    vaultId: string | null;
    filename: string;
    storedSizeBytes: number;
    storedMerkleRoot: string;
    storedChunkCount: number;
    matchedChunks: number;
    /** Share of the protected original's chunks found in the probe. */
    coverageOfOriginal: number;
    /** Share of the probe's chunks found in the protected original. */
    coverageOfProbe: number;
    longestRun: { probeStartChunk: number; storedStartChunk: number; length: number };
    /** Where the probe starts inside the original, in bytes, when the matching chunks agree on one position. */
    probeOffsetInOriginal: number | null;
    /** Inclusion proof for the first chunk of the longest run, checked against the stored Merkle root. */
    proof: { chunkIndex: number; chunkSha256: string; treeSize: number; auditPath: string[]; verified: boolean } | null;
  }>;
  notes: string[];
}
