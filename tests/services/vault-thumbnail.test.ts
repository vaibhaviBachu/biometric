/**
 * My Assets previews (src/services/vault/vault-thumbnail.service.ts): every photo and video, of any size,
 * gets one small JPEG. The database and storage are replaced with in-memory fakes; no network is used.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import sharp from 'sharp';

const records = new Map<string, Record<string, unknown>>();
const objects = new Map<string, Buffer>();
let cloud = false;

jest.mock('../../src/lib/prisma', () => ({
  prisma: { vaultRecord: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => records.get(where.id) ?? null) } },
}));
jest.mock('../../src/lib/vault-storage-backend', () => ({
  isCloudStorageConfigured: () => cloud,
  downloadVaultObject: jest.fn(async (p: string) => {
    const b = objects.get(p);
    if (!b) throw new Error('not found');
    return b;
  }),
  uploadVaultObject: jest.fn(async (p: string, b: Buffer) => { objects.set(p, b); }),
}));

import { getVaultThumbnail, forgetVaultThumbnail } from '../../src/services/vault/vault-thumbnail.service';
import { thumbnailStoragePath } from '../../src/services/vault/vault-thumbnail-path';
import { isFfmpegAvailable } from '../../src/services/forensics/media-tools.service';
import { dnaPhase2 } from '../../src/config/dna-phase2';
import type { VaultService } from '../../src/services/vault/vault.service';

const OWNER = 'owner-1';
const files = new Map<string, Buffer>();
const retrieve = jest.fn(async (id: string) => ({ originalBuffer: files.get(id)! }));
const openSegmentedStream = jest.fn(async (id: string) => ({ stream: Readable.from([files.get(id)!]) }));
const vault = { retrieve, openSegmentedStream } as unknown as VaultService;

function addFile(id: string, name: string, mime: string, bytes: Buffer, segmented = false) {
  records.set(id, {
    originalFileName: name, originalMimeType: mime,
    encryptedFilePath: segmented ? `segments:cloud:${OWNER}/${id}` : `${OWNER}/${id}.enc`,
    dnaRecord: { ownerUserId: OWNER },
  });
  files.set(id, bytes);
}

async function noisyJpeg(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

beforeEach(() => {
  records.clear(); objects.clear(); files.clear(); cloud = false;
  retrieve.mockClear(); openSegmentedStream.mockClear();
});

describe('getVaultThumbnail', () => {
  it('makes a small JPEG from a large photo', async () => {
    addFile('big', 'beach-step0.jpg', 'image/jpeg', await noisyJpeg(6000, 4000));
    const thumb = await getVaultThumbnail(vault, 'big', OWNER);
    const meta = await sharp(thumb!).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBe(480);
    expect(thumb!.length).toBeLessThan(200_000);
  });

  it('reads a file stored in segments as a stream, never as one buffer', async () => {
    addFile('seg', 'huge.jpg', 'image/jpeg', await noisyJpeg(3000, 2000), true);
    const thumb = await getVaultThumbnail(vault, 'seg', OWNER);
    expect(thumb).not.toBeNull();
    expect(openSegmentedStream).toHaveBeenCalledTimes(1);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('turns a HEIC photo into a preview', async () => {
    addFile('heic', 'IMG_0001.HEIC', 'image/heic', fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'heic', 'plain.heic')));
    const thumb = await getVaultThumbnail(vault, 'heic', OWNER);
    expect((await sharp(thumb!).metadata()).format).toBe('jpeg');
  });

  it('makes a still frame for a video', async () => {
    if (!(await isFfmpegAvailable())) return; // the bundled ffmpeg is part of the install; skip only where it is missing
    const mp4 = path.join(os.tmpdir(), `thumb-test-${process.pid}.mp4`);
    execFileSync(dnaPhase2.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=2',
      '-pix_fmt', 'yuv420p', mp4]);
    addFile('vid', 'WhatsApp Video 2026-10-21.mp4', 'video/mp4', fs.readFileSync(mp4));
    fs.rmSync(mp4, { force: true });
    const thumb = await getVaultThumbnail(vault, 'vid', OWNER);
    const meta = await sharp(thumb!).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(480);
  });

  it('returns null for files that keep their own preview (PDF, text)', async () => {
    addFile('pdf', 'report.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    expect(await getVaultThumbnail(vault, 'pdf', OWNER)).toBeNull();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('refuses another user', async () => {
    addFile('mine', 'a.jpg', 'image/jpeg', await noisyJpeg(64, 64));
    await expect(getVaultThumbnail(vault, 'mine', 'someone-else')).rejects.toThrow();
  });

  it('makes each preview once: parallel requests share it, later ones come from memory', async () => {
    addFile('once', 'a.jpg', 'image/jpeg', await noisyJpeg(800, 600));
    const [a, b] = await Promise.all([getVaultThumbnail(vault, 'once', OWNER), getVaultThumbnail(vault, 'once', OWNER)]);
    await getVaultThumbnail(vault, 'once', OWNER);
    expect(a!.equals(b!)).toBe(true);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('answers a missing original at once on later requests instead of searching storage again', async () => {
    addFile('gone', 'beach-step0.jpg', 'image/jpeg', Buffer.alloc(0));
    retrieve.mockImplementationOnce(async () => { throw new Error('This protected file is not in cloud storage. Protect the file again.'); });
    await expect(getVaultThumbnail(vault, 'gone', OWNER)).rejects.toThrow('not in cloud storage');
    await expect(getVaultThumbnail(vault, 'gone', OWNER)).rejects.toThrow('not in cloud storage');
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('stores the preview encrypted in cloud storage and reuses it after a restart', async () => {
    cloud = true;
    addFile('saved', 'a.jpg', 'image/jpeg', await noisyJpeg(800, 600));
    const first = await getVaultThumbnail(vault, 'saved', OWNER);
    await new Promise((r) => setImmediate(r));
    const stored = objects.get(thumbnailStoragePath(OWNER, 'saved'))!;
    expect(stored).toBeDefined();
    expect(stored.includes(first!.subarray(0, 64))).toBe(false); // encrypted, not the plain JPEG

    forgetVaultThumbnail('saved'); // as after a server restart
    retrieve.mockClear();
    const again = await getVaultThumbnail(vault, 'saved', OWNER);
    expect(again!.equals(first!)).toBe(true);
    expect(retrieve).not.toHaveBeenCalled();
  });
});
