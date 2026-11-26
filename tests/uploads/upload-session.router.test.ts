import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import type { PrismaClient } from '@prisma/client';
import { LocalUploadStorage } from '../../src/services/uploads/local-upload-storage';
import { UploadSessionService } from '../../src/services/uploads/upload-session.service';
import { createUploadSessionRouter } from '../../src/services/uploads/upload-session.router';
import { createTestDb, describeWithDb, ensureTables, resetTables, sha256, splitParts, tempDir } from './upload-test-env';

const CHUNK = 4096;

describeWithDb('resumable upload sessions (HTTP, local Postgres and disk)', () => {
  let db: PrismaClient;
  let root: string;
  let server: http.Server;
  let base: string;
  let service: UploadSessionService;

  beforeAll(async () => {
    db = createTestDb();
    await ensureTables(db);
    root = tempDir('http');
    service = new UploadSessionService({
      db,
      storage: new LocalUploadStorage(root),
      limits: { maxBytes: 4 * 1024 * 1024, defaultChunkBytes: CHUNK, minChunkBytes: 1024, maxChunkBytes: 64 * 1024, maxParts: 500 },
    });
    const app = express();
    app.use('/uploads', createUploadSessionRouter({
      service,
      authenticate: (req, res, next) => {
        const user = req.header('x-test-user');
        if (!user) {
          res.status(401).json({ success: false, error: 'Sign in.' });
          return;
        }
        (req as express.Request & { testUser?: string }).testUser = user;
        next();
      },
      getUserId: (req) => (req as express.Request & { testUser?: string }).testUser ?? '',
    }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/uploads`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetTables(db);
  });

  const call = async (method: string, url: string, user: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(user ? { 'x-test-user': user } : {}), ...(body !== undefined && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const putPart = (id: string, index: number, part: Buffer, user: string | null = 'alice', hash = sha256(part)) =>
    call('PUT', `/${id}/parts/${index}`, user, part, { 'x-part-sha256': hash, 'content-type': 'application/octet-stream' });

  const start = async (data: Buffer, user = 'alice') => {
    const res = await call('POST', '', user, { filename: 'shot.jpg', mimeType: 'image/jpeg', sizeBytes: data.length });
    expect(res.status).toBe(201);
    return res.json.upload as { id: string; totalParts: number; chunkSizeBytes: number };
  };

  test('full upload over HTTP: create, parts, status, complete', async () => {
    const data = crypto.randomBytes(CHUNK * 3 + 77);
    const s = await start(data);
    const parts = splitParts(data, CHUNK);
    for (const i of [2, 0, 3, 1]) expect((await putPart(s.id, i, parts[i]!)).status).toBe(201);
    const status = await call('GET', `/${s.id}`, 'alice');
    expect(status.json.upload.receivedRanges).toEqual([[0, 3]]);
    const done = await call('POST', `/${s.id}/complete`, 'alice', { sha256: sha256(data) });
    expect(done.status).toBe(200);
    expect(done.json.upload.status).toBe('COMPLETE');
    const file = await service.openCompleted('alice', s.id);
    expect(fs.readFileSync(file.filePath).equals(data)).toBe(true);
  });

  test('a repeated part answers 200 with duplicate true', async () => {
    const data = crypto.randomBytes(CHUNK);
    const s = await start(data);
    expect((await putPart(s.id, 0, data)).status).toBe(201);
    const again = await putPart(s.id, 0, data);
    expect(again.status).toBe(200);
    expect(again.json.part.duplicate).toBe(true);
  });

  test('refuses requests that are not signed in, and hides other people uploads', async () => {
    const data = crypto.randomBytes(CHUNK);
    const s = await start(data);
    expect((await call('POST', '', null, { filename: 'a', sizeBytes: 5 })).status).toBe(401);
    expect((await call('GET', `/${s.id}`, null)).status).toBe(401);
    expect((await putPart(s.id, 0, data, null)).status).toBe(401);
    expect((await call('GET', `/${s.id}`, 'mallory')).status).toBe(404);
    expect((await putPart(s.id, 0, data, 'mallory')).status).toBe(404);
    expect((await call('POST', `/${s.id}/complete`, 'mallory', { sha256: sha256(data) })).status).toBe(404);
    expect((await call('DELETE', `/${s.id}`, 'mallory')).status).toBe(404);
    expect((await call('GET', `/${s.id}`, 'alice')).status).toBe(200); // still there
  });

  test('validates what the client sends', async () => {
    expect((await call('POST', '', 'alice', { filename: '', sizeBytes: 5 })).status).toBe(400);
    expect((await call('POST', '', 'alice', { filename: 'a', sizeBytes: 'big' })).status).toBe(400);
    expect((await call('POST', '', 'alice', { filename: 'a', sizeBytes: 99 * 1024 * 1024 })).status).toBe(413);
    const data = crypto.randomBytes(CHUNK);
    const s = await start(data);
    expect((await putPart(s.id, 9, data)).status).toBe(400); // no such part
    expect((await putPart(s.id, 0, data, 'alice', 'not-a-hash')).status).toBe(400);
    const noHeader = await call('PUT', `/${s.id}/parts/0`, 'alice', data, { 'content-type': 'application/octet-stream' });
    expect(noHeader.status).toBe(400);
    expect((await putPart(s.id, 0, data.subarray(0, 10), 'alice', sha256(data))).status).toBe(400); // wrong length
    expect((await call('POST', `/${s.id}/complete`, 'alice', {})).status).toBe(400);
    const big = await fetch(`${base}`, { method: 'POST', headers: { 'x-test-user': 'alice', 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'x'.repeat(40000), sizeBytes: 5 }) });
    expect(big.status).toBe(413); // the JSON body is capped
  });

  test('a corrupted part is refused with 422 and can be sent again', async () => {
    const data = crypto.randomBytes(CHUNK);
    const s = await start(data);
    const damaged = Buffer.from(data);
    damaged[5] ^= 1;
    const bad = await putPart(s.id, 0, damaged, 'alice', sha256(data));
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('CHECKSUM_MISMATCH');
    expect((await call('GET', `/${s.id}`, 'alice')).json.upload.receivedRanges).toEqual([]);
    expect((await putPart(s.id, 0, data)).status).toBe(201);
  });

  test('a connection that drops mid-part is not recorded, and the part can be resumed', async () => {
    const data = crypto.randomBytes(CHUNK * 2);
    const s = await start(data);
    const part = splitParts(data, CHUNK)[0]!;
    await new Promise<void>((resolve) => {
      const url = new URL(`${base}/${s.id}/parts/0`);
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname, method: 'PUT',
        headers: { 'x-test-user': 'alice', 'x-part-sha256': sha256(part), 'content-length': String(CHUNK), 'content-type': 'application/octet-stream' },
      });
      req.on('error', () => resolve());
      req.write(part.subarray(0, 1500), () => setTimeout(() => { req.destroy(); resolve(); }, 50));
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await call('GET', `/${s.id}`, 'alice')).json.upload.receivedRanges).toEqual([]);
    expect((await putPart(s.id, 0, part)).status).toBe(201);
  });

  test('a part sent without a length is refused with 411', async () => {
    const data = crypto.randomBytes(CHUNK);
    const s = await start(data);
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}/${s.id}/parts/0`);
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname, method: 'PUT',
        headers: { 'x-test-user': 'alice', 'x-part-sha256': sha256(data), 'transfer-encoding': 'chunked' },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    expect(status).toBe(411);
  });

  test('cancel removes the upload', async () => {
    const data = crypto.randomBytes(CHUNK);
    const s = await start(data);
    await putPart(s.id, 0, data);
    expect((await call('DELETE', `/${s.id}`, 'alice')).status).toBe(204);
    expect(fs.existsSync(new LocalUploadStorage(root).pathFor(s.id))).toBe(false);
    expect((await putPart(s.id, 0, data)).status).toBe(409);
  });
});
