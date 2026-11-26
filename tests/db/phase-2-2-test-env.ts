/**
 * Test environment for Phase 2.2 referential-integrity tests: the full
 * application schema on a separate local PostgreSQL (the per-developer dev
 * database documented in docker-compose.dev.yml, NOT the project's
 * DATABASE_URL). Mirrors the safety pattern already established in
 * tests/uploads/upload-test-env.ts.
 *
 * These tests run only when PHASE_2_2_TEST_DATABASE_URL is set and points
 * at this computer. Otherwise they are skipped.
 */
import { PrismaClient } from '@prisma/client';

export const TEST_DB_URL = process.env['PHASE_2_2_TEST_DATABASE_URL'] ?? '';

export function assertLocalDatabase(url: string): void {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('PHASE_2_2_TEST_DATABASE_URL is not a valid URL');
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(`Refusing to run Phase 2.2 referential-integrity tests against a non-local database host (${host}).`);
  }
  if (process.env['DATABASE_URL'] && url === process.env['DATABASE_URL']) {
    throw new Error('PHASE_2_2_TEST_DATABASE_URL must not be the project DATABASE_URL.');
  }
}

/** `describe` that only runs when the local test database is configured. */
export const describeWithDb: jest.Describe = TEST_DB_URL ? describe : describe.skip;

export function createTestDb(): PrismaClient {
  assertLocalDatabase(TEST_DB_URL);
  return new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
}
