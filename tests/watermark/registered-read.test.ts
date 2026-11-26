/**
 * Registered ("informed") reading: once the copy's place in the protected original is known, the mark is read at
 * known positions and tested against the copies issued for that original. These tests use crops whose transform
 * is known exactly (no AI service): offset + scale. No database: no ownerUserId is passed when marking.
 */
import './helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  embedRobustProvenanceWatermark,
  readMarkWithRegistration,
  type AffineMatrix,
} from '../../src/services/dna-vnext/robust-watermark';
import { watermarkLookupId, watermarkRecipientLookupId } from '../../src/services/dna-vnext/crypto';

const SLOW = 300_000;
const ORIGINAL = fs.readFileSync(path.join(__dirname, '../../client/public/hub-home-shield.jpg'));
const VAULT_A = 'vault-reg-a';
const VAULT_B = 'vault-reg-b';
const DNA = 'dna-reg';
const PEOPLE = ['alice', 'bob', 'carol', 'dave'];
const candidatesFor = (vault: string) => [watermarkLookupId(vault, DNA), ...PEOPLE.map((p) => watermarkRecipientLookupId(vault, DNA, p))];

/** Probe (crop at left/top, then resized by s) → original, in pixel-centre coordinates. */
function cropTransform(left: number, top: number, s: number): AffineMatrix {
  return [[1 / s, 0, left + 0.5 / s - 0.5], [0, 1 / s, top + 0.5 / s - 0.5]];
}

async function cropOf(buffer: Buffer, left: number, top: number, w: number, h: number, s: number, quality = 80): Promise<Buffer> {
  const c = await sharp(buffer).extract({ left, top, width: w, height: h }).png().toBuffer();
  return sharp(c).resize(Math.round(w * s)).jpeg({ quality }).toBuffer();
}

describe('registered reading names the issued copy from a small piece', () => {
  let W: number;
  let H: number;
  let markedForCarol: Buffer;
  let markedForCarolInVaultB: Buffer;
  beforeAll(async () => {
    const meta = await sharp(ORIGINAL).metadata();
    W = meta.width!;
    H = meta.height!;
    markedForCarol = (await embedRobustProvenanceWatermark({ buffer: ORIGINAL, mimeType: 'image/jpeg', vaultId: VAULT_A, dnaRecordId: DNA, recipientKey: 'carol' })).buffer;
    markedForCarolInVaultB = (await embedRobustProvenanceWatermark({ buffer: ORIGINAL, mimeType: 'image/jpeg', vaultId: VAULT_B, dnaRecordId: DNA, recipientKey: 'carol' })).buffer;
  }, SLOW);

  test.each([
    ['a 300×225 crop', 300, 220, 300, 225, 1],
    ['a 300×225 crop shrunk to 75%', 420, 260, 300, 225, 0.75],
    ['a 400×300 crop enlarged to 130%', 250, 150, 400, 300, 1.3],
  ])('%s → carol', async (_label, left, top, w, h, s) => {
    const probe = await cropOf(markedForCarol, left, top, w, h, s);
    const read = await readMarkWithRegistration({
      probe, referenceWidth: W, referenceHeight: H, probeToReference: cropTransform(left, top, s),
      candidates: candidatesFor(VAULT_A), reference: ORIGINAL,
    });
    expect(read?.lookupId).toBe(watermarkRecipientLookupId(VAULT_A, DNA, 'carol'));
    expect(read!.z).toBeGreaterThanOrEqual(6);
    if (read!.runnerUpZ !== null) expect(read!.runnerUpZ).toBeLessThan(4);
  }, SLOW);

  test('an unmarked piece reads nothing', async () => {
    const probe = await cropOf(ORIGINAL, 300, 220, 300, 225, 1);
    expect(await readMarkWithRegistration({
      probe, referenceWidth: W, referenceHeight: H, probeToReference: cropTransform(300, 220, 1),
      candidates: candidatesFor(VAULT_A), reference: ORIGINAL,
    })).toBeNull();
  }, SLOW);

  test('a copy of the same picture issued from ANOTHER record does not match this record\'s candidates', async () => {
    // Same pixels, same recipient name, different vault: the marks share only the fixed header bits, which are
    // excluded from the test, so nothing here may be named.
    const probe = await cropOf(markedForCarolInVaultB, 300, 220, 400, 300, 1);
    expect(await readMarkWithRegistration({
      probe, referenceWidth: W, referenceHeight: H, probeToReference: cropTransform(300, 220, 1),
      candidates: candidatesFor(VAULT_A), reference: ORIGINAL,
    })).toBeNull();
  }, SLOW);

  test('a wrong alignment (9 px off) never names anyone', async () => {
    const probe = await cropOf(markedForCarol, 300, 220, 400, 300, 1);
    expect(await readMarkWithRegistration({
      probe, referenceWidth: W, referenceHeight: H, probeToReference: cropTransform(309, 229, 1),
      candidates: candidatesFor(VAULT_A), reference: ORIGINAL,
    })).toBeNull();
  }, SLOW);

  test('the whole copy reads with every tile, including the edge tiles (no NaN)', async () => {
    const read = await readMarkWithRegistration({
      probe: markedForCarol, referenceWidth: W, referenceHeight: H, probeToReference: [[1, 0, 0], [0, 1, 0]],
      candidates: candidatesFor(VAULT_A), reference: ORIGINAL,
    });
    expect(read?.lookupId).toBe(watermarkRecipientLookupId(VAULT_A, DNA, 'carol'));
    expect(Number.isFinite(read!.z)).toBe(true);
  }, SLOW);
});
