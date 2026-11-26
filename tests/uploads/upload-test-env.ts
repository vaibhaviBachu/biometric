/**
 * Test environment for the upload sessions: a separate local PostgreSQL (Docker) and a temporary folder on local disk.
 *
 * These tests NEVER use the project's DATABASE_URL, Supabase or any production credential. They run only when
 * UPLOAD_TEST_DATABASE_URL is set, and only if it points at this computer. Otherwise they are skipped.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { Readable } from 'stream';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SQL } = require('../../scripts/ensure-upload-sessions.cjs') as { SQL: string[] };

export const TEST_DB_URL = process.env['UPLOAD_TEST_DATABASE_URL'] ?? '';

export function assertLocalDatabase(url: string): void {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('UPLOAD_TEST_DATABASE_URL is not a valid URL');
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`Refusing to run upload tests against a non-local database host (${host}).`);
  }
  if (process.env['DATABASE_URL'] && url === process.env['DATABASE_URL']) {
    throw new Error('UPLOAD_TEST_DATABASE_URL must not be the project DATABASE_URL.');
  }
}

/** `describe` that only runs when the local test database is configured. */
export const describeWithDb: jest.Describe = TEST_DB_URL ? describe : describe.skip;

export function createTestDb(): PrismaClient {
  assertLocalDatabase(TEST_DB_URL);
  return new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
}

export async function ensureTables(db: PrismaClient): Promise<void> {
  for (const statement of SQL) await db.$executeRawUnsafe(statement);
}

export async function resetTables(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE upload_session_parts, upload_sessions');
}

export function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pinit-upload-${label}-`));
}

export const sha256 = (data: Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

export function streamOf(data: Buffer): Readable {
  return Readable.from([data]);
}

/** A stream that delivers part of its data, then breaks like a dropped connection. */
export function brokenStream(data: Buffer, afterBytes: number): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(data.subarray(0, afterBytes));
      } else {
        this.destroy(new Error('connection lost'));
      }
    },
  });
}

/** A stream that is slow, so two requests can overlap. */
export function slowStream(data: Buffer, steps = 4, delayMs = 40): Readable {
  const size = Math.ceil(data.length / steps);
  let at = 0;
  return new Readable({
    read() {
      if (at >= data.length) {
        this.push(null);
        return;
      }
      const piece = data.subarray(at, at + size);
      at += size;
      setTimeout(() => this.push(piece), delayMs);
    },
  });
}

export function splitParts(data: Buffer, chunk: number): Buffer[] {
  const parts: Buffer[] = [];
  for (let at = 0; at < data.length; at += chunk) parts.push(data.subarray(at, Math.min(at + chunk, data.length)));
  return parts;
}
