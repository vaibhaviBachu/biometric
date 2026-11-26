/**
 * The public scan against synthetic pictures, with the REAL feature matcher (the local Python AI service) and a fake
 * in-memory database. No production data, no real photos, no network beyond localhost.
 *
 * Runs only when the AI service is reachable and current; otherwise the whole file is skipped (it says so).
 * The numbers these cases rest on were measured with scratch scripts and are recorded in docs/PUBLIC-SCAN-EDITED-COPIES.md.
 */
import { spawnSync } from 'child_process';

type Asset = {
  id: string;
  d: unknown;
  pHash64: string;
  aHash64: string;
  dHash64: string;
  record: { createdAt: Date; imageFilename: string; ownerUser: { shortId: string } };
};
const mockAssets: Asset[] = [];

const hamming = (a: string, b: string): number => {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
};
const pick = (args?: { where?: Record<string, { in?: string[] }> }, key = 'dnaRecordId'): Asset[] => {
  const ids = args?.where?.[key]?.in;
  return ids ? mockAssets.filter((a) => ids.includes(a.id)) : mockAssets;
};

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    $queryRaw: async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('publicScanOptOut')) return [{ optOut: false, showTitle: false, showRecipient: false }];
      if (sql.includes('bit_count')) {
        return mockAssets
          .map((a) => ({ id: a.id, d: hamming(a.pHash64, String(v[0])) }))
          .filter((x) => x.d <= Number(v[1]))
          .sort((x, y) => x.d - y.d)
          .slice(0, Number(v[3]))
          .map((x) => ({ dnaRecordId: x.id }));
      }
      return [];
    },
    perceptualLayer: {
      findMany: async (args: never) => pick(args).map((a) => ({ dnaRecordId: a.id, pHash64: a.pHash64, aHash64: a.aHash64, dHash64: a.dHash64, dnaRecord: a.record })),
    },
    dnaRecord: {
      findMany: async (args: { where?: { id?: { in?: string[] } } }) =>
        args?.where?.id?.in ? mockAssets.filter((a) => args.where!.id!.in!.includes(a.id)).map((a) => ({ id: a.id, ...a.record })) : [],
      findFirst: async (args: { where: { id: string } }) => {
        const a = mockAssets.find((x) => x.id === args.where.id);
        return a ? { id: a.id, ...a.record } : null;
      },
      findUnique: async (args: { where: { id: string } }) => {
        const a = mockAssets.find((x) => x.id === args.where.id);
        return a ? { id: a.id, ...a.record } : null;
      },
    },
    cryptoLayer: { findMany: async () => [] },
    localFeatureIndex: {
      findMany: async (args: never) => pick(args).map((a) => ({ dnaRecordId: a.id, updatedAt: new Date(1), orbDescriptors: a.d, status: 'COMPLETE', orbKeypoints: 1500 })),
      findUnique: async (args: { where: { dnaRecordId: string } }) => {
        const a = mockAssets.find((x) => x.id === args.where.dnaRecordId);
        return a ? { orbDescriptors: a.d, status: 'COMPLETE' } : null;
      },
    },
  },
}));
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// The hidden-mark read and the exact-file checks have their own tests; this file isolates the picture and feature steps.
jest.mock('../../src/services/dna-vnext/robust-watermark', () => ({ extractWatermarkMatch: async () => null }));
jest.mock('../../src/services/dna-vnext/watermark-index', () => ({ findWatermarkCopy: async () => null }));
jest.mock('../../src/services/scan/public-scan-direct', () => ({ findDirectHit: async () => null, directVerdict: () => 'protected' }));

import sharp from 'sharp';
import { aiService } from '../../src/services/ai/ai-embeddings.service';
import { PerceptualLayer } from '../../src/services/layers/layer3.perceptual';
import { scanPublicImage } from '../../src/services/scan/public-scan.service';
import { EDITS, WEAKER_EDITS, syntheticPicture, templatePair } from './helpers/synthetic-images';

/** Synchronous, so the whole file can be skipped (not silently passed) when there is no AI service to test against. */
function aiServiceIsCurrent(): boolean {
  const probe = spawnSync(process.execPath, ['-e',
    "fetch('http://127.0.0.1:8001/openapi.json').then(r=>r.text()).then(t=>process.exit(t.includes('\"geometry\"')?0:1)).catch(()=>process.exit(2))",
  ], { timeout: 8000 });
  return probe.status === 0;
}
const LIVE = aiServiceIsCurrent();
const suite = LIVE ? describe : describe.skip;
if (!LIVE) console.warn('[public-scan-synthetic] SKIPPED: the local AI service is not reachable at 127.0.0.1:8001 (or is older than the geometry check).');

const SLOW = 180_000;
const layer = new PerceptualLayer();
const ids = { a: 'asset-A', b: 'asset-B', bDup: 'asset-B-duplicate', c: 'asset-C', tpl50: 'asset-template-50', tpl75: 'asset-template-75', tpl90: 'asset-template-90' };

async function register(id: string, picture: Buffer, day: number, shortId: string): Promise<void> {
  const r = await aiService.extractLocalDnaIndex(picture, 'image/jpeg');
  if (!r?.orbDescriptors) throw new Error(`the AI service gave no feature points for ${id}`);
  const fp = await layer.computeFingerprints(picture);
  mockAssets.push({
    id,
    d: r.orbDescriptors,
    pHash64: fp.pHash64,
    aHash64: fp.aHash64,
    dHash64: fp.dHash64,
    record: { createdAt: new Date(Date.UTC(2026, 9, day)), imageFilename: `${id}.jpg`, ownerUser: { shortId } },
  });
}

let A: Buffer;
let B: Buffer;
const templateScans: Record<string, Buffer> = {};

suite('public scan, synthetic pictures, real feature matcher', () => {
  beforeAll(async () => {
    A = await syntheticPicture(101);
    B = await syntheticPicture(102);
    const C = await syntheticPicture(103);
    await register(ids.a, A, 1, 'OWNERAAA');
    await register(ids.b, B, 2, 'OWNERBBB');
    // The same picture registered again later by someone else (a recompressed copy).
    await register(ids.bDup, await sharp(B).jpeg({ quality: 70 }).toBuffer(), 9, 'OWNERDUP');
    await register(ids.c, C, 3, 'OWNERCCC');
    // Template look-alikes: the registered picture and a scan that shares its background but redraws part of it.
    for (const [key, covered, seed, day, owner] of [['tpl50', 0.5, 910, 4, 'OWNERT50'], ['tpl75', 0.75, 920, 5, 'OWNERT75'], ['tpl90', 0.9, 930, 6, 'OWNERT90']] as const) {
      const [registered, scan] = await templatePair(seed, covered);
      await register(ids[key], registered, day, owner);
      templateScans[key] = scan;
    }
  }, SLOW);

  test('the AI service is current: a self-match reports aligned points and coverage', async () => {
    const r = await aiService.extractLocalDnaIndex(A, 'image/jpeg');
    const m = await aiService.matchDescriptorSets(r!.orbDescriptors, r!.orbDescriptors, { geometry: true });
    expect(m?.inliers).toBeGreaterThan(1000);
    expect(m?.probeCoverage).toBeGreaterThan(0.9);
    expect(m?.referenceCoverage).toBeGreaterThan(0.9);
  }, SLOW);

  test('an untouched copy is "Protected" and names the owner of that asset', async () => {
    const d = await scanPublicImage(A, 'image/jpeg');
    expect(d.verdict).toBe('protected');
    expect(d.dnaRecordId).toBe(ids.a);
    expect(d.ownerPinitId).toMatch(/OWNERAAA/);
  }, SLOW);

  for (const name of Object.keys(EDITS)) {
    test(`edited copy (${name}) is "Protected" on the right asset`, async () => {
      const d = await scanPublicImage(await EDITS[name]!(A), 'image/jpeg');
      expect(d.verdict).toBe('protected');
      expect(d.dnaRecordId).toBe(ids.a);
      expect(d.ownerPinitId).toMatch(/OWNERAAA/);
    }, SLOW);
  }

  for (const name of Object.keys(WEAKER_EDITS)) {
    test(`weaker edit (${name}) is never attributed to the wrong asset`, async () => {
      const d = await scanPublicImage(await WEAKER_EDITS[name]!(A), 'image/jpeg');
      // Measured: these may now find nothing (too few aligned points to separate from unrelated pictures) — what they
      // must never do is name a different asset or name an owner on weak evidence.
      expect(['not_found', 'possible', 'protected']).toContain(d.verdict);
      if (d.dnaRecordId) expect(d.dnaRecordId).toBe(ids.a);
      if (d.verdict === 'possible') expect(d.ownerPinitId).toBeUndefined();
    }, SLOW);
  }

  test('two registrations of the same picture: the earliest owner is named and the card says another exists', async () => {
    const d = await scanPublicImage(await EDITS['rotate 3°']!(B), 'image/jpeg');
    expect(d.verdict).toBe('protected');
    expect(d.dnaRecordId).toBe(ids.b);
    expect(d.ownerPinitId).toMatch(/OWNERBBB/);
    expect(d.anotherRegistration).toBe(true);
  }, SLOW);

  for (const seed of [202, 303, 404, 505, 606]) {
    test(`an unrelated picture (seed ${seed}) is not found`, async () => {
      const d = await scanPublicImage(await syntheticPicture(seed), 'image/jpeg');
      expect(d.verdict).toBe('not_found');
      expect(d.ownerPinitId).toBeUndefined();
    }, SLOW);
  }

  for (const [key, label] of [['tpl50', 'half the picture redrawn'], ['tpl75', '75% redrawn'], ['tpl90', '90% redrawn']] as const) {
    test(`a template look-alike (${label}) is not reported "Protected"`, async () => {
      const d = await scanPublicImage(templateScans[key]!, 'image/jpeg');
      expect(d.verdict).not.toBe('protected');
      expect(d.ownerPinitId).toBeUndefined();
    }, SLOW);
  }
});
