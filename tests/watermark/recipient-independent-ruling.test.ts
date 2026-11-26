/**
 * "No mark strength is invisible on this picture" may be remembered for the PICTURE (every recipient) only when it cannot depend on
 * the recipient. Each recipient's mark carries different bits, so a picture near a clarity limit can pass for one recipient and fail
 * for another (measured: one photo took the crop strength for 11 of 20 recipients and the main-only strength for the other 9).
 * The ruling is held for every recipient only when every strength failed by a wide margin on a measure the bits barely move.
 */
import './helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { describe, test, expect } from '@jest/globals';
import crypto from 'crypto';
import sharp from 'sharp';
import { embedRobustProvenanceWatermark, failsForEveryRecipient, measureEveryCropStrength } from '../../src/services/dna-vnext/robust-watermark';
import type { ClarityReport } from '../../src/services/dna-vnext/clarity-gate';

const LIMITS = { minPsnrDb: 36, maxFlatMeanDeviation: 2, maxFlatPeakDeviation: 6, maxGridScore: 8, maxVisibleShare: 0.003 };
const report = (over: Partial<ClarityReport>): ClarityReport => ({
  psnrDb: 40, flatMeanDeviation: 0.5, flatPeakDeviation: 2, gridScore: 0.5, flatShare: 0.3, passed: false, failed: [], ...over,
});

async function raw(kind: 'noise' | 'gradient' | 'text' | 'white-sky', width: number, height: number, seed = 7, amp = 120): Promise<Buffer> {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      let r = 0; let g = 0; let b = 0;
      if (kind === 'noise') { r = g = b = 128 + (rnd() - 0.5) * amp; }
      if (kind === 'gradient') { r = 40 + (180 * x) / width; g = 60 + (150 * y) / height; b = 200 - (120 * x) / width; }
      if (kind === 'text') { const on = Math.floor(x / 3) % 7 < 4 && Math.floor(y / 14) % 3 === 0 && x % 220 < 170; r = g = b = on ? 0 : 255; }
      if (kind === 'white-sky') { const sky = y < height * 0.55; r = sky ? 255 : 60 + rnd() * 120; g = sky ? 255 : 70 + rnd() * 100; b = sky ? 252 : 40 + rnd() * 90; }
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
    }
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

const embed = (buffer: Buffer, recipientKey: string) => embedRobustProvenanceWatermark({ buffer, mimeType: 'image/png', vaultId: 'v-rule', dnaRecordId: 'd-rule', recipientKey });

describe('failsForEveryRecipient', () => {
  test('a PSNR failure counts only when it is more than 1 dB under the limit, on any strength', () => {
    expect(failsForEveryRecipient('faint+crop', report({ psnrDb: 34.9 }), LIMITS)).toBe(true);
    expect(failsForEveryRecipient('faint+crop', report({ psnrDb: 35.1 }), LIMITS)).toBe(false);
    expect(failsForEveryRecipient('main-faint', report({ psnrDb: 34.9 }), LIMITS)).toBe(true);
  });

  test('flat-area failures count only on main-only strengths (on crop strengths the bits move them too much)', () => {
    expect(failsForEveryRecipient('main-faint', report({ flatMeanDeviation: 2.31 }), LIMITS)).toBe(true);
    expect(failsForEveryRecipient('main-faint', report({ flatMeanDeviation: 2.29 }), LIMITS)).toBe(false);
    expect(failsForEveryRecipient('faint+crop', report({ flatMeanDeviation: 5 }), LIMITS)).toBe(false);
    expect(failsForEveryRecipient('main-soft', report({ flatPeakDeviation: 9 }), LIMITS)).toBe(true);
    expect(failsForEveryRecipient('main-soft', report({ flatPeakDeviation: 8 }), LIMITS)).toBe(false);
    expect(failsForEveryRecipient('soft+crop', report({ flatPeakDeviation: 20 }), LIMITS)).toBe(false);
  });

  test('the grid score never counts: it depends on the bits', () => {
    expect(failsForEveryRecipient('main-faint', report({ gridScore: 50 }), LIMITS)).toBe(false);
  });
});

describe('the ruling a delivery reports', () => {
  test('a picture every strength shows on is ruled out for every recipient, whoever asks', async () => {
    const buffer = await raw('noise', 1000, 800);
    for (let i = 0; i < 4; i++) {
      const wm = await embed(buffer, crypto.randomBytes(8).toString('hex'));
      expect(wm.embedded).toBe(false);
      expect(wm.method).toBe('clarity-gate: no invisible strength');
      expect(wm.forEveryRecipient).toBe(true);
      expect(wm.buffer).toBe(buffer);
    }
  });

  test('a picture that can be marked is marked, and says nothing about other recipients', async () => {
    const wm = await embed(await raw('gradient', 1000, 800), 'someone');
    expect(wm.embedded).toBe(true);
    expect(wm.forEveryRecipient).toBeUndefined();
  });

  test('soundness: whenever the ruling is held for every recipient, no other recipient\'s mark passes any strength', async () => {
    const pictures = [
      await raw('noise', 640, 480, 3, 120), await raw('noise', 640, 480, 5, 90), await raw('noise', 640, 480, 9, 60),
      await raw('noise', 640, 480, 21, 40), await raw('text', 640, 480), await raw('white-sky', 640, 480), await raw('gradient', 640, 480),
    ];
    let held = 0;
    for (const buffer of pictures) {
      const wm = await embed(buffer, crypto.randomBytes(8).toString('hex'));
      if (wm.embedded || !wm.forEveryRecipient) continue;
      held++;
      const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let i = 0; i < 5; i++) {
        const rows = measureEveryCropStrength(data, info.width, info.height, crypto.randomBytes(8).toString('hex'));
        expect(rows.filter((r: { report: ClarityReport }) => r.report.passed).map((r: { rung: string }) => r.rung)).toEqual([]);
      }
    }
    expect(held).toBeGreaterThan(0);
  }, 600_000);
});
