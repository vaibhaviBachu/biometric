/**
 * Step D, writers: every place that puts identity into a delivered file now goes through the clean carriers.
 * These tests run the real writers on real files and check three things:
 *   1. the file keeps its content (author properties, entries, streams) and is identified by the same readers;
 *   2. text and data files are left byte-identical;
 *   3. files delivered before this change (old placements) are still read.
 */
import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));
jest.mock('../../src/config', () => ({ config: { vault: { masterSecret: 'test-secret' } } }));
jest.mock('../../src/config/vault-identity', () => ({
  isVaultIdentityPipelineEnabled: () => true,
  isVaultInvisibleWatermarkEnabled: () => true,
}));

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { identityEmbeddingService } from '../../src/services/identity/identity-embedding.service';
import { vaultWatermarkEngine } from '../../src/services/watermark/vault-watermark-engine.service';
import { embedManifestTail, extractManifest, buildIntegrityManifest, signManifest, manifestCanBeEmbedded } from '../../src/services/identity/integrity-manifest.service';
import { embedWatermark, extractWatermarkFromFile } from '../../src/services/watermark/watermark.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const FFMPEG = require('ffmpeg-static') as string;
const SLOW = 120_000;

const IDENTITY = {
  dnaId: '11111111-1111-4111-8111-111111111111',
  vaultId: '22222222-2222-4222-8222-222222222222',
  ownerUserId: '33333333-3333-4333-8333-333333333333',
};
const CONTEXT = {
  vaultId: IDENTITY.vaultId,
  dnaRecordId: IDENTITY.dnaId,
  certificateId: null,
  ownerUserId: IDENTITY.ownerUserId,
  identityToken: null,
  recoveryToken: 'RCV-test-recovery-token',
};

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writers-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function streamHashes(buffer: Buffer, ext: string): string {
  const file = path.join(dir, `s-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(file, buffer);
  return execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-i', file, '-map', '0', '-c', 'copy', '-f', 'streamhash', '-hash', 'md5', '-'], { encoding: 'utf8' }).trim();
}

function ffmpegMake(name: string, args: string[]): Buffer {
  const file = path.join(dir, name);
  execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args, file]);
  return fs.readFileSync(file);
}

async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle('Quarterly report');
  doc.setAuthor('Dana Reyes');
  doc.setSubject('Finance');
  doc.setKeywords(['q3', 'internal']);
  doc.setCreator('Word');
  doc.addPage([300, 300]).drawText('Hello');
  return Buffer.from(await doc.save());
}

async function officeFile(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  zip.file('word/document.xml', '<w:document>Hello</w:document>');
  zip.file('docProps/custom.xml', '<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ProjectCode"><vt:lpwstr>P-1042</vt:lpwstr></property></Properties>');
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('identity signature (identity-embedding.service)', () => {
  test('PDF: the author\'s properties and the original bytes are untouched, and the signature is found and valid', async () => {
    const original = await samplePdf();
    const out = await identityEmbeddingService.embed(original, 'application/pdf', 'report.pdf', IDENTITY);
    expect(out.success).toBe(true);
    expect(out.buffer.subarray(0, original.length).equals(original)).toBe(true);
    const reopened = await PDFDocument.load(out.buffer);
    expect(reopened.getTitle()).toBe('Quarterly report');
    expect(reopened.getAuthor()).toBe('Dana Reyes');
    expect(reopened.getSubject()).toBe('Finance');
    expect(reopened.getKeywords()).toBe('q3 internal');
    expect(reopened.getCreator()).toBe('Word');
    const found = await identityEmbeddingService.extractAndVerify(out.buffer, 'application/pdf', 'report.pdf');
    expect(found).toMatchObject({ found: true, valid: true, dnaId: IDENTITY.dnaId, vaultId: IDENTITY.vaultId });
  }, SLOW);

  test('PDF delivered before this change (signature in the Keywords property) is still read', async () => {
    const signature = identityEmbeddingService.buildSignature(IDENTITY);
    const doc = await PDFDocument.create();
    doc.setKeywords([signature]);
    doc.addPage([200, 200]);
    const old = Buffer.from(await doc.save());
    const found = await identityEmbeddingService.extractAndVerify(old, 'application/pdf', 'old.pdf');
    expect(found).toMatchObject({ found: true, valid: true, dnaId: IDENTITY.dnaId });
  }, SLOW);

  test.each([
    ['sales.csv', 'text/csv', 'id,name\n1,Ann\n2,Bo\n'],
    ['config.json', 'application/json', '{"a":1}'],
    ['notes.txt', 'text/plain', 'plain notes\n'],
  ])('%s: a text or data file comes back byte-identical and the result says nothing was embedded', async (name, mime, body) => {
    const original = Buffer.from(body, 'utf8');
    const out = await identityEmbeddingService.embed(original, mime, name, IDENTITY);
    expect(out.buffer.equals(original)).toBe(true);
    expect(out.success).toBe(false);
  });

  test('a text file delivered before this change (hidden characters at the end) is still read', async () => {
    const signature = identityEmbeddingService.buildSignature(IDENTITY);
    let encoded = '‍';
    for (const ch of signature) {
      const code = ch.charCodeAt(0);
      for (let i = 7; i >= 0; i--) encoded += ((code >> i) & 1) ? '‌' : '​';
    }
    encoded += '‍';
    const old = Buffer.from(`id,name\n1,Ann\n${encoded}`, 'utf8');
    const found = await identityEmbeddingService.extractAndVerify(old, 'text/csv', 'old.csv');
    expect(found).toMatchObject({ found: true, valid: true, dnaId: IDENTITY.dnaId });
  });

  test('ZIP: no hidden file is added, every entry is unchanged, the signature is found and valid', async () => {
    const zip = new JSZip();
    zip.file('a.txt', 'alpha');
    zip.file('dir/b.bin', Buffer.from([1, 2, 3]));
    const original = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const out = await identityEmbeddingService.embed(original, 'application/zip', 'bundle.zip', IDENTITY);
    expect(out.success).toBe(true);
    const names = (b: Buffer) => JSZip.loadAsync(b).then((z) => Object.keys(z.files).filter((n) => !z.files[n]!.dir).sort());
    expect(await names(out.buffer)).toEqual(await names(original));
    const found = await identityEmbeddingService.extractAndVerify(out.buffer, 'application/zip', 'bundle.zip');
    expect(found).toMatchObject({ found: true, valid: true, vaultId: IDENTITY.vaultId });
  });

  test('Office: the signature is added next to the author\'s own properties and is found and valid', async () => {
    const original = await officeFile();
    const out = await identityEmbeddingService.embed(original, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx', IDENTITY);
    const loaded = await JSZip.loadAsync(out.buffer);
    const custom = await loaded.file('docProps/custom.xml')!.async('string');
    expect(custom).toContain('name="ProjectCode"');
    expect(custom).toContain('P-1042');
    expect(custom).toContain('name="PINIT-DNA-Signature"');
    expect(await loaded.file('word/document.xml')!.async('string')).toBe('<w:document>Hello</w:document>');
    const found = await identityEmbeddingService.extractAndVerify(out.buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx');
    expect(found).toMatchObject({ found: true, valid: true, dnaId: IDENTITY.dnaId });
  });

  test('JPEG: stays a JPEG (not re-encoded as PNG) and the signature is found in the tail', async () => {
    const original = ffmpegMake('t.jpg', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=1', '-frames:v', '1', '-q:v', '5']);
    const out = await identityEmbeddingService.embed(original, 'image/jpeg', 'photo.jpg', IDENTITY);
    expect(out.success).toBe(true);
    expect(out.method).toBe('binary-tail-image');
    expect(out.buffer.subarray(0, original.length).equals(original)).toBe(true);
    expect(out.buffer.length).toBeLessThan(original.length + 4096);
    const found = await identityEmbeddingService.extractAndVerify(out.buffer, 'image/jpeg', 'photo.jpg');
    expect(found).toMatchObject({ found: true, valid: true, dnaId: IDENTITY.dnaId, vaultId: IDENTITY.vaultId });
  }, SLOW);

  test('MP4 and MP3: the audio and video streams stay bit-identical and the signature is found', async () => {
    const mp4 = ffmpegMake('t.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
    const mp3 = ffmpegMake('t.mp3', ['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'libmp3lame']);
    for (const [buffer, mime, name, ext] of [[mp4, 'video/mp4', 'clip.mp4', 'mp4'], [mp3, 'audio/mpeg', 'song.mp3', 'mp3']] as const) {
      const out = await identityEmbeddingService.embed(buffer, mime, name, IDENTITY);
      expect(out.success).toBe(true);
      expect(streamHashes(out.buffer, ext)).toBe(streamHashes(buffer, ext));
      const found = await identityEmbeddingService.extractAndVerify(out.buffer, mime, name);
      expect(found).toMatchObject({ found: true, valid: true, dnaId: IDENTITY.dnaId });
    }
  }, SLOW);
});

describe('vault watermark engine', () => {
  test('PDF: not re-saved, the author\'s properties stay, and the recovery code still finds the token on the first line', async () => {
    const original = await samplePdf();
    const out = await vaultWatermarkEngine.embed(original, 'application/pdf', 'report.pdf', CONTEXT);
    expect(out.embedded).toBe(true);
    expect(out.buffer.subarray(0, original.length).equals(original)).toBe(true);
    const reopened = await PDFDocument.load(out.buffer);
    expect(reopened.getCreator()).toBe('Word');
    expect(reopened.getSubject()).toBe('Finance');
    // What phase3-watermark-recovery does: last 8 KB, "rest of the line after the marker".
    const tail = out.buffer.subarray(Math.max(0, out.buffer.length - 8192)).toString('utf8');
    expect(tail.match(/PINIT-VAULT-TAIL\|([^\n]+)/)?.[1]).toBe(`PINIT-VAULT|${IDENTITY.dnaId.slice(0, 8)}|${IDENTITY.vaultId.slice(0, 8)}`);
  }, SLOW);

  test('Office: properties are added next to the author\'s and no hidden part appears in the package', async () => {
    const original = await officeFile();
    const out = await vaultWatermarkEngine.embed(original, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx', CONTEXT);
    expect(out.embedded).toBe(true);
    const loaded = await JSZip.loadAsync(out.buffer);
    expect(Object.keys(loaded.files).filter((n) => n.startsWith('.pinit'))).toEqual([]);
    expect(Object.keys(loaded.files).filter((n) => !loaded.files[n]!.dir).sort())
      .toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/custom.xml', 'word/document.xml']);
    const custom = await loaded.file('docProps/custom.xml')!.async('string');
    expect(custom).toContain('name="ProjectCode"');
    expect(custom).toContain('name="PINIT_VAULT_WATERMARK"');
  });

  test.each([
    ['sales.csv', 'text/csv', 'id,name\n1,Ann\n'],
    ['notes.txt', 'text/plain', 'plain notes\n'],
    ['config.json', 'application/json', '{"a":1}'],
  ])('%s: a text or data file is left byte-identical (no header line, no hidden characters) and reported as not embedded', async (name, mime, body) => {
    const original = Buffer.from(body, 'utf8');
    const out = await vaultWatermarkEngine.embed(original, mime, name, CONTEXT);
    expect(out.buffer.equals(original)).toBe(true);
    expect(out.embedded).toBe(false);
  });

  test('ZIP: only the archive comment changes', async () => {
    const zip = new JSZip();
    zip.file('a.txt', 'alpha');
    const original = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    const out = await vaultWatermarkEngine.embed(original, 'application/zip', 'bundle.zip', CONTEXT);
    const loaded = await JSZip.loadAsync(out.buffer);
    expect(Object.keys(loaded.files)).toEqual(['a.txt']);
    expect(out.buffer.toString('latin1')).toContain('PINIT-VAULT|');
  });

  test('MP4 keeps the PINIT-VAULT-VIDEO| marker, with video and audio streams bit-identical', async () => {
    const mp4 = ffmpegMake('w.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
    const out = await vaultWatermarkEngine.embed(mp4, 'video/mp4', 'clip.mp4', CONTEXT);
    expect(out.embedded).toBe(true);
    expect(out.buffer.toString('latin1')).toContain('PINIT-VAULT-VIDEO|');
    expect(streamHashes(out.buffer, 'mp4')).toBe(streamHashes(mp4, 'mp4'));
  }, SLOW);
});

describe('integrity manifest', () => {
  const manifest = signManifest(buildIntegrityManifest({
    vaultId: IDENTITY.vaultId, dnaRecordId: IDENTITY.dnaId, ownerUserId: IDENTITY.ownerUserId, certificateId: null,
    preEmbedSha256: 'a'.repeat(64), methods: ['x'], identityTokenHash: '', recoveryTokenHash: '', watermarkHash: '', signatureHash: '',
  }));

  test('PDF and ZIP carry it and extractManifest reads it back', async () => {
    const pdf = embedManifestTail(await samplePdf(), manifest, { mimeType: 'application/pdf', fileName: 'a.pdf' });
    expect(extractManifest(pdf)?.vaultId).toBe(IDENTITY.vaultId);
    const zip = new JSZip();
    zip.file('a.txt', 'alpha');
    const zipped = embedManifestTail(Buffer.from(await zip.generateAsync({ type: 'nodebuffer' })), manifest, { mimeType: 'application/zip', fileName: 'a.zip' });
    expect(extractManifest(zipped)?.vaultId).toBe(IDENTITY.vaultId);
    expect(Object.keys((await JSZip.loadAsync(zipped)).files)).toEqual(['a.txt']);
  }, SLOW);

  test('a data file is left byte-identical and the pipeline can tell that nothing was written', () => {
    const csv = Buffer.from('id,name\n1,Ann\n', 'utf8');
    expect(embedManifestTail(csv, manifest, { mimeType: 'text/csv', fileName: 'a.csv' }).equals(csv)).toBe(true);
    expect(manifestCanBeEmbedded(csv, { mimeType: 'text/csv', fileName: 'a.csv' })).toBe(false);
    expect(manifestCanBeEmbedded(Buffer.from('<html></html>'), { mimeType: 'text/html', fileName: 'p.html' })).toBe(true);
    expect(manifestCanBeEmbedded(Buffer.from([1, 2, 3, 4]), { mimeType: 'application/octet-stream', fileName: 'x.bin' })).toBe(true);
  });
});

describe('share watermark (watermark.service)', () => {
  const PAYLOAD = JSON.stringify({ mfid: 'm', shareId: 's', recipientId: 'r', wmCode: 'WM-ABCD-EFGH', ts: 1 });

  test('PDF: the pages and the author\'s properties are untouched; the code is read back from the file', async () => {
    const original = await samplePdf();
    const out = await embedWatermark(original, 'application/pdf', 'WM-ABCD-EFGH', PAYLOAD);
    expect(out.subarray(0, original.length).equals(original)).toBe(true);
    const reopened = await PDFDocument.load(out);
    expect(reopened.getSubject()).toBe('Finance');
    expect(reopened.getCreator()).toBe('Word');
    const read = await extractWatermarkFromFile(out, 'application/pdf');
    expect(read.watermarkCode).toBe('WM-ABCD-EFGH');
    expect((read.payload as { shareId?: string } | null)?.shareId).toBe('s');
  }, SLOW);

  test('PDF delivered before this change (code in the Subject property) is still read', async () => {
    const doc = await PDFDocument.create();
    doc.setSubject('PINIT-WM:WM-OLDX-2222');
    doc.addPage([200, 200]);
    const read = await extractWatermarkFromFile(Buffer.from(await doc.save()), 'application/pdf');
    expect(read.watermarkCode).toBe('WM-OLDX-2222');
  }, SLOW);

  test('DOCX: properties are added next to the author\'s and the code is read back', async () => {
    const original = await officeFile();
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const out = await embedWatermark(original, mime, 'WM-ABCD-EFGH', PAYLOAD);
    const loaded = await JSZip.loadAsync(out);
    expect(await loaded.file('docProps/custom.xml')!.async('string')).toContain('name="ProjectCode"');
    expect((await extractWatermarkFromFile(out, mime)).watermarkCode).toBe('WM-ABCD-EFGH');
  }, SLOW);
});
