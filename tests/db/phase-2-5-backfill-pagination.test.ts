/**
 * Phase 2.5 (DB-GAP-09) — `localDnaIndexService.backfillOwner` was rewritten
 * to page through a user's vault records via a stable `id` cursor instead of
 * one unbounded `findMany`, so a large vault no longer loads in a single
 * query. This proves completeness: every matching record is still visited
 * exactly once across page boundaries, even when the count is not a clean
 * multiple of the page size.
 *
 * Uses the real database and the real service — not a reimplementation of
 * its pagination logic — against the project's local dev database, per the
 * safety pattern in tests/db/phase-2-2-test-env.ts. Every seeded row's file
 * retrieval is expected to fail (no real Supabase Storage object exists for
 * it), which is fine: the pagination/completeness property being tested is
 * that every record is *visited* (indexed + failed together account for
 * every image row), not that every image is *successfully* indexed.
 *
 * Run with (after `docker compose -f docker-compose.dev.yml up -d`):
 *   PHASE_2_2_TEST_DATABASE_URL=postgresql://pinit:pinit@localhost:5435/pinit_hub npx jest tests/db/phase-2-5-backfill-pagination.test.ts
 */
import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, describeWithDb, TEST_DB_URL } from './phase-2-2-test-env';

jest.mock('../../src/lib/prisma', () => {
  const { PrismaClient: RealPrismaClient } = require('@prisma/client');
  const url = process.env['PHASE_2_2_TEST_DATABASE_URL'];
  return { prisma: new RealPrismaClient({ datasources: { db: { url } } }) };
});

describeWithDb('Phase 2.5 backfillOwner pagination (local PostgreSQL)', () => {
  let db: PrismaClient;
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `p25-user-${suffix}`;
  const TOTAL = 130; // not a multiple of the service's 100-row page size — crosses exactly one page boundary

  beforeAll(async () => {
    expect(TEST_DB_URL).toBeTruthy();
    db = createTestDb();
    await db.user.create({
      data: { id: userId, shortId: `P25${suffix}`, email: `p25-${suffix}@test.local`, passwordHash: 'x' },
    });
    for (let i = 0; i < TOTAL; i++) {
      const dnaId = `p25-dna-${suffix}-${i}`;
      await db.dnaRecord.create({
        data: {
          id: dnaId, imageFilename: `f${i}.jpg`, imageMimeType: 'image/jpeg', imageSizeBytes: 1000,
          ownerUserId: userId,
        },
      });
      await db.vaultRecord.create({
        data: {
          dnaRecordId: dnaId, encryptedFilePath: `vault/${dnaId}`, originalFileName: `f${i}.jpg`,
          originalMimeType: 'image/jpeg', encryptedSizeBytes: 1000, originalSizeBytes: 1000,
          ivHex: '0'.repeat(24), authTagHex: '0'.repeat(32),
        },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await db.vaultRecord.deleteMany({ where: { dnaRecord: { ownerUserId: userId } } }).catch(() => {});
    await db.dnaRecord.deleteMany({ where: { ownerUserId: userId } }).catch(() => {});
    await db.user.delete({ where: { id: userId } }).catch(() => {});
    await db.$disconnect();
  });

  test('every vault record across multiple pages is visited exactly once, none skipped or double-counted', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { localDnaIndexService } = require('../../src/services/forensics/local-dna-index.service');

    const result = await localDnaIndexService.backfillOwner(userId);

    // Every record's file retrieval fails (no real storage object exists for
    // these synthetic rows), so every one should land in `failed`, never in
    // `indexed`. The completeness property is that the two together equal
    // every image-type record created — none silently dropped at a page
    // boundary, none double-visited.
    expect(result.indexed).toBe(0);
    expect(result.failed).toBe(TOTAL);
  }, 120_000);
});
