/**
 * Layer 2 was rewritten to stream three grey rows at a time instead of holding full-size grey, gradient, angle and
 * 3-channel edge-map arrays (~15 bytes per pixel, ~720 MB for a 48 MP photo). Stored fingerprints must not change,
 * so this runs the previous implementation (copied verbatim below from the commit before the change) next to the new
 * one and requires every output to be identical, including tiny and odd sizes where borders and zones are edge cases.
 */
import { describe, test, expect } from '@jest/globals';
import { structuralCore } from '../../src/services/layers/layer2.core';

interface RefResult {
  normalisedRgb: Uint8Array;
  edgeVectors: Array<{ angle: number; magnitude: number }>;
  signatureBits: number[];
  edgePixelCount: number;
  firstEdgePixels: number[];
}

// ── Previous implementation, unchanged ──────────────────────────────────────
function referenceCore(rawRgb: Uint8Array, width: number, height: number): RefResult {
  const SOBEL_X = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
  const SOBEL_Y = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];
  const EDGE_THRESHOLD = 30;
  const GRID_SIZE = 8;
  const KEEP_FIRST_EDGE_PIXELS = 64;

  // RGB -> grayscale (Y = 0.299R + 0.587G + 0.114B)
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rawRgb[i * 3];
    const g = rawRgb[i * 3 + 1];
    const b = rawRgb[i * 3 + 2];
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  // Sobel gradient magnitude + angle (1px border excluded)
  const gradient = new Float32Array(width * height);
  const gradientAngle = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0;
      let gy = 0;
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const pixel = gray[(y + ky - 1) * width + (x + kx - 1)];
          gx += pixel * SOBEL_X[ky][kx];
          gy += pixel * SOBEL_Y[ky][kx];
        }
      }
      const mag = Math.sqrt(gx * gx + gy * gy);
      gradient[y * width + x] = mag;
      gradientAngle[y * width + x] = ((Math.atan2(gy, gx) * 180) / Math.PI + 360) % 360;
    }
  }

  // Edge pixels: only the count and the first few indices are ever needed.
  let edgePixelCount = 0;
  const firstEdgePixels: number[] = [];
  for (let i = 0; i < gradient.length; i++) {
    if (gradient[i] > EDGE_THRESHOLD) {
      if (firstEdgePixels.length < KEEP_FIRST_EDGE_PIXELS) firstEdgePixels.push(i);
      edgePixelCount++;
    }
  }

  // 64 zones, one dominant edge vector each
  const edgeVectors: Array<{ angle: number; magnitude: number }> = [];
  const zoneW = Math.floor(width / GRID_SIZE);
  const zoneH = Math.floor(height / GRID_SIZE);
  for (let zy = 0; zy < GRID_SIZE; zy++) {
    for (let zx = 0; zx < GRID_SIZE; zx++) {
      let totalMag = 0;
      let totalAngle = 0;
      let count = 0;
      for (let py = zy * zoneH; py < (zy + 1) * zoneH && py < height; py++) {
        for (let px = zx * zoneW; px < (zx + 1) * zoneW && px < width; px++) {
          const idx = py * width + px;
          if (gradient[idx] > EDGE_THRESHOLD) {
            totalMag += gradient[idx];
            totalAngle += gradientAngle[idx];
            count++;
          }
        }
      }
      const zoneArea = zoneW * zoneH;
      edgeVectors.push({
        angle: count > 0 ? totalAngle / count : 0,
        magnitude: count > 0 ? Math.min(totalMag / (zoneArea * 255), 1.0) : 0,
      });
    }
  }

  // 64-bit signature: bit = 1 when the zone density is above the global mean
  const densities = edgeVectors.map((v) => v.magnitude);
  let sum = 0;
  for (let i = 0; i < densities.length; i++) sum += densities[i];
  const meanDensity = sum / densities.length;
  const signatureBits = densities.map((d) => (d > meanDensity ? 1 : 0));

  // Edge-map normalisation (gradient -> 0..255, replicated to 3 channels)
  let maxGrad = 0;
  for (let i = 0; i < gradient.length; i++) {
    if (gradient[i] > maxGrad) maxGrad = gradient[i];
  }
  const normalisedRgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < gradient.length; i++) {
    const v = maxGrad > 0 ? Math.round((gradient[i] / maxGrad) * 255) : 0;
    normalisedRgb[i * 3] = v;
    normalisedRgb[i * 3 + 1] = v;
    normalisedRgb[i * 3 + 2] = v;
  }

  return { normalisedRgb, edgeVectors, signatureBits, edgePixelCount, firstEdgePixels };
}


// ────────────────────────────────────────────────────────────────────────────

function pixels(w: number, h: number, seed: number, flat = false): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  let s = seed;
  for (let i = 0; i < px.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const x = ((i / 3) | 0) % w;
    const y = (i / 3 / w) | 0;
    px[i] = flat ? 128 : ((((x >> 3) + (y >> 3)) % 2 ? 200 : 40) + ((s >>> 24) % 50)) & 255;
  }
  return px;
}

const SIZES: Array<[number, number]> = [
  [1, 1], [2, 5], [3, 3], [4, 4], [7, 9], [8, 8], [9, 17], [15, 16], [17, 3], [64, 48], [97, 61], [333, 211], [800, 601],
];

describe('streaming Layer 2 core matches the previous implementation byte for byte', () => {
  test.each(SIZES)('%ix%i', (w, h) => {
    for (const [seed, flat] of [[1, false], [2, false], [3, true]] as Array<[number, boolean]>) {
      const raw = pixels(w, h, seed, flat);
      const before = referenceCore(raw, w, h);
      const after = structuralCore(raw, w, h);
      expect(after.edgeVectors).toEqual(before.edgeVectors);
      expect(after.signatureBits).toEqual(before.signatureBits);
      expect(after.edgePixelCount).toBe(before.edgePixelCount);
      expect(after.firstEdgePixels).toEqual(before.firstEdgePixels);
      // The edge map is grey: every pixel's R, G and B equal the single channel now returned.
      for (let i = 0; i < w * h; i++) {
        const v = after.normalisedGray[i];
        if (before.normalisedRgb[i * 3] !== v || before.normalisedRgb[i * 3 + 1] !== v || before.normalisedRgb[i * 3 + 2] !== v) {
          throw new Error(`edge map differs at pixel ${i} (${w}x${h}, seed ${seed})`);
        }
      }
    }
  });

  test('does not modify the pixels it is given', () => {
    const raw = pixels(120, 90, 7);
    const copy = Uint8Array.from(raw);
    structuralCore(raw, 120, 90);
    expect(Buffer.from(raw).equals(Buffer.from(copy))).toBe(true);
  });
});
