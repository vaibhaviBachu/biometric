/**
 * Does the hidden mark survive a PHOTO of a screen? Measured, not assumed.
 *
 * A phone photographing a screen is not one transform. It is a small turn and
 * shear (the phone is never square to the screen), a lower resolution, blur
 * from focus and distance, a stripe pattern from the screen's pixel grid,
 * sensor noise, a different brightness curve, and a JPEG save. Each case
 * below stacks those on a protected image and records whether the mark still
 * reads. The synthetic image is not a real camera or a real screen, so these
 * numbers show where the scheme breaks, not what a phone will do in practice.
 */
import './helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { describe, test, expect } from '@jest/globals';
import sharp from 'sharp';
import { embedRobustProvenanceWatermark, extractWatermarkLookupId } from '../../src/services/dna-vnext/robust-watermark';
import { watermarkLookupId } from '../../src/services/dna-vnext/crypto';

const SLOW = 600_000;
const W = 1600;
const H = 1200;

async function photo(): Promise<Buffer> {
  let s = 4242;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const v = 128 + 90 * Math.sin(x / 90) * Math.cos(y / 70);
      raw[i] = Math.max(0, Math.min(255, v + 40 * Math.sin(x / 200) + (rnd() - 0.5) * 14));
      raw[i + 1] = Math.max(0, Math.min(255, v * 0.8 + 50 * Math.cos(y / 130) + (rnd() - 0.5) * 14));
      raw[i + 2] = Math.max(0, Math.min(255, 255 - v + 30 * Math.sin((x + y) / 160) + (rnd() - 0.5) * 14));
    }
  }
  const shapes = Array.from({ length: 40 }, () =>
    `<circle cx="${(rnd() * W) | 0}" cy="${(rnd() * H) | 0}" r="${20 + rnd() * 90}" fill="rgb(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0})" fill-opacity="0.55"/>`).join('');
  const svg = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`);
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } }).composite([{ input: svg }]).png().toBuffer();
}

async function sensorNoise(b: Buffer, amount: number): Promise<Buffer> {
  const { data, info } = await sharp(b).raw().toBuffer({ resolveWithObject: true });
  let s = 99;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, data[i]! + (rnd() - 0.5) * amount));
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}

async function pixelGrid(b: Buffer, opacity: number): Promise<Buffer> {
  const meta = await sharp(b).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const svg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="g" width="3" height="3" patternUnits="userSpaceOnUse"><rect width="1" height="3" fill="black" fill-opacity="${opacity}"/><rect width="3" height="1" fill="black" fill-opacity="${opacity}"/></pattern></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`);
  return sharp(b).composite([{ input: svg }]).png().toBuffer();
}

type Case = [string, (b: Buffer) => Promise<Buffer>];

const cases: Case[] = [
  ['straight on, jpeg q75 (control)', (b) => sharp(b).jpeg({ quality: 75 }).toBuffer()],
  ['scaled to 60% and blurred', async (b) => sharp(await sharp(b).resize(960).blur(1).toBuffer()).jpeg({ quality: 70 }).toBuffer()],
  ['straight on + screen pixel grid + noise', async (b) => sharp(await sensorNoise(await pixelGrid(b, 0.1), 16)).jpeg({ quality: 70 }).toBuffer()],
  ['brightness and gamma shifted', async (b) => sharp(await sharp(b).gamma(1.4).modulate({ brightness: 0.85 }).toBuffer()).jpeg({ quality: 75 }).toBuffer()],
  ['turned 2 degrees', async (b) => sharp(await sharp(b).rotate(2, { background: '#202020' }).toBuffer()).jpeg({ quality: 75 }).toBuffer()],
  ['turned 5 degrees + 60% + blur', async (b) => sharp(await sharp(b).rotate(5, { background: '#202020' }).resize(960).blur(1).toBuffer()).jpeg({ quality: 70 }).toBuffer()],
  ['sheared (phone not square to the screen)', async (b) => sharp(await sharp(b).affine([[1, 0.06], [0.02, 1]], { background: '#202020' }).toBuffer()).jpeg({ quality: 75 }).toBuffer()],
  ['centre 60% cropped, as a camera frames it', async (b) => sharp(await sharp(b).extract({ left: 320, top: 240, width: 960, height: 720 }).toBuffer()).jpeg({ quality: 75 }).toBuffer()],
  ['full stack: turn 3, shear, 60%, blur, grid, noise, jpeg q60', async (b) => {
    const t = await sharp(b).rotate(3, { background: '#202020' }).affine([[1, 0.04], [0.01, 1]], { background: '#202020' }).resize(960).blur(1).toBuffer();
    return sharp(await sensorNoise(await pixelGrid(t, 0.08), 14)).jpeg({ quality: 60 }).toBuffer();
  }],
];

describe('hidden mark against a photo of a screen', () => {
  test('measured survival, pinned', async () => {
    const source = await photo();
    const vaultId = 'vault-screen-test';
    const dnaRecordId = 'dna-screen-test';
    const expected = watermarkLookupId(vaultId, dnaRecordId);
    const marked = await embedRobustProvenanceWatermark({ buffer: source, mimeType: 'image/png', vaultId, dnaRecordId });
    expect(marked.embedded).toBe(true);

    const results: Record<string, string> = {};
    for (const [name, run] of cases) {
      const hit = await extractWatermarkLookupId(await run(marked.buffer));
      results[name] = hit === expected ? 'reads' : hit ? 'WRONG ID' : 'lost';
    }
    // eslint-disable-next-line no-console
    console.log('SCREEN-PHOTO RESULTS\n' + JSON.stringify(results, null, 2));
    expect(Object.values(results)).not.toContain('WRONG ID');
    // Pinned 2026-10-12 on one synthetic image (1600x1200), not a real phone or screen.
    // What survives: scaling, blur, a screen pixel grid, noise, brightness and gamma.
    // What does NOT: any turn (even 2 degrees), a camera angle (shear), a centre crop,
    // and so the full stack. A phone photo is rarely square to the screen, so reading
    // the mark from a phone photo needs the image found and straightened first.
    // If a change makes any 'lost' below read, update this pin on purpose.
    // 2026-10-13: 'scaled to 60% and blurred' moved from reads to lost when the mark became invisible (the
    // clarity gate) and back to reads when the reader began combining soft evidence across all tile copies.
    expect(results).toEqual({
      'straight on, jpeg q75 (control)': 'reads',
      'scaled to 60% and blurred': 'reads',
      'straight on + screen pixel grid + noise': 'reads',
      'brightness and gamma shifted': 'reads',
      'turned 2 degrees': 'lost',
      'turned 5 degrees + 60% + blur': 'lost',
      'sheared (phone not square to the screen)': 'lost',
      'centre 60% cropped, as a camera frames it': 'lost',
      'full stack: turn 3, shear, 60%, blur, grid, noise, jpeg q60': 'lost',
    });
  }, SLOW);
});
