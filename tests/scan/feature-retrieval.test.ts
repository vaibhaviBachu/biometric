/**
 * Retrieval of the likely asset by feature points across all indexed assets.
 *
 *  A. Mechanics with synthetic descriptors: decoding, voting, caching, the time budget.
 *  B. Real feature points: images are turned into production-format ORB descriptor sets by the project's own Python
 *     service (OpenCV), then photographed-on-a-screen transforms are searched among many other assets. This part runs
 *     only where Python with OpenCV is available, and is skipped otherwise.
 */
import { describe, test, expect, jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));
jest.mock('../../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  FeatureRetriever, MIN_VOTES, countAnsweredPoints, decodeDescriptorSet, type RetrievalDb,
} from '../../src/services/scan/feature-retrieval';

function randomSet(count: number, seed: number): { keypoints: Array<{ descriptor: string; response: number }> } {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  return {
    keypoints: Array.from({ length: count }, (_, i) => ({
      descriptor: Buffer.from(Array.from({ length: 32 }, () => Math.floor(rnd() * 256))).toString('base64'),
      response: count - i + rnd(),
    })),
  };
}

/** A copy of a set as a camera would see it: some points lost, the rest with a few flipped bits. */
function noisyCopy(set: ReturnType<typeof randomSet>, keep: number, flipBits: number, seed: number) {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  return {
    keypoints: set.keypoints.filter(() => rnd() < keep).map((k) => {
      const raw = Buffer.from(k.descriptor, 'base64');
      for (let b = 0; b < flipBits; b++) raw[Math.floor(rnd() * 32)]! ^= 1 << Math.floor(rnd() * 8);
      return { descriptor: raw.toString('base64'), response: k.response };
    }),
  };
}

function fakeDb(sets: Map<string, { stamp: number; set: unknown }>) {
  const loadSets = jest.fn(async (ids: string[]) => ids.map((id) => ({ dnaRecordId: id, orbDescriptors: sets.get(id)!.set })));
  const db: RetrievalDb = {
    listIndexed: async () => [...sets.entries()].map(([dnaRecordId, v]) => ({ dnaRecordId, stamp: v.stamp })),
    loadSets: loadSets as unknown as RetrievalDb['loadSets'],
  };
  return { db, loadSets };
}

describe('feature retrieval: mechanics', () => {
  test('decodes the strongest points and skips malformed ones', () => {
    const set = randomSet(50, 1);
    set.keypoints.push({ descriptor: 'AAAA', response: 999 }); // too short: ignored
    set.keypoints.push({ descriptor: '', response: 999 });
    const m = decodeDescriptorSet(set, 20)!;
    expect(m.count).toBe(20);
    expect(decodeDescriptorSet({ keypoints: [] })).toBeNull();
    expect(decodeDescriptorSet(null)).toBeNull();
  });

  test('a set answers itself, and unrelated sets answer almost nothing', () => {
    const a = decodeDescriptorSet(randomSet(400, 2))!;
    const b = decodeDescriptorSet(randomSet(400, 3))!;
    expect(countAnsweredPoints(a, a)).toBeGreaterThan(380);
    expect(countAnsweredPoints(a, b)).toBeLessThan(MIN_VOTES);
  });

  test('finds the right asset among hundreds, in a camera-like copy', async () => {
    const sets = new Map<string, { stamp: number; set: unknown }>();
    for (let i = 0; i < 300; i++) sets.set(`asset-${i}`, { stamp: 1, set: randomSet(500, 100 + i) });
    const probe = noisyCopy(sets.get('asset-217')!.set as ReturnType<typeof randomSet>, 0.5, 6, 999);
    const { db } = fakeDb(sets);
    const started = Date.now();
    const result = await new FeatureRetriever(db).retrieve(probe, { topK: 5 });
    const ms = Date.now() - started;
    expect(result.candidates[0]!.dnaRecordId).toBe('asset-217');
    expect(result.candidates[0]!.votes).toBeGreaterThan(MIN_VOTES * 3);
    expect(result.candidates.length).toBe(1); // nothing else clears the noise floor
    expect(result.assetsChecked).toBe(300);
    expect(result.cutShort).toBe(false);
    // eslint-disable-next-line no-console
    console.log(`retrieval over 300 assets took ${ms} ms`);
  });

  test('an unrelated photo gets no candidates', async () => {
    const sets = new Map<string, { stamp: number; set: unknown }>();
    for (let i = 0; i < 100; i++) sets.set(`a${i}`, { stamp: 1, set: randomSet(500, 7 + i) });
    const { db } = fakeDb(sets);
    expect((await new FeatureRetriever(db).retrieve(randomSet(500, 424242))).candidates).toEqual([]);
  });

  test('stored sets are decoded once and reloaded only when an asset changes', async () => {
    const sets = new Map<string, { stamp: number; set: unknown }>();
    for (let i = 0; i < 25; i++) sets.set(`a${i}`, { stamp: 1, set: randomSet(200, 50 + i) });
    const { db, loadSets } = fakeDb(sets);
    const retriever = new FeatureRetriever(db);
    const probe = randomSet(200, 50);
    await retriever.retrieve(probe);
    const loadedFirst = loadSets.mock.calls.reduce((n, c) => n + (c[0] as string[]).length, 0);
    expect(loadedFirst).toBe(25);
    await retriever.retrieve(probe);
    expect(loadSets.mock.calls.reduce((n, c) => n + (c[0] as string[]).length, 0)).toBe(25); // nothing reloaded
    sets.set('a3', { stamp: 2, set: randomSet(200, 777) }); // one asset re-indexed
    await retriever.retrieve(probe);
    expect(loadSets.mock.calls.reduce((n, c) => n + (c[0] as string[]).length, 0)).toBe(26);
    sets.delete('a5'); // an asset removed is forgotten
    const r = await retriever.retrieve(probe);
    expect(r.assetsAvailable).toBe(24);
  });

  test('stops at the time budget and says so', async () => {
    const sets = new Map<string, { stamp: number; set: unknown }>();
    for (let i = 0; i < 40; i++) sets.set(`a${i}`, { stamp: 1, set: randomSet(200, 300 + i) });
    const { db } = fakeDb(sets);
    let clock = 0;
    const retriever = new FeatureRetriever(db, 3000, () => (clock += 400)); // every look at the clock costs 400 ms
    const r = await retriever.retrieve(randomSet(200, 300), { budgetMs: 2000 });
    expect(r.cutShort).toBe(true);
    expect(r.assetsChecked).toBeLessThan(40);
  });
});

// ─── B. real ORB feature points ──────────────────────────────────────────────────────────────────────────────

const PY_DIR = path.resolve(__dirname, '../../python-ai');
const EXTRACT = path.resolve(__dirname, 'fixtures/orb_extract.py');
const hasOpenCv = spawnSync('python', ['-c', 'import cv2, numpy, PIL'], { encoding: 'utf8' }).status === 0 && fs.existsSync(EXTRACT);
const describeReal = hasOpenCv ? describe : describe.skip;

/** A varied, photo-like test image with real corners and texture. Deterministic per seed. */
async function texturedImage(seed: number): Promise<Buffer> {
  let s = seed * 7919 + 17;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const W = 1600, H = 1200;
  const layers: sharp.OverlayOptions[] = [];
  for (const [cells, alpha] of [[6, 0.5], [18, 0.35], [60, 0.2]] as const) {
    const raw = Buffer.alloc(cells * cells * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(rnd() * 256);
    const layer = await sharp(raw, { raw: { width: cells, height: cells, channels: 3 } }).resize(W, H, { kernel: 'cubic' }).ensureAlpha(alpha).png().toBuffer();
    layers.push({ input: layer, blend: 'over' });
  }
  const shapes = Array.from({ length: 70 }, () => {
    const x = rnd() * W, y = rnd() * H, w = 20 + rnd() * 220, h = 20 + rnd() * 160;
    const c = `rgb(${Math.floor(rnd() * 256)},${Math.floor(rnd() * 256)},${Math.floor(rnd() * 256)})`;
    return rnd() < 0.5 ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}" opacity="0.8"/>` : `<ellipse cx="${x}" cy="${y}" rx="${w / 2}" ry="${h / 2}" fill="${c}" opacity="0.8"/>`;
  }).join('');
  layers.push({ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`), blend: 'over' });
  return sharp({ create: { width: W, height: H, channels: 3, background: '#808080' } }).composite(layers).jpeg({ quality: 92 }).toBuffer();
}

const jpeg = (b: sharp.Sharp, q: number) => b.jpeg({ quality: q }).toBuffer();
const PHONE: Array<[string, (i: Buffer) => Promise<Buffer>]> = [
  ['screenshot-style', async (i) => jpeg(sharp(i).resize({ width: 900 }).blur(0.7), 75)],
  ['crop 60%', async (i) => jpeg(sharp(i).extract({ left: 320, top: 240, width: 960, height: 720 }), 75)],
  ['phone photo, steady (tilt 2, blur 1)', async (i) => jpeg(sharp(await sharp(i).rotate(2, { background: '#101820' }).toBuffer()).resize({ width: 800 }).blur(1.0).modulate({ brightness: 0.92 }), 75)],
  ['phone photo, typical (tilt 6, blur 1.6, darker)', async (i) => jpeg(sharp(await sharp(i).rotate(6, { background: '#101820' }).toBuffer()).resize({ width: 700 }).blur(1.6).modulate({ brightness: 0.85 }).gamma(1.2), 65)],
  ['phone photo of a print, rough (tilt 10, blur 2.4)', async (i) => jpeg(sharp(await sharp(i).rotate(10, { background: '#d8d2c8' }).toBuffer()).resize({ width: 600 }).blur(2.4).modulate({ brightness: 0.8, saturation: 0.8 }), 55)],
];

describeReal('feature retrieval: real feature points (OpenCV ORB)', () => {
  test('ranks the right asset first among many, for photo-of-screen style probes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinit-retrieval-'));
    try {
      const assets = 40;
      const probesFor = 6; // assets that get photographed
      const files: string[] = [];
      for (let i = 0; i < assets; i++) {
        const f = path.join(dir, `asset-${i}.jpg`);
        fs.writeFileSync(f, await texturedImage(i + 1));
        files.push(f);
      }
      const probeFiles: Array<{ asset: number; label: string; file: string }> = [];
      for (let i = 0; i < probesFor; i++) {
        const original = fs.readFileSync(files[i]!);
        for (const [label, fn] of PHONE) {
          const f = path.join(dir, `probe-${i}-${crypto.randomBytes(3).toString('hex')}.jpg`);
          fs.writeFileSync(f, await fn(original));
          probeFiles.push({ asset: i, label, file: f });
        }
      }
      const out = path.join(dir, 'orb.json');
      const run = spawnSync('python', [EXTRACT, PY_DIR, out, ...files, ...probeFiles.map((p) => p.file)], { encoding: 'utf8', maxBuffer: 1 << 28 });
      expect(run.status).toBe(0);
      const orb = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, unknown>;

      const sets = new Map<string, { stamp: number; set: unknown }>();
      files.forEach((f, i) => sets.set(`asset-${i}`, { stamp: 1, set: orb[f] }));
      const { db } = fakeDb(sets);
      const retriever = new FeatureRetriever(db);

      const byLabel: Record<string, { n: number; first: number; inTop3: number; votes: number[] }> = {};
      for (const p of probeFiles) {
        const r = await retriever.retrieve(orb[p.file], { topK: 8 });
        const rank = r.candidates.findIndex((c) => c.dnaRecordId === `asset-${p.asset}`);
        const row = (byLabel[p.label] ??= { n: 0, first: 0, inTop3: 0, votes: [] });
        row.n += 1;
        if (rank === 0) row.first += 1;
        if (rank >= 0 && rank < 3) row.inTop3 += 1;
        row.votes.push(rank >= 0 ? r.candidates[rank]!.votes : 0);
      }
      for (const [label, r] of Object.entries(byLabel)) {
        // eslint-disable-next-line no-console
        console.log(`RETRIEVAL ${label}: right asset first ${r.first}/${r.n}, in top 3 ${r.inTop3}/${r.n}, votes ${r.votes.join(',')} (floor ${MIN_VOTES}) among ${assets} assets`);
      }
      // Re-saves, screenshots and crops must always be found. Camera photos are reported above, not asserted here.
      expect(byLabel['screenshot-style']!.first).toBe(byLabel['screenshot-style']!.n);
      expect(byLabel['crop 60%']!.first).toBe(byLabel['crop 60%']!.n);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
