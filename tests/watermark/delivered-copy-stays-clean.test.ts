/**
 * Guard for the 2026-11-20 bug: shared-link views and downloads showed a dotted grid on smooth skies, night photos and
 * along edges. Two protections are pinned here:
 *
 *  1. The pixel mark on delivered copies is OFF unless DNA_VNEXT_WATERMARK_ON_DOWNLOAD=true: the copy is the original bytes.
 *  2. Even when it is switched on, the clarity gate's "visible" check refuses any copy whose change shows on a smooth area
 *     (a gradient sky, a night sky, the smooth side of an edge), so such a picture is delivered unmarked.
 */
import sharp from 'sharp';
import { measureClarity, clarityThresholds } from '../../src/services/dna-vnext/clarity-gate';

jest.setTimeout(600_000); // the full strength search on two photos is slow when other suites run alongside

async function rgbaOf(svg: string): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const SUNSET = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1280">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#6b6f78"/><stop offset="0.45" stop-color="#7d7f86"/>
    <stop offset="0.55" stop-color="#f3b24a"/><stop offset="0.62" stop-color="#8a8a90"/><stop offset="1" stop-color="#5b5e66"/></linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <polyline points="0,940 140,1040 240,1030 560,1200 960,1000" stroke="#1d1f24" stroke-width="12" fill="none"/></svg>`;

const NIGHT = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1200">
  <rect width="100%" height="100%" fill="#0d1014"/><polygon points="480,150 330,520 630,520" fill="#e7a43a"/>
  <rect y="820" width="100%" height="380" fill="#2a2420"/></svg>`;

/** A faint, regular pattern like the mark's: +/-1.5 luma in alternating 8-px cells. */
function withGridPattern(rgba: Buffer, width: number, height: number, amount = 1.5): Buffer {
  const out = Buffer.from(rgba);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sign = ((x >> 3) + (y >> 3)) % 2 === 0 ? 1 : -1;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round(out[i + c]! + sign * amount)));
    }
  }
  return out;
}

describe('a delivered copy never carries a visible pattern', () => {
  test('the pixel mark on delivered copies is off by default: the original bytes go out untouched', async () => {
    const saved = process.env.DNA_VNEXT_WATERMARK_ON_DOWNLOAD;
    delete process.env.DNA_VNEXT_WATERMARK_ON_DOWNLOAD;
    try {
      let embed: typeof import('../../src/services/dna-vnext/robust-watermark').embedRobustProvenanceWatermark;
      jest.isolateModules(() => {
        embed = require('../../src/services/dna-vnext/robust-watermark').embedRobustProvenanceWatermark;
      });
      const original = await sharp(Buffer.from(SUNSET)).jpeg({ quality: 92 }).toBuffer();
      const out = await embed!({ buffer: original, mimeType: 'image/jpeg', vaultId: 'v-guard', dnaRecordId: 'd-guard', recipientKey: 'r1' });
      expect(out.embedded).toBe(false);
      expect(out.method).toBe('disabled');
      expect(Buffer.compare(out.buffer, original)).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.DNA_VNEXT_WATERMARK_ON_DOWNLOAD;
      else process.env.DNA_VNEXT_WATERMARK_ON_DOWNLOAD = saved;
    }
  });

  test('an untouched copy passes the visible check', async () => {
    const { data, width, height } = await rgbaOf(SUNSET);
    const report = measureClarity(data, Buffer.from(data), width, height);
    expect(report.visibleShare).toBe(0);
    expect(report.passed).toBe(true);
  });

  test.each([
    ['a sunset sky (smooth gradient with an edge)', SUNSET],
    ['a night photo (dark, smooth areas)', NIGHT],
  ])('a faint regular pattern on %s is caught, even though the older limits let it through', async (_name, svg) => {
    const { data, width, height } = await rgbaOf(svg);
    const marked = withGridPattern(data, width, height);
    const report = measureClarity(data, marked, width, height);
    // the older limits alone would have passed this copy: that is how the bug shipped
    const limits = clarityThresholds();
    expect(report.psnrDb).toBeGreaterThan(limits.minPsnrDb);
    expect(report.gridScore).toBeLessThan(limits.maxGridScore);
    // the visible check refuses it
    expect(report.failed).toContain('visible');
    expect(report.passed).toBe(false);
  });

  test('a tiny random change on busy texture (leaves, gravel) is not called visible', async () => {
    const w = 640;
    const h = 640;
    const raw = Buffer.alloc(w * h * 4);
    for (let i = 0; i < raw.length; i += 4) {
      const v = 70 + Math.floor(Math.random() * 120);
      raw[i] = v; raw[i + 1] = v; raw[i + 2] = v; raw[i + 3] = 255;
    }
    const changed = Buffer.from(raw);
    for (let i = 0; i < changed.length; i += 4) {
      const n = Math.random() < 0.5 ? -1 : 1;
      for (let c = 0; c < 3; c++) changed[i + c] = Math.max(0, Math.min(255, changed[i + c]! + n));
    }
    const report = measureClarity(raw, changed, w, h);
    expect(report.failed).not.toContain('visible');
  });

  test('with the pixel mark switched on, smooth photos like the reported ones are still delivered without it', async () => {
    const saved = process.env.DNA_VNEXT_WATERMARK_ON_DOWNLOAD;
    const savedWorkers = process.env.FORENSIC_WORKERS;
    process.env.DNA_VNEXT_WATERMARK_ON_DOWNLOAD = 'true';
    process.env.FORENSIC_WORKERS = 'off';
    try {
      let embed: typeof import('../../src/services/dna-vnext/robust-watermark').embedRobustProvenanceWatermark;
      jest.isolateModules(() => {
        embed = require('../../src/services/dna-vnext/robust-watermark').embedRobustProvenanceWatermark;
      });
      for (const svg of [SUNSET, NIGHT]) {
        const original = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
        const out = await embed!({ buffer: original, mimeType: 'image/jpeg', vaultId: 'v-guard', dnaRecordId: 'd-guard', recipientKey: 'r1' });
        expect(out.embedded).toBe(false);
        expect(Buffer.compare(out.buffer, original)).toBe(0);
      }
    } finally {
      if (saved === undefined) delete process.env.DNA_VNEXT_WATERMARK_ON_DOWNLOAD;
      else process.env.DNA_VNEXT_WATERMARK_ON_DOWNLOAD = saved;
      if (savedWorkers === undefined) delete process.env.FORENSIC_WORKERS;
      else process.env.FORENSIC_WORKERS = savedWorkers;
    }
  });
});
