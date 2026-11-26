/** The difference map must reflect real pixel differences and must refuse to compare differently framed images. */
import { describe, test, expect } from '@jest/globals';
import { diffPixels, sameFraming, visuallyIdentical } from '../../client/src/lib/image-difference';

function solid(w: number, h: number, rgb: [number, number, number]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    a[i * 4] = rgb[0]; a[i * 4 + 1] = rgb[1]; a[i * 4 + 2] = rgb[2]; a[i * 4 + 3] = 255;
  }
  return a;
}

describe('diffPixels', () => {
  test('identical images give zero difference and no regions', () => {
    const a = solid(32, 32, [120, 80, 40]);
    const r = diffPixels(a, solid(32, 32, [120, 80, 40]), 32, 32);
    expect(r.changedPixelPercent).toBe(0);
    expect(r.meanDifferencePercent).toBe(0);
    expect(r.regions).toHaveLength(0);
    expect(visuallyIdentical(r)).toBe(true);
  });

  test('a changed block is measured and located', () => {
    const a = solid(64, 64, [100, 100, 100]);
    const b = solid(64, 64, [100, 100, 100]);
    // change the top-left quarter (32x32 of 64x64 = 25% of pixels)
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = (y * 64 + x) * 4; b[i] = 255; b[i + 1] = 10; b[i + 2] = 10;
    }
    const r = diffPixels(a, b, 64, 64);
    expect(r.changedPixelPercent).toBe(25);
    expect(visuallyIdentical(r)).toBe(false);
    expect(r.regions.length).toBe(16); // 4x4 of the 8x8 grid
    expect(Math.min(...r.regions.map((c) => c.x))).toBe(0);
    expect(Math.max(...r.regions.map((c) => c.x + c.w))).toBeLessThanOrEqual(0.5 + 1e-9);
    // the map colours the changed pixels and keeps the rest dark
    expect(r.heatmap[0]).toBeGreaterThan(r.heatmap[2]);
    const untouched = (63 * 64 + 63) * 4;
    expect(r.heatmap[untouched]).toBeLessThan(60);
  });

  test('tiny recompression noise stays under the changed-pixel threshold', () => {
    const a = solid(32, 32, [100, 100, 100]);
    const b = solid(32, 32, [102, 99, 101]);
    const r = diffPixels(a, b, 32, 32);
    expect(r.changedPixelPercent).toBe(0);
    expect(visuallyIdentical(r)).toBe(true);
  });
});

describe('sameFraming', () => {
  test('same proportions at different sizes are comparable', () => {
    expect(sameFraming(4000, 3000, 1024, 768)).toBe(true);
  });
  test('a crop or different aspect ratio is not comparable', () => {
    expect(sameFraming(4000, 3000, 3000, 3000)).toBe(false);
    expect(sameFraming(0, 0, 10, 10)).toBe(false);
  });
});
