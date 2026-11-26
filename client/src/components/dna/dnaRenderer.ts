/**
 * Paints a lit 3D DNA double helix onto a 2D canvas: glossy metallic backbone spheres, translucent
 * base-pair rungs, perspective, painter's-order depth sorting, depth-of-field toward both ends and a
 * few out-of-focus molecular particles. No WebGL and no image files — one paint per placement.
 */

export interface HelixPlacement {
  /** Helix centre as a fraction of the canvas (0..1). */
  x: number;
  y: number;
  /** Axis angle in degrees; 0 = vertical. */
  tilt: number;
  /** Size relative to the canvas' shorter side. */
  scale: number;
  /** Visible helical turns. */
  turns: number;
  /** Phase offset in radians, so each page shows a different twist. */
  phase: number;
}

type Sphere = { x: number; y: number; z: number; r: number; kind: 'a' | 'b' | 'pairA' | 'pairB' };

// Palette strictly from black / cobalt #1F6F8D / white
const SHADE = {
  a:     { hi: '255,255,255', mid: '122,133,217', base: '44,52,128',  edge: '8,10,28' },   // cobalt metal
  b:     { hi: '255,255,255', mid: '186,191,210', base: '92,98,128',  edge: '8,9,18' },     // silver metal
  pairA: { hi: '255,255,255', mid: '154,163,227', base: '54,63,151',   edge: '10,12,32' },
  pairB: { hi: '255,255,255', mid: '226,229,242', base: '146,152,182', edge: '12,13,24' },
} as const;

/** Deterministic pseudo-random, so a page always gets the same particles. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function buildHelix(w: number, h: number, p: HelixPlacement): { spheres: Sphere[]; axis: [number, number, number, number] } {
  const short = Math.min(w, h);
  const R = short * 0.13 * p.scale;           // helix radius
  const L = Math.hypot(w, h) * 0.95 * p.scale; // axis length (runs past the edges)
  const tilt = (p.tilt * Math.PI) / 180;
  const ax = Math.sin(tilt), ay = Math.cos(tilt);      // axis direction
  const px = Math.cos(tilt), py = -Math.sin(tilt);     // in-plane perpendicular
  const cx = p.x * w, cy = p.y * h;
  const D = R * 5.5;                                   // camera distance for perspective
  const spheres: Sphere[] = [];

  const project = (u: number, theta: number) => {
    const xl = R * Math.cos(theta);
    const z = R * Math.sin(theta);
    const f = D / (D - z);
    return { x: cx + ax * u + px * xl * f, y: cy + ay * u + py * xl * f, z, f };
  };

  const perTurn = 72; // dense enough that overlapping spheres read as one continuous glossy tube
  const steps = Math.round(p.turns * perTurn);
  const groove = 2.3; // strands are offset by ~132°, giving the real major/minor groove look
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = (t - 0.5) * L;
    const th = t * p.turns * Math.PI * 2 + p.phase;
    const a = project(u, th);
    const b = project(u, th + groove);
    spheres.push({ x: a.x, y: a.y, z: a.z, r: R * 0.13 * a.f, kind: 'a' });
    spheres.push({ x: b.x, y: b.y, z: b.z, r: R * 0.13 * b.f, kind: 'b' });
  }

  const pairsPerTurn = 10;
  const pairs = Math.round(p.turns * pairsPerTurn);
  const seg = 20; // likewise: rungs read as solid cylinders
  for (let i = 0; i <= pairs; i++) {
    const t = i / pairs;
    const u = (t - 0.5) * L;
    const th = t * p.turns * Math.PI * 2 + p.phase;
    for (let k = 1; k < seg; k++) {
      const q = k / seg;
      // interpolate around the shorter arc between the two strands, through the axis
      const thA = th, thB = th + groove;
      const xa = Math.cos(thA), za = Math.sin(thA), xb = Math.cos(thB), zb = Math.sin(thB);
      const xl = R * 0.86 * (xa + (xb - xa) * q);
      const z = R * 0.86 * (za + (zb - za) * q);
      const f = D / (D - z);
      spheres.push({
        x: cx + ax * u + px * xl * f,
        y: cy + ay * u + py * xl * f,
        z,
        r: R * 0.055 * f,
        kind: q < 0.5 ? 'pairA' : 'pairB',
      });
    }
  }

  spheres.sort((m, n) => m.z - n.z);
  return { spheres, axis: [cx - (ax * L) / 2, cy - (ay * L) / 2, cx + (ax * L) / 2, cy + (ay * L) / 2] };
}

function drawSphere(ctx: CanvasRenderingContext2D, s: Sphere, R: number) {
  const c = SHADE[s.kind];
  const depth = (s.z / R + 1) / 2; // 0 far … 1 near
  const alpha = 0.3 + depth * 0.55;
  const g = ctx.createRadialGradient(s.x - s.r * 0.38, s.y - s.r * 0.42, s.r * 0.05, s.x, s.y, s.r);
  g.addColorStop(0, `rgba(${c.hi},${0.95 * alpha})`);
  g.addColorStop(0.16, `rgba(${c.mid},${0.92 * alpha})`);
  g.addColorStop(0.58, `rgba(${c.base},${0.9 * alpha})`);
  g.addColorStop(0.9, `rgba(${c.edge},${0.95 * alpha})`);
  g.addColorStop(1, `rgba(108,199,231,${0.55 * alpha})`); // cobalt rim light
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
  ctx.fill();
}

/** Paint the full scene. `w`/`h` are CSS pixels; the context should already be scaled for DPR. */
export function paintDnaScene(ctx: CanvasRenderingContext2D, w: number, h: number, p: HelixPlacement, seed = 7) {
  ctx.clearRect(0, 0, w, h);

  // Atmosphere: a cobalt light pool behind the helix, fading into black
  const glow = ctx.createRadialGradient(p.x * w, p.y * h, 0, p.x * w, p.y * h, Math.max(w, h) * 0.55 * p.scale);
  glow.addColorStop(0, 'rgba(31,111,141,0.42)');
  glow.addColorStop(0.45, 'rgba(31,111,141,0.14)');
  glow.addColorStop(1, 'rgba(31,111,141,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const { spheres, axis } = buildHelix(w, h, p);
  const R = Math.min(w, h) * 0.13 * p.scale;

  // Sharp pass on an offscreen layer
  const sharp = document.createElement('canvas');
  sharp.width = ctx.canvas.width;
  sharp.height = ctx.canvas.height;
  const sctx = sharp.getContext('2d');
  if (!sctx) return;
  const k = ctx.canvas.width / w;
  sctx.scale(k, k);
  for (const s of spheres) drawSphere(sctx, s, R);

  // Depth of field: a blurred copy everywhere, the sharp copy only around the middle of the axis
  const supportsFilter = typeof (ctx as { filter?: unknown }).filter === 'string';
  if (supportsFilter) {
    ctx.save();
    ctx.filter = `blur(${Math.max(6, R * 0.14)}px)`;
    ctx.globalAlpha = 0.8;
    ctx.drawImage(sharp, 0, 0, w, h);
    ctx.restore();

    const focus = document.createElement('canvas');
    focus.width = sharp.width;
    focus.height = sharp.height;
    const fctx = focus.getContext('2d');
    if (fctx) {
      fctx.drawImage(sharp, 0, 0);
      fctx.globalCompositeOperation = 'destination-in';
      const [x1, y1, x2, y2] = axis.map((n) => n * k) as [number, number, number, number];
      const m = fctx.createLinearGradient(x1, y1, x2, y2);
      m.addColorStop(0, 'rgba(0,0,0,0)');
      m.addColorStop(0.36, 'rgba(0,0,0,0.85)');
      m.addColorStop(0.5, 'rgba(0,0,0,1)');
      m.addColorStop(0.64, 'rgba(0,0,0,0.85)');
      m.addColorStop(1, 'rgba(0,0,0,0)');
      fctx.fillStyle = m;
      fctx.fillRect(0, 0, focus.width, focus.height);
      ctx.drawImage(focus, 0, 0, w, h);
    }
  } else {
    ctx.drawImage(sharp, 0, 0, w, h);
  }

  // Sparse out-of-focus particles — restrained "molecular" detail
  const rand = rng(seed);
  const count = Math.round((w * h) / 52000);
  for (let i = 0; i < count; i++) {
    const x = rand() * w, y = rand() * h, r = 1 + rand() * 3.2;
    const a = 0.05 + rand() * 0.14;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
    g.addColorStop(0, rand() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(143,213,238,${a + 0.04})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}
