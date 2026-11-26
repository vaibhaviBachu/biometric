/**
 * Settings for the large-file path (docs/LARGE_FILE_STREAMING_PROTECTION.md).
 *
 * Read straight from the environment so the streaming services can be loaded and tested without the full app config.
 * Files at or below `thresholdBytes` keep the existing in-memory pipeline unchanged; larger files are streamed.
 */
import os from 'os';
import path from 'path';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function intFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Env var ${key} must be a positive integer, got: ${raw}`);
  return value;
}

export const largeFileConfig = {
  /** Above this size a file is never read into memory whole. */
  thresholdBytes: intFromEnv('LARGE_FILE_THRESHOLD_BYTES', 256 * MiB),
  /** Fixed chunk size for per-chunk hashes and the Merkle tree. Changing it makes old and new manifests incomparable. */
  merkleChunkBytes: 4 * MiB,
  /** Size of each object the encrypted Vault file is cut into (Supabase free plan caps one object at 50 MB). */
  storageSegmentBytes: intFromEnv('LARGE_FILE_SEGMENT_BYTES', 32 * MiB),
  /** Largest file accepted by an upload session. The owner's Vault quota is checked separately. */
  maxUploadBytes: intFromEnv('LARGE_FILE_MAX_BYTES', 64 * GiB),
  /** Upload sessions write parts here. Must have room for the largest file being uploaded. */
  uploadSessionDir: path.resolve(process.env['UPLOAD_SESSION_DIR'] ?? path.join(os.tmpdir(), 'pinit-upload-sessions')),
  /** Investigation uploads land here (disk, not memory). */
  investigationTempDir: path.resolve(process.env['INVESTIGATION_TEMP_DIR'] ?? path.join(os.tmpdir(), 'pinit-investigations')),
  /** Large protect/investigate jobs run at the same time in one process. */
  jobConcurrency: intFromEnv('LARGE_FILE_JOB_CONCURRENCY', 1),
  /** Pixel guard for decoding a large image to build its analysis copy. */
  maxAnalysisPixels: intFromEnv('LARGE_FILE_MAX_ANALYSIS_PIXELS', 1_000_000_000),
} as const;

/** The 32-bit size columns (vault_records, dna_records) hold at most this; the true size lives in large_file_manifests. */
export const INT32_MAX = 2_147_483_647;

export function clampToInt32(n: number): number {
  return Math.min(n, INT32_MAX);
}
