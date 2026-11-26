/**
 * What the hidden owner mark actually survives, for the edits a public scan meets. MEASURED, not assumed:
 * the table is printed for every run and recorded in docs/PUBLIC-SCAN-EDITED-COPIES.md.
 *
 * Two readers are measured on the same edited copy:
 *  - blind: extractWatermarkMatch (finds the mark with no help)
 *  - registered: align the copy to the protected original (local AI service /cv/register), then test it against the marks
 *    issued for that original (readMarkWithRegistration). Skipped, and said so, when the AI service is not reachable.
 *
 * What is ASSERTED is only the safety property: a picture that was never marked must never read as marked (blind or
 * registered), and a marked picture must never be read as a different mark. Survival is recorded, not required.
 * Synthetic picture; the "photo of a screen" is a simulation (tilt, dimming, blur, frame, recompression), not a camera.
 */
import './helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { spawnSync } from 'child_process';
import { describe, test, expect, beforeAll } from '@jest/globals';
import sharp from 'sharp';
import {
  embedRobustProvenanceWatermark,
  extractWatermarkMatch,
  readMarkWithRegistration,
} from '../../src/services/dna-vnext/robust-watermark';
import { watermarkLookupId } from '../../src/services/dna-vnext/crypto';
import { aiService } from '../../src/services/ai/ai-embeddings.service';

const SLOW = 300_000;
const VAULT_ID = 'vault-scan-matrix';
const DNA_ID = 'dna-scan-matrix';
const expected = watermarkLookupId(VAULT_ID, DNA_ID);
const otherCopies = ['recipient-a', 'recipient-b', 'recipient-c'].map((r) => watermarkLookupId(VAULT_ID, `${DNA_ID}:${r}`));

function aiServiceIsCurrent(): boolean {
  const probe = spawnSync(process.execPath, ['-e',
    "fetch('http://127.0.0.1:8001/openapi.json').then(r=>r.text()).then(t=>process.exit(t.includes('/cv/register')?0:1)).catch(()=>process.exit(2))",
  ], { timeout: 8000 });
  return probe.status === 0;
}
const AI = aiServiceIsCurrent();
if (!AI) console.warn('[scan-edit-matrix] the registered reader is SKIPPED: the local AI service is not reachable at 127.0.0.1:8001.');

/** Photo-like picture, deterministic (same generator as robust-watermark-transcode.test.ts). */
async function makeImage(seed: number, width: number, height: number): Promise<Buffer> {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const raw = Buffer.alloc(width * height * 3);
  const fx = 60 + rnd() * 80, fy = 50 + rnd() * 60;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const v = 128 + 90 * Math.sin(x / fx) * Math.cos(y / fy);
      raw[i] = Math.max(0, Math.min(255, v + 40 * Math.sin(x / 200) + (rnd() - 0.5) * 14));
      raw[i + 1] = Math.max(0, Math.min(255, v * 0.8 + 50 * Math.cos(y / 130) + (rnd() - 0.5) * 14));
      raw[i + 2] = Math.max(0, Math.min(255, 255 - v + 30 * Math.sin((x + y) / 160) + (rnd() - 0.5) * 14));
    }
  }
  const shapes = Array.from({ length: 40 }, () =>
    `<circle cx="${(rnd() * width) | 0}" cy="${(rnd() * height) | 0}" r="${20 + rnd() * 90}" ` +
    `fill="rgb(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0})" fill-opacity="0.55"/>`).join('');
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`);
  return sharp(raw, { raw: { width, height, channels: 3 } }).composite([{ input: svg }]).png().toBuffer();
}

type Edit = [string, (b: Buffer) => Promise<Buffer>];
const crop = (k: number) => async (b: Buffer) => {
  const { width: w = 1, height: h = 1 } = await sharp(b).metadata();
  return sharp(b).extract({ left: Math.round((w * (1 - k)) / 2), top: Math.round((h * (1 - k)) / 2), width: Math.round(w * k), height: Math.round(h * k) }).jpeg({ quality: 90 }).toBuffer();
};
const EDITS: Edit[] = [
  ['untouched (re-saved PNG)', (b) => sharp(b).png().toBuffer()],
  ['recompressed JPEG q75', (b) => sharp(b).jpeg({ quality: 75 }).toBuffer()],
  ['recompressed JPEG q30', (b) => sharp(b).jpeg({ quality: 30 }).toBuffer()],
  ['resized 75%', async (b) => sharp(b).resize(Math.round(((await sharp(b).metadata()).width ?? 1000) * 0.75)).jpeg({ quality: 90 }).toBuffer()],
  ['resized 50%', async (b) => sharp(b).resize(Math.round(((await sharp(b).metadata()).width ?? 1000) * 0.5)).jpeg({ quality: 90 }).toBuffer()],
  ['resized 25%', async (b) => sharp(b).resize(Math.round(((await sharp(b).metadata()).width ?? 1000) * 0.25)).jpeg({ quality: 90 }).toBuffer()],
  ['crop 90% (centre)', crop(0.9)],
  ['crop 75% (centre)', crop(0.75)],
  ['crop 50% (centre)', crop(0.5)],
  ['crop 30% (centre)', crop(0.3)],
  ['rotate 3°', (b) => sharp(b).rotate(3, { background: '#000' }).jpeg({ quality: 90 }).toBuffer()],
  ['rotate 90°', (b) => sharp(b).rotate(90).jpeg({ quality: 90 }).toBuffer()],
  ['mirror', (b) => sharp(b).flop().jpeg({ quality: 90 }).toBuffer()],
  ['overlay band', async (b) => {
    const { width: w = 1, height: h = 1 } = await sharp(b).metadata();
    const band = Buffer.from(`<svg width="${w}" height="${h}"><rect x="0" y="${Math.round(h * 0.42)}" width="${w}" height="${Math.round(h * 0.16)}" fill="black"/></svg>`);
    return sharp(b).composite([{ input: band }]).jpeg({ quality: 90 }).toBuffer();
  }],
  ['border 10%', async (b) => {
    const { width: w = 1, height: h = 1 } = await sharp(b).metadata();
    return sharp(b).extend({ top: Math.round(h * 0.1), bottom: Math.round(h * 0.1), left: Math.round(w * 0.1), right: Math.round(w * 0.1), background: '#fff' }).jpeg({ quality: 90 }).toBuffer();
  }],
  ['photo of a screen (simulated)', async (b) =>
    sharp(await sharp(b).rotate(4, { background: '#222' }).modulate({ brightness: 0.85, saturation: 0.8 }).blur(1.2)
      .extend({ top: 60, bottom: 60, left: 60, right: 60, background: '#111' }).toBuffer()).jpeg({ quality: 70 }).toBuffer()],
];

interface Row { edit: string; blind: string; registered: string }
const rows: Row[] = [];
const falseReads: string[] = [];

describe('the hidden mark against the edits a public scan meets', () => {
  let original: Buffer;
  let marked: Buffer;
  let embeddedOk = false;
  let originalMeta: { width: number; height: number };

  beforeAll(async () => {
    original = await makeImage(9001, 1280, 960);
    const res = await embedRobustProvenanceWatermark({ buffer: original, mimeType: 'image/png', vaultId: VAULT_ID, dnaRecordId: DNA_ID });
    embeddedOk = res.embedded;
    marked = res.buffer;
    const m = await sharp(original).metadata();
    originalMeta = { width: m.width ?? 0, height: m.height ?? 0 };
    console.log(`[scan-edit-matrix] embedded=${res.embedded} method=${res.method} clarity=${JSON.stringify(res.clarity ?? null)}`);
  }, SLOW);

  async function measure(label: string, probe: Buffer, referenceMarked: boolean): Promise<Row> {
    let blind = 'not read';
    const hit = await extractWatermarkMatch(probe);
    if (hit) {
      blind = hit.lookupId === expected ? `READ (strength ${hit.strengthPercent}%)` : `WRONG MARK ${hit.lookupId}`;
      if (hit.lookupId !== expected || !referenceMarked) falseReads.push(`blind: ${label} -> ${hit.lookupId}`);
    }
    let registered = AI ? 'not read' : 'skipped (no AI service)';
    if (AI) {
      const reg = await aiService.registerImages(probe, original);
      if (!reg) registered = 'could not align';
      else {
        const read = await readMarkWithRegistration({
          probe,
          referenceWidth: originalMeta.width,
          referenceHeight: originalMeta.height,
          probeToReference: reg.matrix,
          candidates: [expected, ...otherCopies],
          reference: original,
        });
        if (read) {
          registered = read.lookupId === expected ? `READ (z ${read.z.toFixed(1)}, ${read.tilesRead} tiles)` : `WRONG MARK ${read.lookupId}`;
          if (read.lookupId !== expected || !referenceMarked) falseReads.push(`registered: ${label} -> ${read.lookupId} (z ${read.z.toFixed(1)})`);
        } else registered = `aligned (${reg.inliers} pts), mark not found`;
      }
    }
    return { edit: label, blind, registered };
  }

  test('the mark is embedded in the synthetic picture (otherwise nothing below means anything)', () => {
    expect(embeddedOk).toBe(true);
  });

  test('MARKED picture, every edit: record what is read', async () => {
    for (const [label, edit] of EDITS) rows.push(await measure(label, await edit(marked), true));
  }, SLOW);

  test('UNMARKED control, same edits: nothing is ever read (no false mark)', async () => {
    const control: Row[] = [];
    for (const [label, edit] of EDITS) control.push(await measure(`[control: never marked] ${label}`, await edit(original), false));
    const reads = control.filter((r) => !/not read|could not align|not found|skipped/.test(`${r.blind} ${r.registered}`));
    expect(reads).toEqual([]);
  }, SLOW);

  test('no edit of a marked picture is ever read as a different mark', () => {
    expect(falseReads).toEqual([]);
  });

  test('(report) the measured table', () => {
    const w = Math.max(...rows.map((r) => r.edit.length));
    const lines = rows.map((r) => `  ${r.edit.padEnd(w)}  blind: ${r.blind.padEnd(28)} registered: ${r.registered}`);
    console.log(`\n[scan-edit-matrix] hidden mark on MARKED picture (${originalMeta.width}x${originalMeta.height}, synthetic):\n${lines.join('\n')}\n`);
    expect(rows.length).toBe(EDITS.length);
  });
});
