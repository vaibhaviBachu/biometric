/**
 * PINIT-DNA — Supabase Storage client
 *
 * Used exclusively for vault file storage (encrypted .enc blobs).
 * The database is accessed via Prisma/DATABASE_URL — this client is
 * only for the Storage API (bucket: vault-files).
 */

import { type SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseNodeClient } from './supabase-node';
import { logger } from './logger';
import { forensicFlag } from '../config/forensic-flags';
import { countOps } from './ops-metrics';
import fs from 'fs/promises';
import path from 'path';

const BUCKET = 'vault-files';

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env['SUPABASE_URL'] ?? '';
  // Prefer the service-role key (bypasses RLS); fall back to the anon key so the
  // app still boots on projects where only the public anon key is configured.
  const key = process.env['SUPABASE_SERVICE_KEY']?.trim()
    || process.env['SUPABASE_ANON_KEY']?.trim()
    || '';

  if (!url || !key) {
    throw new Error('SUPABASE_URL and a Supabase key (SERVICE or ANON) must be set for vault storage');
  }

  _client = createSupabaseNodeClient(url, key);
  logger.info('[Storage] Supabase Storage client initialised');
  return _client;
}

export function isSupabaseStorageRestricted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  return /egress_quota|exceed_cached_egress|project is restricted|Failed to create storage bucket|Supabase upload failed/i.test(msg);
}

/** Ensure the vault-files bucket exists, creating it if not. */
async function ensureBucket(): Promise<void> {
  const client = getClient();
  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) {
    logger.warn('[Storage] listBuckets failed — assuming vault-files exists', { error: listError.message });
    return;
  }
  const exists = buckets?.some((b) => b.name === BUCKET);
  if (!exists) {
    const { error } = await client.storage.createBucket(BUCKET, { public: false });
    if (error) throw new Error(`Failed to create storage bucket: ${error.message}`);
    logger.info('[Storage] Created bucket', { bucket: BUCKET });
  }
}

let _bucketReady = false;

// A vault upload used to be one request with no time limit and no retry: a connection that stalled (or a slow hop between the
// server and Supabase) left the whole protect request hanging with nothing written. Each attempt now has a limit that grows with
// the file's size, a failed or timed-out attempt is retried, and the error says which attempt failed. The upload is an upsert of
// the same bytes, so a repeat is safe even if an earlier attempt finished late.
export const UPLOAD_ATTEMPTS = 3;

export function uploadTimeoutMs(bytes: number): number {
  return Math.min(300_000, 45_000 + Math.ceil(bytes / (1024 * 1024)) * 5_000);
}

/** Errors a retry cannot fix (size limit, permissions, missing bucket): fail at once with the real message. */
export function isPermanentStorageError(message: string): boolean {
  return /maximum allowed size|payload too large|not authorized|unauthorized|row-level security|invalid api key|bucket not found|egress_quota|exceed_cached_egress|project is restricted/i.test(message);
}

export async function uploadWithRetry(
  storagePath: string,
  buffer: Buffer,
  context: { vaultId?: string } = {},
  attempts: number = UPLOAD_ATTEMPTS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutOverrideMs?: number,
): Promise<void> {
  const timeoutMs = timeoutOverrideMs ?? uploadTimeoutMs(buffer.length);
  let lastError: Error = new Error('Supabase upload failed');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        getClient().storage.from(BUCKET).upload(storagePath, buffer, { contentType: 'application/octet-stream', upsert: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Supabase upload failed: no answer after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
        }),
      ]);
      if (result.error) throw new Error(`Supabase upload failed: ${result.error.message}`);
      logger.info('[Storage] Uploaded vault file', { ...context, storagePath, bytes: buffer.length, attempt, ms: Date.now() - started });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger.warn('[Storage] Vault upload attempt failed', {
        ...context, storagePath, bytes: buffer.length, attempt, of: attempts, ms: Date.now() - started, error: lastError.message,
      });
      if (isPermanentStorageError(lastError.message) || attempt === attempts) break;
      await sleep(1_000 * 2 ** (attempt - 1));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError;
}

/** Upload encrypted buffer to Supabase Storage. Returns the storage path. */
export async function uploadVaultFile(vaultId: string, buffer: Buffer, ownerUserId?: string): Promise<string> {
  const storagePath = ownerUserId ? `${ownerUserId}/${vaultId}.enc` : `${vaultId}.enc`;

  if (!_bucketReady) {
    await ensureBucket();
    _bucketReady = true;
  }

  await uploadWithRetry(storagePath, buffer, { vaultId });
  return storagePath;
}

/** Store one already-encrypted object at an exact key (a segment of a large vault file). */
export async function uploadVaultObject(storagePath: string, buffer: Buffer): Promise<void> {
  if (!_bucketReady) {
    await ensureBucket();
    _bucketReady = true;
  }
  const { error } = await getClient().storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: 'application/octet-stream',
    upsert: true,
  });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
}

/** Delete objects at exact keys. Non-fatal, like deleteVaultFile. */
export async function deleteVaultObjects(storagePaths: string[]): Promise<void> {
  if (storagePaths.length === 0) return;
  const { error } = await getClient().storage.from(BUCKET).remove(storagePaths);
  if (error) logger.warn('[Storage] Object delete failed (non-fatal)', { count: storagePaths.length, error: error.message });
}

/**
 * Phase 9 — read-only listing for DB/Storage reconciliation (REL7-06). The
 * Supabase Storage `.list()` call only lists one "folder" level at a time
 * (it is not recursive), so vault objects — all keyed `{ownerUserId}/{id}.enc`
 * — require listing each owner prefix separately. Paginated via `limit`/
 * `offset` so a large bucket is never pulled in one unbounded call.
 */
const LIST_PAGE_SIZE = 1000;

/** Top-level entries under the bucket root — each ownerUserId acts as a "folder" prefix. */
export async function listVaultOwnerPrefixes(): Promise<string[]> {
  const prefixes: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await getClient().storage.from(BUCKET).list('', { limit: LIST_PAGE_SIZE, offset });
    if (error) throw new Error(`Supabase list (root) failed: ${error.message}`);
    const page = data ?? [];
    // Supabase represents a "folder" as an entry with id === null.
    prefixes.push(...page.filter((entry) => entry.id === null).map((entry) => entry.name));
    if (page.length < LIST_PAGE_SIZE) break;
    offset += LIST_PAGE_SIZE;
  }
  return prefixes;
}

/** All object keys under one owner prefix, paginated. */
export async function listVaultObjectKeysUnderPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await getClient().storage.from(BUCKET).list(prefix, { limit: LIST_PAGE_SIZE, offset });
    if (error) throw new Error(`Supabase list ("${prefix}") failed: ${error.message}`);
    const page = data ?? [];
    keys.push(...page.filter((entry) => entry.id !== null).map((entry) => `${prefix}/${entry.name}`));
    if (page.length < LIST_PAGE_SIZE) break;
    offset += LIST_PAGE_SIZE;
  }
  return keys;
}

/** Every vault object key in the bucket. Read-only; makes (prefixCount + 1) paginated list calls, never a bulk/unbounded one. */
export async function listAllVaultObjectKeys(): Promise<string[]> {
  const prefixes = await listVaultOwnerPrefixes();
  const all: string[] = [];
  for (const prefix of prefixes) {
    all.push(...(await listVaultObjectKeysUnderPrefix(prefix)));
  }
  return all;
}

/**
 * Phase 9 — REL7-03 fix. Live reachability probe, distinct from
 * `isSupabaseStorageConfigured()` (which only checks that env vars are
 * set). A one-item list call is the cheapest real round-trip against the
 * actual bucket; the caller (health.ts) applies its own timeout.
 */
export async function checkReachability(): Promise<void> {
  const { error } = await getClient().storage.from(BUCKET).list('', { limit: 1 });
  if (error) throw new Error(error.message);
}

/** True when Supabase Storage env vars are present (required in production). */
export function isSupabaseStorageConfigured(): boolean {
  const url = process.env['SUPABASE_URL']?.trim() ?? '';
  const key = process.env['SUPABASE_SERVICE_KEY']?.trim()
    || process.env['SUPABASE_ANON_KEY']?.trim()
    || '';
  return Boolean(url && key);
}

/** Normalise a DB-stored path to a Supabase object key. */
export function normalizeVaultStoragePath(storedPath: string, vaultId: string): string {
  const norm = storedPath.replace(/\\/g, '/');
  // Already a bucket-relative key, e.g. "{ownerUserId}/{vaultId}.enc"
  if (!norm.includes(':') && norm.endsWith('.enc') && !norm.startsWith('/')) {
    return norm;
  }
  const base = norm.split('/').filter(Boolean).pop();
  return base?.endsWith('.enc') ? base : `${vaultId}.enc`;
}

/** Download encrypted buffer from Supabase Storage by object key. */
export async function downloadVaultFileByPath(storagePath: string): Promise<Buffer> {
  const { data, error } = await getClient().storage.from(BUCKET).download(storagePath);
  if (error || !data) {
    throw new Error(`Supabase download failed: ${error?.message ?? `no data for ${storagePath}`}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Storage could not be reached (network failure, timeout, server error). The file may well be there: nothing says it is gone.
 * Callers must not tell the person to protect the file again.
 */
export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

/** The bucket answered and the object is not there (as opposed to not answering). */
export function isMissingObjectMessage(message: string): boolean {
  return /object not found|not found|no such (file|object)|does not exist|\b404\b/i.test(message) && !/bucket not found/i.test(message);
}

export const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 120_000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One object, tried up to three times with 0.5 s and 1 s pauses when the failure looks temporary. A missing object or a
 * permanent error (permissions, size) fails at once. Downloading is a read, so repeating it is always safe.
 */
export async function downloadObjectWithRetry(
  storagePath: string,
  deps: { download?: (path: string) => Promise<Buffer>; sleep?: (ms: number) => Promise<void>; attempts?: number } = {},
): Promise<Buffer> {
  const download = deps.download ?? downloadVaultFileByPath;
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = deps.attempts ?? DOWNLOAD_ATTEMPTS;
  let last: Error = new Error('unknown');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Supabase download failed: no answer after ${DOWNLOAD_ATTEMPT_TIMEOUT_MS / 1000}s`)), DOWNLOAD_ATTEMPT_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        return await Promise.race([download(storagePath), limit]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
      if (isMissingObjectMessage(last.message) || isPermanentStorageError(last.message)) throw last;
      if (attempt === attempts) break;
      countOps('storage_retried');
      logger.warn('[Storage] Download attempt failed; trying again', { storagePath, attempt, of: attempts, error: last.message.slice(0, 160) });
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw new StorageUnavailableError(`Supabase download failed after ${attempts} attempts: ${last.message}`, attempts);
}

/** Download encrypted buffer from Supabase Storage. */
export async function downloadVaultFile(
  vaultId: string,
  ownerUserId: string,
  extraPaths: string[] = [],
): Promise<Buffer> {
  if (!ownerUserId) {
    throw new Error('Vault download requires verified ownerUserId');
  }
  const paths = [
    ...extraPaths.map((p) => normalizeVaultStoragePath(p, vaultId)),
    `${ownerUserId}/${vaultId}.enc`,
    `${vaultId}.enc`,
  ].filter((p, i, arr): p is string => Boolean(p) && arr.indexOf(p) === i);

  const resilient = forensicFlag('STORAGE_RETRY');
  let lastError: Error | null = null;
  let unreachable: StorageUnavailableError | null = null;
  for (const storagePath of paths) {
    try {
      return resilient ? await downloadObjectWithRetry(storagePath) : await downloadVaultFileByPath(storagePath);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof StorageUnavailableError) unreachable = err;
    }
  }

  // If storage could not be reached for any path, we do not know the file is missing: say so, so nobody is told to re-protect it.
  if (unreachable) {
    countOps('storage_unreachable');
    throw unreachable;
  }
  throw new Error(`Supabase download failed: ${lastError?.message ?? 'unknown'}`);
}

// ── Private objects (government ID copies, already encrypted by the caller) ──
// Production always uses Supabase. Local development without Supabase (the
// isolated test setup) keeps them on local disk, like vault files, so the full
// ID flow can be tested without touching production storage.
function privateLocalDir(): string | null {
  if (process.env['NODE_ENV'] === 'production' || isSupabaseStorageConfigured()) return null;
  return path.resolve(process.env['VAULT_STORAGE_DIR'] ?? './vault/encrypted', 'private');
}

function privatePathOk(storagePath: string): boolean {
  return storagePath.startsWith('government-id/') && !storagePath.includes('..') && !storagePath.includes('\\');
}

/** True when encrypted ID copies can be stored: Supabase, or local disk in development. */
export function isPrivateStorageAvailable(): boolean {
  return isSupabaseStorageConfigured() || privateLocalDir() !== null;
}

/** Reads back an encrypted private object (still encrypted), for review. */
export async function downloadPrivateObject(storagePath: string): Promise<Buffer> {
  if (!privatePathOk(storagePath)) throw new Error('Refused private object path');
  const local = privateLocalDir();
  if (local) return fs.readFile(path.join(local, storagePath));
  const { data, error } = await getClient().storage.from(BUCKET).download(storagePath);
  if (error || !data) throw new Error(`Supabase download failed: ${error?.message ?? 'no data'}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Upload an already-encrypted private object. Refuses paths outside government-id/. */
export async function uploadPrivateObject(storagePath: string, buffer: Buffer): Promise<void> {
  if (!privatePathOk(storagePath)) {
    throw new Error('Refused private object path');
  }
  const local = privateLocalDir();
  if (local) {
    const file = path.join(local, storagePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buffer);
    return;
  }
  if (!_bucketReady) {
    await ensureBucket();
    _bucketReady = true;
  }
  const { error } = await getClient().storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: 'application/octet-stream',
    upsert: true,
  });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
}

export async function deletePrivateObject(storagePath: string): Promise<void> {
  if (!privatePathOk(storagePath)) return;
  const local = privateLocalDir();
  if (local) {
    await fs.rm(path.join(local, storagePath), { force: true });
    return;
  }
  const { error } = await getClient().storage.from(BUCKET).remove([storagePath]);
  if (error) logger.warn('[Storage] Private object delete failed', { storagePath, error: error.message });
}

/** Delete vault file from Supabase Storage (on vault record deletion). */
export async function deleteVaultFile(
  vaultId: string,
  options?: { ownerUserId?: string; storedPath?: string },
): Promise<void> {
  const paths = [
    options?.storedPath ? normalizeVaultStoragePath(options.storedPath, vaultId) : null,
    options?.ownerUserId ? `${options.ownerUserId}/${vaultId}.enc` : null,
    `${vaultId}.enc`,
  ].filter((p, i, arr): p is string => Boolean(p) && arr.indexOf(p) === i);

  for (const storagePath of paths) {
    const { error } = await getClient().storage.from(BUCKET).remove([storagePath]);
    if (!error) {
      logger.debug('[Storage] Deleted vault file', { vaultId, storagePath });
      return;
    }
  }

  logger.warn('[Storage] Delete failed (non-fatal)', { vaultId });
}

/**
 * Check whether an encrypted vault blob exists in Supabase (or return null paths tried).
 * Uses Storage list metadata — does not download file bytes.
 */
export async function findVaultFileInSupabase(
  vaultId: string,
  options?: { ownerUserId?: string; storedPath?: string },
): Promise<{ exists: boolean; size: number | null; storagePath: string | null }> {
  const paths = [
    options?.storedPath ? normalizeVaultStoragePath(options.storedPath, vaultId) : null,
    options?.ownerUserId ? `${options.ownerUserId}/${vaultId}.enc` : null,
    `${vaultId}.enc`,
  ].filter((p, i, arr): p is string => Boolean(p) && arr.indexOf(p) === i);

  for (const storagePath of paths) {
    const segments = storagePath.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) continue;
    const folder = segments.join('/');

    const { data, error } = await getClient().storage.from(BUCKET).list(folder || '', {
      search: fileName,
      limit: 20,
    });

    if (error) {
      logger.debug('[Storage] list failed', { storagePath, error: error.message });
      continue;
    }

    const match = data?.find((f) => f.name === fileName);
    if (match) {
      const sizeRaw = (match as { metadata?: { size?: number }; meta?: { size?: number } }).metadata?.size
        ?? (match as { meta?: { size?: number } }).meta?.size
        ?? null;
      const size = typeof sizeRaw === 'number' ? sizeRaw : null;
      return { exists: true, size, storagePath };
    }
  }

  return { exists: false, size: null, storagePath: null };
}
