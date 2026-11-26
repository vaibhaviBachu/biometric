/**
 * Step D: identity goes into delivered files only where the container allows it,
 * so the file keeps playing, opening and reading exactly as before. Real files are
 * generated and the media streams are compared by hash before and after.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { attachTail, carrierKindFor, mergeOfficeCustomProperties } from '../../src/services/identity/clean-carriers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const FFMPEG = require('ffmpeg-static') as string;
const SLOW = 120_000;
const MARKER = Buffer.from('\x00PINIT-DNA-SIG:PINIT-DNA:v1:aaaa:bbbb:cccc:END-PINIT-DNA\x00', 'latin1');
const MANIFEST = Buffer.from('\x00PINIT-MANIFEST:{"v":1}.sig:END-MANIFEST\x00', 'latin1');

let dir: string;

function run(args: string[]): string {
  return execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function make(name: string, args: string[]): Buffer {
  const file = path.join(dir, name);
  run(['-y', ...args, file]);
  return fs.readFileSync(file);
}

/** Per-stream MD5 of the decoded-free packets: equal means the audio and video data are identical. */
function streamHashes(buffer: Buffer, ext: string): string {
  const file = path.join(dir, `check-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(file, buffer);
  return run(['-i', file, '-map', '0', '-c', 'copy', '-f', 'streamhash', '-hash', 'md5', '-']).trim();
}

/** The file decodes end to end with no errors. */
function decodesCleanly(buffer: Buffer, ext: string): boolean {
  const file = path.join(dir, `play-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(file, buffer);
  const result = execFileSync(FFMPEG, ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return result.trim() === '';
}

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carriers-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('video and audio keep their data exactly', () => {
  test('MP4: identity goes into a uuid box; video and audio streams are bit-identical and the file plays', () => {
    const mp4 = make('t.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
    expect(carrierKindFor(mp4, 'video/mp4', 'clip.mp4')).toBe('iso-bmff');
    const first = attachTail(mp4, MARKER, 'video/mp4', 'clip.mp4');
    expect(first.carrier).toBe('iso-bmff-uuid-box');
    const second = attachTail(first.buffer, MANIFEST, 'video/mp4', 'clip.mp4');
    expect(second.carrier).toBe('iso-bmff-uuid-box');
    expect(streamHashes(second.buffer, 'mp4')).toBe(streamHashes(mp4, 'mp4'));
    expect(decodesCleanly(second.buffer, 'mp4')).toBe(true);
    expect(second.buffer.subarray(0, mp4.length).equals(mp4)).toBe(true);
    const text = second.buffer.toString('latin1');
    expect(text.lastIndexOf(MARKER.toString('latin1'))).toBeGreaterThan(-1);
    expect(text.lastIndexOf(MANIFEST.toString('latin1'))).toBeGreaterThan(-1);
  }, SLOW);

  test.each([
    ['mp3', ['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'libmp3lame'], 'audio/mpeg', 'ape-tag'],
    ['flac', ['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'flac'], 'audio/flac', 'flac-block'],
    ['wav', ['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'pcm_s16le'], 'audio/wav', 'appended'],
    ['ogg', ['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'libvorbis'], 'audio/ogg', 'appended'],
  ] as const)('%s: the audio data is bit-identical and the file plays (carrier: %s)', (ext, args, mime, carrier) => {
    const audio = make(`t.${ext}`, [...args]);
    const once = attachTail(audio, MARKER, mime, `sound.${ext}`);
    expect(once.carrier).toBe(carrier);
    const twice = attachTail(once.buffer, MANIFEST, mime, `sound.${ext}`); // a second writer on the same file
    expect(streamHashes(twice.buffer, ext)).toBe(streamHashes(audio, ext));
    expect(decodesCleanly(twice.buffer, ext)).toBe(true);
    const text = twice.buffer.toString('latin1');
    expect(text).toContain(MARKER.toString('latin1'));
    expect(text).toContain(MANIFEST.toString('latin1'));
  }, SLOW);
});

describe('archives and Office files keep every entry', () => {
  async function sampleZip(comment?: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('a.txt', 'alpha');
    zip.file('dir/b.bin', Buffer.from([1, 2, 3, 4, 5]));
    zip.file('c.csv', 'x,y\n1,2\n');
    return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', comment }));
  }

  test('ZIP: the identity goes into the archive comment; no entry is added or changed', async () => {
    const original = await sampleZip();
    const out = attachTail(original, MARKER, 'application/zip', 'bundle.zip');
    expect(out.carrier).toBe('zip-comment');
    const before = await JSZip.loadAsync(original);
    const after = await JSZip.loadAsync(out.buffer);
    expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
    for (const name of Object.keys(before.files)) {
      if (before.files[name]!.dir) continue;
      expect(Buffer.compare(await after.file(name)!.async('nodebuffer'), await before.file(name)!.async('nodebuffer'))).toBe(0);
    }
    expect(out.buffer.toString('latin1')).toContain('PINIT-DNA-SIG');
    // The entry data itself is not rewritten: the original bytes are a prefix up to the end record.
    expect(out.buffer.subarray(0, original.length - 22).equals(original.subarray(0, original.length - 22))).toBe(true);
  });

  test('ZIP: a second writer adds to an existing comment instead of replacing it', async () => {
    const original = await sampleZip('authors note');
    const one = attachTail(original, MARKER, 'application/zip', 'a.zip');
    const two = attachTail(one.buffer, MANIFEST, 'application/zip', 'a.zip');
    const loaded = await JSZip.loadAsync(two.buffer);
    expect(Object.keys(loaded.files).filter((n) => !loaded.files[n]!.dir).length).toBe(3);
    const text = two.buffer.toString('latin1');
    expect(text).toContain('authors note');
    expect(text).toContain('PINIT-DNA-SIG');
    expect(text).toContain('PINIT-MANIFEST');
  });

  test('Office: our properties are added next to the author\'s, nothing is replaced, other parts are identical', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    zip.file('word/document.xml', '<w:document>Hello</w:document>');
    zip.file('docProps/custom.xml', `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ProjectCode"><vt:lpwstr>P-1042</vt:lpwstr></property><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="Reviewed"><vt:lpwstr>yes</vt:lpwstr></property></Properties>`);
    const before = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const loaded = await JSZip.loadAsync(before);
    await mergeOfficeCustomProperties(loaded, [{ name: 'PINIT-DNA-Signature', value: 'PINIT-DNA:v1:a:b:c' }]);
    await mergeOfficeCustomProperties(loaded, [{ name: 'PINIT-DNA-Signature', value: 'PINIT-DNA:v1:a:b:c' }]); // twice: still one
    const out = await JSZip.loadAsync(await loaded.generateAsync({ type: 'nodebuffer' }));
    const custom = await out.file('docProps/custom.xml')!.async('string');
    expect(custom).toContain('name="ProjectCode"');
    expect(custom).toContain('P-1042');
    expect(custom).toContain('name="Reviewed"');
    expect(custom.match(/name="PINIT-DNA-Signature"/g)?.length).toBe(1);
    expect(custom).toContain('PINIT-DNA:v1:a:b:c');
    expect(await out.file('word/document.xml')!.async('string')).toBe('<w:document>Hello</w:document>');
    expect(Object.keys(out.files).filter((n) => !out.files[n]!.dir).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/custom.xml', 'word/document.xml']);
    expect(await out.file('[Content_Types].xml')!.async('string')).toContain('/docProps/custom.xml');
  });
});

describe('PDFs and data files', () => {
  test('PDF: the original bytes are untouched and the marker sits in a comment after the end of the file', async () => {
    const doc = await PDFDocument.create();
    doc.setTitle('Quarterly report');
    doc.setSubject('Finance');
    doc.setKeywords(['q3', 'internal']);
    doc.addPage([300, 300]).drawText('Hello');
    const original = Buffer.from(await doc.save());
    const out = attachTail(original, MARKER, 'application/pdf', 'report.pdf');
    expect(out.carrier).toBe('pdf-comment');
    expect(out.buffer.subarray(0, original.length).equals(original)).toBe(true);
    const reopened = await PDFDocument.load(out.buffer);
    expect(reopened.getPageCount()).toBe(1);
    expect(reopened.getTitle()).toBe('Quarterly report');
    expect(reopened.getSubject()).toBe('Finance');
    expect(reopened.getKeywords()).toBe('q3 internal');
    const added = out.buffer.subarray(original.length).toString('latin1');
    expect(added.startsWith('\n%')).toBe(true);
    expect(added.slice(2, -1)).not.toMatch(/[\r\n]/);
    expect(out.buffer.toString('latin1')).toContain('PINIT-DNA-SIG');
  }, SLOW);

  test('PDF: a marker that spans lines becomes one comment line per line, bytes unchanged, file still opens', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const original = Buffer.from(await doc.save());
    const tail = Buffer.from('PINIT-VAULT-TAIL|token-part\nrecovery-part');
    const out = attachTail(original, tail, 'application/pdf', 'x.pdf');
    const added = out.buffer.subarray(original.length).toString('latin1');
    expect(added).toBe('\n%PINIT-VAULT-TAIL|token-part\n%recovery-part\n');
    // The recovery code reads "the rest of the line after the marker": still the token part only.
    expect(added.match(/PINIT-VAULT-TAIL\|([^\n]+)/)?.[1]).toBe('token-part');
    expect((await PDFDocument.load(out.buffer)).getPageCount()).toBe(1);
  }, SLOW);

  test.each([
    ['sales.csv', 'text/csv', 'id,name\n1,Ann\n2,Bo\n'],
    ['config.json', 'application/json', '{"a":1,"b":[1,2,3]}'],
    ['feed.xml', 'application/xml', '<?xml version="1.0"?><r><i>1</i></r>'],
    ['notes.txt', 'text/plain', 'plain notes\nsecond line\n'],
    ['table.tsv', 'text/tab-separated-values', 'a\tb\n1\t2\n'],
  ])('%s: a data file is left byte-identical', (name, mime, body) => {
    const buffer = Buffer.from(body, 'utf8');
    const out = attachTail(buffer, MARKER, mime, name);
    expect(out.carrier).toBe('none-data-file');
    expect(out.buffer.equals(buffer)).toBe(true);
  });

  test('a binary file that only has a text-looking name is not mistaken for text; HTML keeps its own comment form', () => {
    const binary = Buffer.concat([Buffer.from('data'), Buffer.from([0, 1, 2, 3]), Buffer.from('more')]);
    expect(carrierKindFor(binary, 'application/octet-stream', 'maybe.csv')).toBe('raw');
    expect(carrierKindFor(Buffer.from('<html></html>'), 'text/html', 'p.html')).toBe('raw');
  });
});
