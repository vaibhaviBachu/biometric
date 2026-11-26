/**
 * Stand-alone server for load-testing the upload sessions in isolation. It is a separate process on purpose, so the
 * memory it reports is the server's own. Uses only the local test database and a local folder; refuses anything else.
 *
 *   UPLOAD_TEST_DATABASE_URL=postgresql://...@127.0.0.1:55432/... UPLOAD_TEST_DIR=D:/tmp/uploads PORT=4100 \
 *     node node_modules/ts-node-dev/lib/bin.js --transpile-only scripts/uploads/test-server.ts
 */
import express from 'express';
import fs from 'fs';
import http from 'http';
import { PrismaClient } from '@prisma/client';
import { LocalUploadStorage } from '../../src/services/uploads/local-upload-storage';
import { UploadSessionService } from '../../src/services/uploads/upload-session.service';
import { createUploadSessionRouter } from '../../src/services/uploads/upload-session.router';

const url = process.env['UPLOAD_TEST_DATABASE_URL'] ?? '';
const dir = process.env['UPLOAD_TEST_DIR'] ?? '';
const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
if (!url || !['localhost', '127.0.0.1'].includes(host)) throw new Error('UPLOAD_TEST_DATABASE_URL must point at a local database.');
if (!dir) throw new Error('UPLOAD_TEST_DIR is required.');
fs.mkdirSync(dir, { recursive: true });

const GiB = 1024 * 1024 * 1024;
const db = new PrismaClient({ datasources: { db: { url } } });
const service = new UploadSessionService({
  db,
  storage: new LocalUploadStorage(dir),
  limits: {
    maxBytes: Number(process.env['UPLOAD_TEST_MAX_BYTES'] ?? 64 * GiB),
    maxActivePerOwner: 100,
    maxReservedBytesPerOwner: 1024 * GiB,
    maxParts: 20_000,
  },
});

const app = express();
app.get('/__stats', (_req, res) => {
  const m = process.memoryUsage();
  res.json({ rss: m.rss, heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers, external: m.external });
});
app.get('/__cleanup', async (_req, res) => {
  res.json(await service.cleanupExpired({ orphanGraceMs: 0 }));
});
app.use('/uploads', createUploadSessionRouter({
  service,
  authenticate: (req, res, next) => {
    if (!req.header('x-test-user')) { res.status(401).json({ success: false, error: 'Sign in.' }); return; }
    next();
  },
  getUserId: (req) => req.header('x-test-user') ?? '',
}));

const server = http.createServer(app);
server.requestTimeout = 0; // a large part can take a while on a slow link
server.listen(Number(process.env['PORT'] ?? 4100), '127.0.0.1', () => console.log('upload test server ready'));
