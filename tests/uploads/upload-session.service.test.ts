import crypto from 'crypto';
import fs from 'fs';
import type { PrismaClient } from '@prisma/client';
import { LocalUploadStorage } from '../../src/services/uploads/local-upload-storage';
import { UploadSessionService, UploadLimits, cleanFilename } from '../../src/services/uploads/upload-session.service';
import { UploadError } from '../../src/services/uploads/upload-errors';
import {
  brokenStream, createTestDb, describeWithDb, ensureTables, resetTables, sha256, slowStream, splitParts, streamOf, tempDir,
} from './upload-test-env';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const CHUNK = 4096;

const LIMITS: Partial<UploadLimits> = {
  maxBytes: 1024 * 1024,
  defaultChunkBytes: CHUNK,
  minChunkBytes: 1024,
  maxChunkBytes: 64 * 1024,
  maxParts: 500,
  maxActivePerOwner: 3,
  maxReservedBytesPerOwner: 2 * 1024 * 1024,
  writeTimeoutMs: 1000,
};

async function rejectsWith(promise: Promise<unknown>, status: number, code?: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).status).toBe(status);
    if (code) expect((err as UploadError).code).toBe(code);
    return;
  }
  throw new Error('Expected the call to be refused');
}

describeWithDb('resumable upload sessions (service, local Postgres and disk)', () => {
  let db: PrismaClient;
  let root: string;
  let storage: LocalUploadStorage;
  let clock = new Date('2026-10-14T10:00:00Z');
  let service: UploadSessionService;

  const make = (extra: Partial<UploadLimits> = {}, quota?: (o: string, n: number) => Promise<void>) =>
    new UploadSessionService({ db, storage, limits: { ...LIMITS, ...extra }, assertQuota: quota, now: () => clock });

  beforeAll(async () => {
    db = createTestDb();
    await ensureTables(db);
    await ensureTables(db); // running the script twice changes nothing
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetTables(db);
    root = tempDir('svc');
    storage = new LocalUploadStorage(root);
    clock = new Date('2026-10-14T10:00:00Z');
    service = make();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const newUpload = async (data: Buffer, owner = ALICE, extra: Record<string, unknown> = {}) =>
    service.create(owner, { filename: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: data.length, ...extra });

  const sendAll = async (id: string, data: Buffer, owner = ALICE, order?: number[]) => {
    const parts = splitParts(data, CHUNK);
    for (const i of order ?? parts.map((_, n) => n)) {
      await service.putPart(owner, id, i, streamOf(parts[i]!), { sha256: sha256(parts[i]!), contentLength: parts[i]!.length });
    }
  };

  test('uploads parts out of order, completes, and keeps the file byte for byte', async () => {
    const data = crypto.randomBytes(CHUNK * 5 + 123);
    const session = await newUpload(data);
    expect(session.totalParts).toBe(6);
    expect(session.status).toBe('INITIATED');
    await sendAll(session.id, data, ALICE, [3, 0, 5, 1, 4, 2]);
    const done = await service.complete(ALICE, session.id, { sha256: sha256(data) });
    expect(done.status).toBe('COMPLETE');
    expect(done.sha256).toBe(sha256(data));
    const file = await service.openCompleted(ALICE, session.id);
    expect(fs.readFileSync(file.filePath).equals(data)).toBe(true);
    expect(file.sizeBytes).toBe(data.length);
  });

  test('resumes after an interruption, even in a new process', async () => {
    const data = crypto.randomBytes(CHUNK * 4);
    const session = await newUpload(data);
    await sendAll(session.id, data, ALICE, [0, 1]);

    const restarted = make(); // a fresh service object, as after a restart
    const view = await restarted.get(ALICE, session.id);
    expect(view.receivedRanges).toEqual([[0, 1]]);
    expect(view.status).toBe('UPLOADING');
    const parts = splitParts(data, CHUNK);
    for (const i of [2, 3]) await restarted.putPart(ALICE, session.id, i, streamOf(parts[i]!), { sha256: sha256(parts[i]!), contentLength: parts[i]!.length });
    await restarted.complete(ALICE, session.id, { sha256: sha256(data) });
    expect(fs.readFileSync((await restarted.openCompleted(ALICE, session.id)).filePath).equals(data)).toBe(true);
  });

  describe('duplicates', () => {
    test('the same part sent twice is accepted without writing again', async () => {
      const data = crypto.randomBytes(CHUNK * 2);
      const s = await newUpload(data);
      const parts = splitParts(data, CHUNK);
      const meta = { sha256: sha256(parts[0]!), contentLength: CHUNK };
      expect((await service.putPart(ALICE, s.id, 0, streamOf(parts[0]!), meta)).duplicate).toBe(false);
      expect((await service.putPart(ALICE, s.id, 0, streamOf(parts[0]!), meta)).duplicate).toBe(true);
    });

    test('a stored part is never overwritten by different bytes', async () => {
      const data = crypto.randomBytes(CHUNK * 2);
      const s = await newUpload(data);
      const parts = splitParts(data, CHUNK);
      await service.putPart(ALICE, s.id, 0, streamOf(parts[0]!), { sha256: sha256(parts[0]!), contentLength: CHUNK });
      const other = crypto.randomBytes(CHUNK);
      await rejectsWith(
        service.putPart(ALICE, s.id, 0, streamOf(other), { sha256: sha256(other), contentLength: CHUNK }),
        409, 'PART_ALREADY_STORED',
      );
      await service.putPart(ALICE, s.id, 1, streamOf(parts[1]!), { sha256: sha256(parts[1]!), contentLength: CHUNK });
      await service.complete(ALICE, s.id, { sha256: sha256(data) }); // the file is still the original
    });

    test('two requests for the same part at once: one writes, the other is told or accepted', async () => {
      const data = crypto.randomBytes(CHUNK);
      const s = await newUpload(data);
      const meta = { sha256: sha256(data), contentLength: CHUNK };
      const results = await Promise.allSettled([
        service.putPart(ALICE, s.id, 0, slowStream(data), meta),
        service.putPart(ALICE, s.id, 0, slowStream(data), meta),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const r of results) if (r.status === 'rejected') expect((r.reason as UploadError).code).toBe('PART_IN_PROGRESS');
      await service.complete(ALICE, s.id, { sha256: sha256(data) });
    });

    test('creating the same upload twice with one idempotency key gives one session', async () => {
      const data = crypto.randomBytes(CHUNK);
      const a = await newUpload(data, ALICE, { idempotencyKey: 'retry-key-0001' });
      const b = await newUpload(data, ALICE, { idempotencyKey: 'retry-key-0001' });
      expect(b.id).toBe(a.id);
      await rejectsWith(service.create(ALICE, { filename: 'other.jpg', sizeBytes: 10, idempotencyKey: 'retry-key-0001' }), 409, 'IDEMPOTENCY_KEY_REUSED');
      const raced = await Promise.all([1, 2, 3].map(() => newUpload(data, BOB, { idempotencyKey: 'race-key-00001' })));
      expect(new Set(raced.map((r) => r.id)).size).toBe(1);
      await rejectsWith(newUpload(data, ALICE, { idempotencyKey: 'short' }), 400, 'INVALID_IDEMPOTENCY_KEY');
    });

    test('completing twice is safe', async () => {
      const data = crypto.randomBytes(CHUNK);
      const s = await newUpload(data);
      await sendAll(s.id, data);
      const first = await service.complete(ALICE, s.id, { sha256: sha256(data) });
      const second = await service.complete(ALICE, s.id, { sha256: sha256(data) });
      expect(second.status).toBe('COMPLETE');
      expect(second.sha256).toBe(first.sha256);
      await rejectsWith(service.complete(ALICE, s.id, { sha256: sha256(Buffer.from('x')) }), 422, 'CHECKSUM_MISMATCH');
    });

    test('two completions at once finish once', async () => {
      const data = crypto.randomBytes(CHUNK * 3);
      const s = await newUpload(data);
      await sendAll(s.id, data);
      const results = await Promise.allSettled([
        service.complete(ALICE, s.id, { sha256: sha256(data) }),
        service.complete(ALICE, s.id, { sha256: sha256(data) }),
      ]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      for (const r of results) if (r.status === 'rejected') expect((r.reason as UploadError).code).toBe('COMPLETE_IN_PROGRESS');
      expect((await service.get(ALICE, s.id)).status).toBe('COMPLETE');
    });
  });

  describe('damaged and interrupted parts', () => {
    test('a corrupted part is refused, leaves no record, and can be sent again', async () => {
      const data = crypto.randomBytes(CHUNK * 2);
      const s = await newUpload(data);
      const parts = splitParts(data, CHUNK);
      const damaged = Buffer.from(parts[0]!);
      damaged[100] ^= 0xff;
      await rejectsWith(service.putPart(ALICE, s.id, 0, streamOf(damaged), { sha256: sha256(parts[0]!), contentLength: CHUNK }), 422, 'CHECKSUM_MISMATCH');
      expect((await service.get(ALICE, s.id)).receivedRanges).toEqual([]);
      await sendAll(s.id, data);
      await service.complete(ALICE, s.id, { sha256: sha256(data) });
      expect(fs.readFileSync((await service.openCompleted(ALICE, s.id)).filePath).equals(data)).toBe(true);
    });

    test('a part of the wrong size is refused (declared, too short, too long)', async () => {
      const data = crypto.randomBytes(CHUNK * 2);
      const s = await newUpload(data);
      const part = splitParts(data, CHUNK)[0]!;
      await rejectsWith(service.putPart(ALICE, s.id, 0, streamOf(part.subarray(0, 100)), { sha256: sha256(part), contentLength: 100 }), 400, 'PART_SIZE_MISMATCH');
      await rejectsWith(service.putPart(ALICE, s.id, 0, streamOf(part.subarray(0, 100)), { sha256: sha256(part), contentLength: CHUNK }), 400, 'PART_SIZE_MISMATCH');
      const longer = Buffer.concat([part, Buffer.from('extra')]);
      await rejectsWith(service.putPart(ALICE, s.id, 0, streamOf(longer), { sha256: sha256(part), contentLength: CHUNK }), 400, 'PART_SIZE_MISMATCH');
      await rejectsWith(service.putPart(ALICE, s.id, 0, streamOf(part), { sha256: sha256(part), contentLength: undefined }), 411, 'LENGTH_REQUIRED');
      expect((await service.get(ALICE, s.id)).receivedRanges).toEqual([]);
    });

    test('a connection that drops mid-part leaves no record and the part can be resent', async () => {
      const data = crypto.randomBytes(CHUNK * 2);
      const s = await newUpload(data);
      const part = splitParts(data, CHUNK)[0]!;
      await expect(
        service.putPart(ALICE, s.id, 0, brokenStream(part, 1000), { sha256: sha256(part), contentLength: CHUNK }),
      ).rejects.toThrow();
      expect((await service.get(ALICE, s.id)).receivedRanges).toEqual([]);
      await sendAll(s.id, data);
      await service.complete(ALICE, s.id, { sha256: sha256(data) });
    });

    test('a write that crashed (stale record) is taken over; a fresh one is not', async () => {
      const data = crypto.randomBytes(CHUNK);
      const s = await newUpload(data);
      const meta = { sha256: sha256(data), contentLength: CHUNK };
      await db.$executeRaw`INSERT INTO upload_session_parts ("sessionId", "partIndex", "sizeBytes", "sha256", "state", "createdAt", "updatedAt")
        VALUES (${s.id}, 0, ${CHUNK}, ${meta.sha256}, 'WRITING', ${clock}, ${clock})`;
      await rejectsWith(service.putPart(ALICE, s.id, 0, streamOf(data), meta), 409, 'PART_IN_PROGRESS');
      clock = new Date(clock.getTime() + 5000); // past the 1 second write timeout
      const took = await service.putPart(ALICE, s.id, 0, streamOf(data), meta);
      expect(took.duplicate).toBe(false);
      await service.complete(ALICE, s.id, { sha256: sha256(data) });
    });

    test('completing with parts missing names them; a wrong whole-file checksum is refused and can be retried', async () => {
      const data = crypto.randomBytes(CHUNK * 3);
      const s = await newUpload(data);
      await sendAll(s.id, data, ALICE, [0, 2]);
      await rejectsWith(service.complete(ALICE, s.id, { sha256: sha256(data) }), 409, 'PARTS_MISSING');
      try { await service.complete(ALICE, s.id, { sha256: sha256(data) }); } catch (e) { expect((e as UploadError).message).toContain('1'); }
      await sendAll(s.id, data, ALICE, [1]);
      await rejectsWith(service.complete(ALICE, s.id, { sha256: sha256(Buffer.from('wrong')) }), 422, 'CHECKSUM_MISMATCH');
      expect((await service.get(ALICE, s.id)).status).toBe('UPLOADING');
      const ok = await service.complete(ALICE, s.id, { sha256: sha256(data) });
      expect(ok.status).toBe('COMPLETE');
      await rejectsWith(service.complete(ALICE, s.id, { sha256: 'nothex' }), 400, 'INVALID_CHECKSUM');
    });
  });

  describe('authorization', () => {
    test('another user cannot see, write, complete, read or cancel a session', async () => {
      const data = crypto.randomBytes(CHUNK * 2);
      const s = await newUpload(data);
      const parts = splitParts(data, CHUNK);
      await sendAll(s.id, data, ALICE, [0]);
      await rejectsWith(service.get(BOB, s.id), 404, 'UPLOAD_NOT_FOUND');
      await rejectsWith(service.putPart(BOB, s.id, 1, streamOf(parts[1]!), { sha256: sha256(parts[1]!), contentLength: CHUNK }), 404, 'UPLOAD_NOT_FOUND');
      await rejectsWith(service.complete(BOB, s.id, { sha256: sha256(data) }), 404, 'UPLOAD_NOT_FOUND');
      await rejectsWith(service.abort(BOB, s.id), 404, 'UPLOAD_NOT_FOUND');
      await rejectsWith(service.openCompleted(BOB, s.id), 404, 'UPLOAD_NOT_FOUND');
      await rejectsWith(service.release(BOB, s.id), 404, 'UPLOAD_NOT_FOUND');
      // Alice's upload is untouched.
      expect((await service.get(ALICE, s.id)).receivedRanges).toEqual([[0, 0]]);
      // A missing id answers the same as a foreign one, and odd ids never reach the database or the disk.
      await rejectsWith(service.get(ALICE, crypto.randomUUID()), 404, 'UPLOAD_NOT_FOUND');
      await rejectsWith(service.get(ALICE, '../../etc/passwd'), 404, 'UPLOAD_NOT_FOUND');
    });

    test('the file name cannot point anywhere', async () => {
      expect(cleanFilename('../../etc/passwd')).toBe('passwd');
      expect(cleanFilename('C:\\Users\\x\\evil.exe')).toBe('evil.exe');
      expect(cleanFilename('a\u0000b\nc.png')).toBe('abc.png');
      expect(() => cleanFilename('..')).toThrow();
      expect(() => cleanFilename('')).toThrow();
      expect(cleanFilename('x'.repeat(400)).length).toBe(255);
    });
  });

  describe('limits', () => {
    test('rejects sizes that are not valid, and sizes above the maximum', async () => {
      await rejectsWith(service.create(ALICE, { filename: 'a', sizeBytes: 0 }), 400, 'INVALID_SIZE');
      await rejectsWith(service.create(ALICE, { filename: 'a', sizeBytes: -5 }), 400, 'INVALID_SIZE');
      await rejectsWith(service.create(ALICE, { filename: 'a', sizeBytes: 1.5 }), 400, 'INVALID_SIZE');
      await rejectsWith(service.create(ALICE, { filename: 'a', sizeBytes: LIMITS.maxBytes! + 1 }), 413, 'UPLOAD_TOO_LARGE');
      await rejectsWith(service.create(ALICE, { filename: 'a', sizeBytes: 100, chunkSizeBytes: 10 }), 400, 'INVALID_CHUNK_SIZE');
    });

    test('limits how many uploads one person has open, and how much they reserve', async () => {
      for (let i = 0; i < 3; i++) await service.create(ALICE, { filename: `f${i}`, sizeBytes: 1000 });
      await rejectsWith(service.create(ALICE, { filename: 'f4', sizeBytes: 1000 }), 429, 'TOO_MANY_UPLOADS');
      await service.create(BOB, { filename: 'bob', sizeBytes: 1000 }); // someone else is not affected
      const big = make({ maxBytes: 10 * 1024 * 1024, maxReservedBytesPerOwner: 1024 * 1024 });
      await rejectsWith(big.create('user-carol', { filename: 'c', sizeBytes: 2 * 1024 * 1024 }), 429, 'UPLOAD_SPACE_RESERVED');
    });

    test('asks the quota check first and stops if it refuses', async () => {
      const refusing = make({}, async () => { throw new UploadError(402, 'STORAGE_FULL', 'Vault storage is full.'); });
      await rejectsWith(refusing.create(ALICE, { filename: 'a', sizeBytes: 100 }), 402, 'STORAGE_FULL');
      const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*) AS n FROM upload_sessions`;
      expect(Number(rows[0]!.n)).toBe(0);
    });

    test('a huge file gets bigger parts so the part count stays small', async () => {
      const wide = make({ maxBytes: 100 * 1024 * 1024 * 1024, maxParts: 100, minChunkBytes: 1024 * 1024, maxChunkBytes: 1024 * 1024 * 1024, defaultChunkBytes: 8 * 1024 * 1024 });
      const s = await wide.create(ALICE, { filename: 'big.bin', sizeBytes: 50 * 1024 * 1024 * 1024 });
      expect(s.totalParts).toBeLessThanOrEqual(100);
      expect(s.chunkSizeBytes * s.totalParts).toBeGreaterThanOrEqual(50 * 1024 * 1024 * 1024);
    });
  });

  describe('abandoned uploads', () => {
    test('abort removes the bytes and closes the upload', async () => {
      const data = crypto.randomBytes(CHUNK * 2);
      const s = await newUpload(data);
      await sendAll(s.id, data, ALICE, [0]);
      expect(fs.existsSync(storage.pathFor(s.id))).toBe(true);
      await service.abort(ALICE, s.id);
      expect(fs.existsSync(storage.pathFor(s.id))).toBe(false);
      await service.abort(ALICE, s.id); // twice is fine
      const parts = splitParts(data, CHUNK);
      await rejectsWith(service.putPart(ALICE, s.id, 1, streamOf(parts[1]!), { sha256: sha256(parts[1]!), contentLength: CHUNK }), 409, 'UPLOAD_NOT_OPEN');
    });

    test('an expired upload is gone, and cleanup removes its bytes but not an active upload', async () => {
      const old = await newUpload(crypto.randomBytes(CHUNK * 2));
      const data = crypto.randomBytes(CHUNK);
      const fresh = await newUpload(data);
      await sendAll(old.id, crypto.randomBytes(CHUNK * 2), ALICE, [0]).catch(() => undefined);
      clock = new Date(clock.getTime() + 23 * 3600 * 1000);
      await sendAll(fresh.id, data); // activity keeps it alive
      clock = new Date(clock.getTime() + 2 * 3600 * 1000); // 25 hours after `old` was created
      await rejectsWith(service.get(ALICE, old.id), 404, 'UPLOAD_NOT_FOUND');
      const result = await service.cleanupExpired();
      expect(result.expired).toBe(1);
      expect(fs.existsSync(storage.pathFor(old.id))).toBe(false);
      expect(fs.existsSync(storage.pathFor(fresh.id))).toBe(true);
      expect((await service.get(ALICE, fresh.id)).status).toBe('UPLOADING');
      const again = await service.cleanupExpired();
      expect(again.expired).toBe(0); // running it twice is harmless
    });

    test('cleanup removes storage that has no session, but only after a grace period', async () => {
      const orphan = crypto.randomUUID();
      await storage.allocate(orphan);
      expect((await service.cleanupExpired({ orphanGraceMs: 60 * 60 * 1000 })).orphans).toBe(0);
      clock = new Date(clock.getTime() + 3 * 3600 * 1000);
      expect((await service.cleanupExpired({ orphanGraceMs: 60 * 60 * 1000 })).orphans).toBe(1);
      expect(fs.existsSync(storage.pathFor(orphan))).toBe(false);
    });

    test('a finished upload is handed on and then released', async () => {
      const data = crypto.randomBytes(CHUNK);
      const s = await newUpload(data);
      await sendAll(s.id, data);
      await rejectsWith(service.openCompleted(ALICE, s.id), 409, 'UPLOAD_NOT_COMPLETE');
      await service.complete(ALICE, s.id, { sha256: sha256(data) });
      const file = await service.openCompleted(ALICE, s.id);
      expect(fs.existsSync(file.filePath)).toBe(true);
      await service.release(ALICE, s.id);
      expect(fs.existsSync(file.filePath)).toBe(false);
      expect((await service.get(ALICE, s.id)).status).toBe('CONSUMED');
    });
  });
});
