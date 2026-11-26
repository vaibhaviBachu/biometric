/**
 * Playing a vault video in the page (src/services/vault/vault-stream.service.ts and the two vault routes).
 * The database is an in-memory fake and the vault returns fixed bytes; no network or storage is used.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';

const records = new Map<string, Record<string, unknown>>();
jest.mock('../../src/lib/prisma', () => ({
  prisma: { vaultRecord: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => records.get(where.id) ?? null) } },
}));

import { issueStreamToken, verifyStreamToken, preparePlainFile, parseRange, forgetPlainFile } from '../../src/services/vault/vault-stream.service';
import { config } from '../../src/config';
import type { VaultService } from '../../src/services/vault/vault.service';

const OWNER = 'owner-1';
const VIDEO = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const retrieve = jest.fn(async () => ({ originalBuffer: VIDEO }));
const vault = { retrieve, openSegmentedStream: jest.fn() } as unknown as VaultService;

function addRecord(id: string, name: string, mime: string) {
  records.set(id, { originalFileName: name, originalMimeType: mime, encryptedFilePath: `${OWNER}/${id}.enc`, dnaRecord: { ownerUserId: OWNER } });
}

beforeEach(async () => {
  records.clear();
  retrieve.mockClear();
  await forgetPlainFile('vid-1');
});

describe('stream tokens', () => {
  it('accept the file and user they were made for, and nothing else', () => {
    const { token } = issueStreamToken('vid-1', OWNER);
    expect(verifyStreamToken(token, 'vid-1')).toBe(OWNER);
    expect(verifyStreamToken(token, 'vid-2')).toBeNull();
    expect(verifyStreamToken(undefined, 'vid-1')).toBeNull();
    expect(verifyStreamToken(`${token}x`, 'vid-1')).toBeNull();
  });

  it('are not sign-in tokens, and sign-in tokens are not stream tokens', () => {
    const signIn = jwt.sign({ vid: 'vid-1', uid: OWNER, purpose: 'vault-stream' }, config.jwt.secret);
    expect(verifyStreamToken(signIn, 'vid-1')).toBeNull();
    const { token } = issueStreamToken('vid-1', OWNER);
    expect(() => jwt.verify(token, config.jwt.secret)).toThrow();
  });
});

describe('parseRange', () => {
  it('reads the forms a video player sends', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
  });
});

describe('preparePlainFile', () => {
  it('decrypts once and reuses the prepared copy', async () => {
    addRecord('vid-1', 'now.mp4', 'video/mp4');
    const a = await preparePlainFile(vault, 'vid-1', OWNER);
    const b = await preparePlainFile(vault, 'vid-1', OWNER);
    expect(a.size).toBe(VIDEO.length);
    expect(b.file).toBe(a.file);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('refuses another user and files that are not video or audio', async () => {
    addRecord('vid-1', 'now.mp4', 'video/mp4');
    await expect(preparePlainFile(vault, 'vid-1', 'someone-else')).rejects.toThrow();
    addRecord('doc-1', 'report.pdf', 'application/pdf');
    await expect(preparePlainFile(vault, 'doc-1', OWNER)).rejects.toThrow('Only video and audio');
  });
});

describe('GET /vault/:id/stream', () => {
  // The controller module builds its own VaultService; replace retrieve on the prototype for this suite.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { VaultService } = require('../../src/services/vault/vault.service');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { streamVaultFile } = require('../../src/api/controllers/vault.controller');
  const app = express();
  app.get('/vault/:id/stream', streamVaultFile);
  app.use((err: { statusCode?: number; status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? err.status ?? 500).json({ error: true });
  });

  let server: Server;
  let base = '';
  beforeAll(async () => {
    jest.spyOn(VaultService.prototype, 'retrieve').mockImplementation(async () => ({ originalBuffer: VIDEO }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('sends the requested piece with 206, so playback can start and jump anywhere', async () => {
    addRecord('vid-1', 'now.mp4', 'video/mp4');
    const { token } = issueStreamToken('vid-1', OWNER);
    const res = await fetch(`${base}/vault/vid-1/stream?token=${token}`, { headers: { Range: 'bytes=1000-1999' } });
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 1000-1999/${VIDEO.length}`);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(body.equals(VIDEO.subarray(1000, 2000))).toBe(true);
  });

  it('sends the whole file without a range, and 416 past the end', async () => {
    addRecord('vid-1', 'now.mp4', 'video/mp4');
    const { token } = issueStreamToken('vid-1', OWNER);
    const whole = await fetch(`${base}/vault/vid-1/stream?token=${token}`);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(VIDEO)).toBe(true);
    const past = await fetch(`${base}/vault/vid-1/stream?token=${token}`, { headers: { Range: `bytes=${VIDEO.length}-` } });
    expect(past.status).toBe(416);
  });

  it('refuses a missing or wrong token', async () => {
    addRecord('vid-1', 'now.mp4', 'video/mp4');
    expect((await fetch(`${base}/vault/vid-1/stream`)).status).toBe(401);
    const { token } = issueStreamToken('other', OWNER);
    expect((await fetch(`${base}/vault/vid-1/stream?token=${token}`)).status).toBe(401);
  });
});
