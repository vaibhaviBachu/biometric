/**
 * The scanner keeps the sharpest frame of a short burst and refuses a clearly out-of-focus capture. Pure functions on
 * pixel arrays, tested with generated patterns (a sharp texture, then the same texture blurred).
 */
import { describe, test, expect } from '@jest/globals';
import {
  BLURRY_BELOW,
  SHARPNESS_WIDTH,
  isBlurry,
  laplacianVariance,
  lumaFromRgba,
  pickSharpest,
  sharpnessOfRgba,
} from '../../client/src/lib/scan-sharpness';

const W = SHARPNESS_WIDTH;
const H = 240;

/** A deterministic detailed texture as RGBA. */
function texture(): Uint8ClampedArray {
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = ((i % W) % 8 < 4 ? 70 : 190) + (rnd() - 0.5) * 60; // stripes plus noise: lots of fine edges
    rgba[i * 4] = v; rgba[i * 4 + 1] = v * 0.9; rgba[i * 4 + 2] = v * 0.8; rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** Box blur of a given radius, applied to an RGBA array (defocus stand-in). */
function blur(rgba: Uint8ClampedArray, radius: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0; let n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const yy = y + dy; const xx = x + dx;
            if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
            sum += rgba[(yy * W + xx) * 4 + c]!; n++;
          }
        }
        out[(y * W + x) * 4 + c] = sum / n;
      }
      out[(y * W + x) * 4 + 3] = 255;
    }
  }
  return out;
}

describe('sharpness', () => {
  const sharp = texture();
  const soft = blur(sharp, 2);
  const veryBlurred = blur(sharp, 12);

  test('a detailed sharp frame scores far above a blurred one, and blur lowers it step by step', () => {
    const a = sharpnessOfRgba(sharp, W, H);
    const b = sharpnessOfRgba(soft, W, H);
    const c = sharpnessOfRgba(veryBlurred, W, H);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(a).toBeGreaterThan(BLURRY_BELOW * 10);
  });

  test('a heavily defocused frame is blurry and a detailed one is not', () => {
    expect(isBlurry(sharpnessOfRgba(veryBlurred, W, H))).toBe(true);
    expect(isBlurry(sharpnessOfRgba(sharp, W, H))).toBe(false);
  });

  test('a perfectly flat frame has no detail at all', () => {
    const flat = new Uint8ClampedArray(W * H * 4).fill(128);
    expect(sharpnessOfRgba(flat, W, H)).toBe(0);
    expect(isBlurry(0)).toBe(true);
  });

  test('the score does not depend on brightness alone', () => {
    const dim = new Uint8ClampedArray(sharp.length);
    for (let i = 0; i < sharp.length; i++) dim[i] = i % 4 === 3 ? 255 : sharp[i]! * 0.5 + 20;
    expect(isBlurry(sharpnessOfRgba(dim, W, H))).toBe(false);
  });

  test('tiny or malformed input gives 0 instead of throwing', () => {
    expect(laplacianVariance([1, 2, 3], 3, 1)).toBe(0);
    expect(laplacianVariance(new Float32Array(4), 10, 10)).toBe(0);
    expect(laplacianVariance(new Float32Array(0), 0, 0)).toBe(0);
  });

  test('luma weights follow the usual perception (green counts most)', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    const luma = lumaFromRgba(rgba, 3);
    expect(luma[1]!).toBeGreaterThan(luma[0]!);
    expect(luma[0]!).toBeGreaterThan(luma[2]!);
  });
});

describe('pickSharpest', () => {
  test('keeps the frame with the highest score', () => {
    const best = pickSharpest([{ score: 40, frame: 'a' }, { score: 310, frame: 'b' }, { score: 120, frame: 'c' }]);
    expect(best).toEqual({ score: 310, frame: 'b' });
  });

  test('the first frame wins a tie, and scores that are not numbers are ignored', () => {
    expect(pickSharpest([{ score: 10, frame: 'first' }, { score: 10, frame: 'second' }])?.frame).toBe('first');
    expect(pickSharpest([{ score: NaN, frame: 'bad' }, { score: 5, frame: 'ok' }])?.frame).toBe('ok');
  });

  test('an empty burst has no best frame', () => {
    expect(pickSharpest([])).toBeNull();
    expect(pickSharpest([{ score: NaN, frame: 'bad' }])).toBeNull();
  });
});
