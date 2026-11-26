/**
 * The large-file SQL against a real PostgreSQL: the ensure script, the manifest repository and the job queue.
 *
 * Runs only with UPLOAD_TEST_DATABASE_URL pointing at a database on this computer (docker/upload-test), never the
 * project's DATABASE_URL. Skipped otherwise.
 *   docker compose -f docker/upload-test/docker-compose.yml up -d
 *   UPLOAD_TEST_DATABASE_URL=postgresql://pinit_test:pinit_test_only@127.0.0.1:55432/pinit_upload_test npx jest tests/large-files
 */
import './test-env';
import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { createTestDb, describeWithDb } from '../uploads/upload-test-env';
import { LargeFileManifestRepository } from '../../src/services/large-files/large-file-manifest.repository';
import { LargeFileJobService, describeJobError } from '../../src/services/large-files/large-file-jobs.service';
import { digestBuffer } from '../../src/services/large-files/stream-digest';
import { UploadError } from '../../src/services/uploads/upload-errors';
import type { CompletedUpload } from '../../src/services/uploads/upload-session.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SQL: LARGE_SQL } = require('../../scripts/ensure-large-file-tables.cjs') as { SQL: string[] };

describe('job error descriptions', () => {
  it('tells the client why without internal detail', () => {
    expect(describeJobError(new Error('ECONNRESET at 10.0.0.3:5432'), 'PROTECT')).toEqual({ code: 'PROTECT_FAILED', message: 'Protection could not be completed. Try again.' });
    expect(describeJobError(Object.assign(new Error('Not enough Vault storage.'), { name: 'StorageLimitError', incomingBytes: 5, remainingBytes: 1, requiredPlan: 'PRO' }), 'PROTECT'))
      .toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED', fileBytes: 5, remainingBytes: 1, requiredPlan: 'PRO' });
    expect(describeJobError(new Error('Unsupported file type: x'), 'PROTECT')!.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(describeJobError(UploadError.notFound(), 'INVESTIGATE')!.code).toBe('UPLOAD_NOT_FOUND');
  });
});

describeWithDb('large-file tables (local PostgreSQL)', () => {
  let db: PrismaClient;
  const OWNER = `owner-${crypto.randomUUID()}`;

  beforeAll(async () => {
    db = createTestDb();
    // The manifests reference dna_records; the throwaway database only needs its key.
    await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "dna_records" ("id" TEXT PRIMARY KEY)');
    for (const sql of LARGE_SQL) await db.$executeRawUnsafe(sql);
    for (const sql of LARGE_SQL) await db.$executeRawUnsafe(sql); // idempotent
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('stores a manifest with its chunks and finds fragments for the owner only', async () => {
    const repo = new LargeFileManifestRepository(db);
    const dnaRecordId = crypto.randomUUID();
    await db.$executeRawUnsafe('INSERT INTO "dna_records" ("id") VALUES ($1)', dnaRecordId);
    const data = crypto.randomBytes(5 * 4096 + 10);
    const digest = digestBuffer(data, 4096);
    const sizeOver2GiB = { ...digest, sizeBytes: 5 * 1024 * 1024 * 1024 }; // BIGINT survives
    const id = await repo.create({ dnaRecordId, ownerUserId: OWNER, filename: 'f.bin', mimeType: 'application/octet-stream', digest: sizeOver2GiB, analysisMode: 'SAMPLED_SEGMENTS', segments: [{ offset: 0, length: 10, sha256: 'a'.repeat(64) }] });
    await repo.attachVault(id, 'vault-1', { segmented: true, backend: 'cloud', prefix: 'p', segmentCount: 3, segmentBytes: 32, encryptedSizeBytes: 99, format: 'PINITV2' });

    const found = await repo.findByVaultId('vault-1');
    expect(found).toMatchObject({ id, dnaRecordId, sizeBytes: 5 * 1024 * 1024 * 1024, sha256: digest.sha256, merkleRoot: digest.merkleRoot, chunkCount: 6 });
    expect(found!.storage!.segmentCount).toBe(3);
    expect(found!.sampling!.segments).toHaveLength(1);
    expect(await repo.chunkDigests(id)).toEqual(digest.chunkDigests);
    expect((await repo.findBySha256(OWNER, digest.sha256)).map((m) => m.id)).toEqual([id]);

    const hits = await repo.matchChunks(OWNER, [digest.chunkDigests[2]!, digest.chunkDigests[4]!, 'f'.repeat(64)]);
    expect(hits.map((h) => h.chunkIndex).sort()).toEqual([2, 4]);
    expect(await repo.matchChunks('someone-else', digest.chunkDigests)).toEqual([]);
    expect(await repo.findManyByIds('someone-else', [id])).toEqual([]);

    // Deleting the DNA record removes its manifest and chunks.
    await db.$executeRawUnsafe('DELETE FROM "dna_records" WHERE "id" = $1', dnaRecordId);
    expect(await repo.findByVaultId('vault-1')).toBeNull();
    expect(await repo.chunkDigests(id)).toEqual([]);
  });

  describe('job queue', () => {
    function makeService(runner: (upload: CompletedUpload) => Promise<unknown>) {
      const released: string[] = [];
      const service = new LargeFileJobService({
        db,
        concurrency: 1,
        progressWriteMs: 0,
        uploads: {
          openCompleted: async (owner: string, id: string) => {
            if (owner !== OWNER) throw UploadError.notFound();
            return { id, sizeBytes: 10, sha256: 'a'.repeat(64), filePath: '/tmp/x', filename: 'x.bin', mimeType: 'application/octet-stream' };
          },
          release: async (_owner: string, id: string) => {
            released.push(id);
          },
        },
        runners: {
          protect: async (upload, _owner, _input, onStage) => {
            onStage('hashing', 0.5);
            return runner(upload);
          },
          investigate: async (upload) => runner(upload),
        },
      });
      return { service, released };
    }

    it('runs a job to success, stores the result and frees the upload', async () => {
      const { service, released } = makeService(async () => ({ dnaRecordId: 'd1', vaultId: 'v1' }));
      const uploadId = crypto.randomUUID();
      const started = await service.start(OWNER, 'PROTECT', uploadId, { note: 'x' });
      expect(['QUEUED', 'RUNNING', 'SUCCEEDED']).toContain(started.status);
      await service.whenIdle();
      const done = await service.get(OWNER, started.id);
      expect(done).toMatchObject({ status: 'SUCCEEDED', stage: 'done', progress: 1, result: { dnaRecordId: 'd1', vaultId: 'v1' }, error: null });
      expect(released).toEqual([uploadId]);
      // Starting again for the same upload returns the same job.
      expect((await service.start(OWNER, 'PROTECT', uploadId, {})).id).toBe(started.id);
      // Another owner cannot see it.
      await expect(service.get('someone-else', started.id)).rejects.toMatchObject({ status: 404 });
    });

    it('records a refusal with its code, frees the upload, and allows a fresh attempt', async () => {
      const dup = Object.assign(new Error('Belongs to PIN-1'), { name: 'LargeFileDuplicateError', duplicate: { matchType: 'EXACT_HASH', ownerShortId: 'PIN-1', isHighRisk: true } });
      const { service, released } = makeService(async () => { throw dup; });
      const uploadId = crypto.randomUUID();
      const job = await service.start(OWNER, 'PROTECT', uploadId, {});
      await service.whenIdle();
      const failed = await service.get(OWNER, job.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.error).toMatchObject({ code: 'DUPLICATE', ownerShortId: 'PIN-1', riskLevel: 'HIGH' });
      expect(released).toEqual([uploadId]);
      const retry = await service.start(OWNER, 'PROTECT', uploadId, {});
      expect(retry.id).not.toBe(job.id);
      await service.whenIdle();
    });

    it('keeps the upload for a retry after an unexpected failure', async () => {
      const { service, released } = makeService(async () => { throw new Error('disk full at /var/tmp'); });
      const job = await service.start(OWNER, 'INVESTIGATE', crypto.randomUUID(), {});
      await service.whenIdle();
      const failed = await service.get(OWNER, job.id);
      expect(failed.error).toEqual({ code: 'INVESTIGATION_FAILED', message: 'The investigation could not be completed. Try again.' });
      expect(released).toEqual([]);
    });

    it('runs one job at a time and queues the rest', async () => {
      let running = 0;
      let peak = 0;
      const { service } = makeService(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 30));
        running -= 1;
        return {};
      });
      const jobs = await Promise.all([1, 2, 3].map(() => service.start(OWNER, 'INVESTIGATE', crypto.randomUUID(), {})));
      await service.whenIdle();
      expect(peak).toBe(1);
      for (const j of jobs) expect((await service.get(OWNER, j.id)).status).toBe('SUCCEEDED');
    });

    it('refuses to start a job for an upload the caller does not own', async () => {
      const { service } = makeService(async () => ({}));
      await expect(service.start('someone-else', 'PROTECT', crypto.randomUUID(), {})).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    });

    it('marks jobs left unfinished by a restart as failed', async () => {
      const id = crypto.randomUUID();
      await db.$executeRawUnsafe(
        `INSERT INTO large_file_jobs ("id", "ownerUserId", "uploadSessionId", "kind", "status") VALUES ($1, $2, $3, 'PROTECT', 'RUNNING')`,
        id, OWNER, crypto.randomUUID(),
      );
      const { service } = makeService(async () => ({}));
      expect(await service.recoverInterrupted()).toBeGreaterThanOrEqual(1);
      expect((await service.get(OWNER, id)).error!.code).toBe('INTERRUPTED');
    });
  });
});
