/**
 * Synthetic images for the scan tests: deterministic, generated in memory, and not derived from any real photo or
 * from the database. Enough corners and texture for feature matching, and unique per seed.
 */
import sharp from 'sharp';

/** Small seeded generator, so a given seed always produces the same picture. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const color = (rnd: () => number) => `rgb(${Math.floor(rnd() * 256)},${Math.floor(rnd() * 256)},${Math.floor(rnd() * 256)})`;

/** SVG fragments: many random shapes in the region [x0,x1]×[y0,y1] (as fractions of the picture). */
function shapes(seed: number, w: number, h: number, count: number, region = { x0: 0, y0: 0, x1: 1, y1: 1 }): string {
  const rnd = seeded(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const cx = (region.x0 + rnd() * (region.x1 - region.x0)) * w;
    const cy = (region.y0 + rnd() * (region.y1 - region.y0)) * h;
    const size = 12 + rnd() * Math.min(w, h) * 0.18;
    const fill = color(rnd);
    const kind = Math.floor(rnd() * 4);
    if (kind === 0) out.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(size / 2).toFixed(1)}" fill="${fill}"/>`);
    else if (kind === 1) out.push(`<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${size.toFixed(1)}" height="${(size * (0.4 + rnd())).toFixed(1)}" fill="${fill}" transform="rotate(${(rnd() * 90).toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})"/>`);
    else if (kind === 2) out.push(`<polygon points="${cx.toFixed(1)},${cy.toFixed(1)} ${(cx + size).toFixed(1)},${(cy + size * rnd()).toFixed(1)} ${(cx + size * rnd()).toFixed(1)},${(cy + size).toFixed(1)}" fill="${fill}"/>`);
    else out.push(`<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(cx + (rnd() - 0.5) * size * 3).toFixed(1)}" y2="${(cy + (rnd() - 0.5) * size * 3).toFixed(1)}" stroke="${fill}" stroke-width="${(2 + rnd() * 6).toFixed(1)}"/>`);
  }
  return out.join('');
}

/** A picture unique to `seed`. */
export async function syntheticPicture(seed: number, w = 960, h = 720): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color(seeded(seed ^ 0x5bd1e995))}"/>${shapes(seed, w, h, 260)}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/**
 * Two pictures that share a background but differ in the part drawn over it. `covered` is the share of the width,
 * from the right, that the second picture redraws (0 = identical, 1 = completely different).
 */
export async function templatePair(seed: number, covered: number, w = 960, h = 720): Promise<[Buffer, Buffer]> {
  const background = `<rect width="100%" height="100%" fill="${color(seeded(seed ^ 0x2545f491))}"/>${shapes(seed, w, h, 260)}`;
  const x0 = 1 - covered;
  const first = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${background}<g>${shapes(seed + 1, w, h, 130, { x0, y0: 0, x1: 1, y1: 1 })}</g></svg>`;
  const second = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${background}<rect x="${(x0 * w).toFixed(0)}" y="0" width="${(covered * w).toFixed(0)}" height="${h}" fill="${color(seeded(seed + 9))}"/><g>${shapes(seed + 2, w, h, 130, { x0, y0: 0, x1: 1, y1: 1 })}</g></svg>`;
  return [
    await sharp(Buffer.from(first)).jpeg({ quality: 92 }).toBuffer(),
    await sharp(Buffer.from(second)).jpeg({ quality: 92 }).toBuffer(),
  ];
}

export type Edit = (input: Buffer) => Promise<Buffer>;

async function crop(buf: Buffer, k: number): Promise<Buffer> {
  const { width: w = 1, height: h = 1 } = await sharp(buf).metadata();
  return sharp(buf).extract({ left: Math.round((w * (1 - k)) / 2), top: Math.round((h * (1 - k)) / 2), width: Math.round(w * k), height: Math.round(h * k) }).jpeg({ quality: 90 }).toBuffer();
}

/** The edits a copy typically goes through. */
export const EDITS: Record<string, Edit> = {
  'recompressed (q40)': (b) => sharp(b).jpeg({ quality: 40 }).toBuffer(),
  'resized 50% + q60': async (b) => sharp(b).resize(Math.round(((await sharp(b).metadata()).width ?? 800) / 2)).jpeg({ quality: 60 }).toBuffer(),
  'crop 90%': (b) => crop(b, 0.9),
  'crop 75%': (b) => crop(b, 0.75),
  'rotate 3°': (b) => sharp(b).rotate(3, { background: '#000' }).jpeg({ quality: 90 }).toBuffer(),
  'rotate 90°': (b) => sharp(b).rotate(90).jpeg({ quality: 90 }).toBuffer(),
  'overlay band': async (b) => {
    const { width: w = 1, height: h = 1 } = await sharp(b).metadata();
    const band = Buffer.from(`<svg width="${w}" height="${h}"><rect x="0" y="${Math.round(h * 0.42)}" width="${w}" height="${Math.round(h * 0.16)}" fill="black"/></svg>`);
    return sharp(b).composite([{ input: band }]).jpeg({ quality: 90 }).toBuffer();
  },
  'border 10%': async (b) => {
    const { width: w = 1, height: h = 1 } = await sharp(b).metadata();
    return sharp(b).extend({ top: Math.round(h * 0.1), bottom: Math.round(h * 0.1), left: Math.round(w * 0.1), right: Math.round(w * 0.1), background: '#fff' }).jpeg({ quality: 90 }).toBuffer();
  },
  /** A stand-in for photographing a screen: tilt, dimmer and duller colours, a little blur, a dark frame, recompression. */
  'photo of a screen (simulated)': async (b) =>
    sharp(await sharp(b).rotate(4, { background: '#222' }).modulate({ brightness: 0.85, saturation: 0.8 }).blur(1.2)
      .extend({ top: 60, bottom: 60, left: 60, right: 60, background: '#111' }).toBuffer()).jpeg({ quality: 70 }).toBuffer(),
};

/** Edits that are expected to fall short of "Protected" and stay "Possible" (measured: too little of the picture left or reversed). */
export const WEAKER_EDITS: Record<string, Edit> = {
  mirror: (b) => sharp(b).flop().jpeg({ quality: 90 }).toBuffer(),
  'crop 50%': (b) => crop(b, 0.5),
};
