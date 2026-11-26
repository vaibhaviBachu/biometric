import { useEffect, useRef } from 'react';

/*
  The PINITHUB story, told in light behind every page (symbols only: no words, no technical detail):
    1. drifting specks gather into a file          "Every file you create"
    2. it becomes its own engraved emblem          "receives an identity of its own"
    3. the emblem becomes the PINIT mark, glowing  "bound to you, and only you"
    4. the light travels outward, a ring follows   "yours, wherever it goes"
  Sign-in / registration: the full story, in the open space beside the card (no words: the light tells it).
  Inside the app: the same light, softer (cards cover most of the screen); it plays now and then and
  every time a file is pinned (the 'pinit:story' event, sent when a file is stored).
  Pauses while the tab is hidden; a still glowing mark when the system asks for reduced motion.
*/

type Pt = [number, number];
interface Speck { x: number; y: number; vx: number; vy: number; c: number; s: number; ph: number; tx: number; ty: number }

const STORY = [
  { scene: 'file', dur: 2600 },
  { scene: 'emblem', dur: 2600 },
  { scene: 'mark', dur: 2800 },
  { scene: 'outward', dur: 2600 },
];
const LIGHT = ['#E8895A', '#F0A274', '#D9B07A', '#93C6C2', '#C9A98C', '#E9B58F'];
const DARK = ['#F4AC82', '#F6C9A8', '#E9C27E', '#93C6C2', '#D6B9A0', '#F0A274'];
// Navy & Copper palette: blue, cyan and a touch of copper
const NAVY_LIGHT = ['#3E86F0', '#2FA9B6', '#B65328', '#6E9DE8', '#8FA7C8', '#2E6FD9'];
const NAVY_DARK = ['#7FAEFF', '#54D6E5', '#F0A06E', '#A9CBFF', '#C9D8EE', '#5795FF'];
const isNavy = () => document.documentElement.getAttribute('data-palette') === 'navy-copper';
// Arctic Harbor: frost and ice on night, slate and mist on daylight
const ARCTIC_LIGHT = ['#2E4F6B', '#5F7F98', '#16314A', '#7F9BB0', '#46637D', '#3B5A74'];
const ARCTIC_DARK = ['#E8EFF3', '#C9D6DE', '#A9BDC9', '#FFFFFF', '#BFD1DD', '#8FA9BC'];
const isArctic = () => document.documentElement.getAttribute('data-palette') === 'arctic-harbor';
const AUTH_PATHS = /^\/(login|register|signup|sign-up|onboarding|unlock|welcome)/;

export function BrandStory({ router }: { router?: unknown }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const r = router as { state?: { location?: { pathname?: string } }; subscribe?: (fn: (s: { location: { pathname: string } }) => void) => () => void } | undefined;
    let auth = AUTH_PATHS.test(r?.state?.location?.pathname ?? window.location.pathname);
    const unsub = r?.subscribe?.((s) => { const next = AUTH_PATHS.test(s.location.pathname); if (next !== auth) { auth = next; layout(); } });

    let W = 0, H = 0, cx = 0, cy = 0, R = 0;
    let shapes: Pt[][] = [];
    let specks: Speck[] = [];
    let scene = -1, clock = 0, idle = 0, glow = 0, ring = 0;
    let raf = 0, last = performance.now();

    const sample = (draw: (o: CanvasRenderingContext2D) => void, step: number): Pt[] => {
      // A hidden or minimised window reports 0×0, and getImageData throws on a 0-size canvas.
      // No shapes then; the next resize lays them out. The background must never take the page down.
      if (W < 1 || H < 1) return [];
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const o = c.getContext('2d'); if (!o) return [];
      o.strokeStyle = '#000'; o.lineJoin = 'round'; draw(o);
      const d = o.getImageData(0, 0, W, H).data; const out: Pt[] = [];
      for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) if (d[(y * W + x) * 4 + 3] > 128) out.push([x, y]);
      for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
      return out;
    };

    function layout() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = window.innerWidth; H = window.innerHeight;
      canvas!.width = Math.round(W * dpr); canvas!.height = Math.round(H * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const wide = W >= 1024;
      // sign-in: beside the card on wide screens; app: centre of the content area (right of the sidebar)
      cx = auth ? (wide ? W * 0.8 : W / 2) : (wide ? 230 + (W - 230) / 2 : W / 2);
      cy = auth ? H * 0.52 : H * 0.55;
      R = Math.max(52, Math.min(W, H) * (auth ? 0.12 : 0.15));
      const step = W < 768 ? 4 : 3;
      const fileS = (o: CanvasRenderingContext2D) => {
        const w = R * 1.2, h = R * 1.65, x = cx - w / 2, y = cy - h / 2, f = R * 0.36;
        o.lineWidth = Math.max(5, R * 0.09);
        o.beginPath(); o.moveTo(x, y); o.lineTo(x + w - f, y); o.lineTo(x + w, y + f); o.lineTo(x + w, y + h); o.lineTo(x, y + h); o.closePath(); o.stroke();
        o.beginPath(); o.moveTo(x + w - f, y); o.lineTo(x + w - f, y + f); o.lineTo(x + w, y + f); o.stroke();
        o.lineWidth = Math.max(4, R * 0.065);
        for (let k = 0; k < 3; k++) { o.beginPath(); o.moveTo(x + w * 0.2, y + h * (0.45 + k * 0.17)); o.lineTo(x + w * (k === 2 ? 0.55 : 0.8), y + h * (0.45 + k * 0.17)); o.stroke(); }
      };
      const emblemS = (o: CanvasRenderingContext2D) => {
        o.lineWidth = Math.max(2.5, R * 0.035);
        for (let j = 0; j < 5; j++) { o.beginPath(); for (let q = 0; q <= 360; q += 2) { const t = (q * Math.PI) / 180; const rr = R * (0.44 + j * 0.13) + R * 0.09 * Math.cos(7 * t + j * 0.8); const px = cx + rr * Math.cos(t), py = cy + rr * Math.sin(t); if (q) o.lineTo(px, py); else o.moveTo(px, py); } o.stroke(); }
      };
      const markS = (o: CanvasRenderingContext2D) => {
        o.lineWidth = Math.max(7, R * 0.14); o.beginPath(); o.arc(cx, cy, R, 0, Math.PI * 2); o.stroke();
        o.lineWidth = Math.max(6, R * 0.12); o.beginPath(); o.arc(cx, cy, R * 0.62, Math.PI * 0.62, Math.PI * 2.38); o.stroke();
        o.beginPath(); o.moveTo(cx - R * 0.16, cy + R * 0.62); o.lineTo(cx - R * 0.16, cy - R * 0.05); o.stroke();
        o.beginPath(); o.arc(cx + R * 0.06, cy - R * 0.05, R * 0.22, Math.PI, Math.PI * 3); o.stroke();
      };
      shapes = [sample(fileS, step), sample(emblemS, step), sample(markS, step)];
      const want = Math.round(Math.min(W < 768 ? 180 : 460, (W * H) / 2600));
      const n = Math.min(want, ...shapes.map((s) => s.length));
      if (specks.length !== n) {
        specks = Array.from({ length: n }, (_, i) => ({ x: Math.random() * W, y: Math.random() * H, vx: 0, vy: 0, c: i % LIGHT.length, s: 0.7 + Math.random() * 1.5, ph: Math.random() * 6.28, tx: 0, ty: 0 }));
      }
      if (scene >= 0 && scene < 3) setScene(scene);
    }

    function setScene(i: number) {
      scene = i; clock = 0;
      if (i < 3) specks.forEach((p, k) => { const t = shapes[i]?.[k % (shapes[i]?.length || 1)]; if (t) { p.tx = t[0]; p.ty = t[1]; } });
      else { ring = 0; specks.forEach((p) => { const a = Math.atan2(p.y - cy, p.x - cx) + (Math.random() - 0.5) * 0.4; const v = 1.2 + Math.random() * 2.4; p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v; }); }
    }
    const play = () => { if (scene < 0) { idle = 0; setScene(0); } };
    window.addEventListener('pinit:story', play);

    function draw(now: number) {
      const dt = Math.min(40, now - last); last = now;
      const dark = document.documentElement.classList.contains('dark');
      ctx!.clearRect(0, 0, W, H);
      if (scene < 0) { idle += dt; if (idle > (auth ? 4500 : 26000)) play(); }
      else { clock += dt; if (clock > STORY[scene].dur) { if (scene < STORY.length - 1) setScene(scene + 1); else { scene = -1; } } }
      const forming = scene >= 0 && scene < 3, isMark = scene === 2, leaving = scene === 3;
      const strength = auth ? 1 : 0.75;
      glow += ((isMark && clock > 900 ? 1 : 0) - glow) * 0.05;
      if (glow > 0.02) {
        const g = ctx!.createRadialGradient(cx, cy, 0, cx, cy, R * 1.8);
        g.addColorStop(0, isArctic() ? (dark ? `rgba(232,239,243,${0.30 * glow * strength})` : `rgba(46,79,107,${0.18 * glow * strength})`) : isNavy() ? (dark ? `rgba(84,214,229,${0.32 * glow * strength})` : `rgba(57,127,234,${0.20 * glow * strength})`) : dark ? `rgba(244,172,130,${0.36 * glow * strength})` : `rgba(240,162,116,${0.26 * glow * strength})`);
        g.addColorStop(1, 'rgba(240,162,116,0)');
        ctx!.fillStyle = g; ctx!.fillRect(cx - R * 2, cy - R * 2, R * 4, R * 4);
      }
      if (leaving) {
        ring += dt * 0.11;
        const fade = Math.max(0, 1 - ring / (R * 3));
        ctx!.save(); ctx!.strokeStyle = isArctic() ? (dark ? '#E8EFF3' : '#2E4F6B') : isNavy() ? (dark ? '#A9CBFF' : '#2E6FD9') : dark ? '#F6C9A8' : '#B8643A'; ctx!.lineWidth = 1.3;
        ctx!.globalAlpha = 0.7 * fade * strength; ctx!.beginPath(); ctx!.arc(cx, cy, R + ring, 0, Math.PI * 2); ctx!.stroke();
        ctx!.globalAlpha = 0.35 * fade * strength; ctx!.beginPath(); ctx!.arc(cx, cy, R + ring * 0.6, 0, Math.PI * 2); ctx!.stroke(); ctx!.restore();
      }
      const palette = isArctic() ? (dark ? ARCTIC_DARK : ARCTIC_LIGHT) : isNavy() ? (dark ? NAVY_DARK : NAVY_LIGHT) : dark ? DARK : LIGHT;
      ctx!.save(); if (dark) ctx!.globalCompositeOperation = 'lighter';
      for (const p of specks) {
        if (forming) { p.x += (p.tx - p.x) * 0.055; p.y += (p.ty - p.y) * 0.055; }
        else {
          if (!leaving) { p.ph += 0.01; p.vx += Math.cos(p.ph) * 0.02; p.vy += Math.sin(p.ph * 1.3) * 0.02; }
          p.vx *= leaving ? 0.985 : 0.97; p.vy *= leaving ? 0.985 : 0.97;
          p.x += p.vx + (leaving ? 0 : 0.08); p.y += p.vy - (leaving ? 0 : 0.05);
          if (p.x > W + 5) p.x = -5; if (p.x < -5) p.x = W + 5; if (p.y < -5) p.y = H + 5; if (p.y > H + 5) p.y = -5;
        }
        const tw = isMark ? 0.75 + 0.25 * Math.sin(now * 0.01 + p.ph * 5) : 0.5 + 0.35 * Math.sin(now * 0.002 + p.ph);
        ctx!.globalAlpha = tw * (dark ? 0.95 : 0.75) * strength;
        ctx!.fillStyle = palette[p.c]; ctx!.beginPath(); ctx!.arc(p.x, p.y, p.s, 0, Math.PI * 2); ctx!.fill();
      }
      ctx!.restore();
      raf = requestAnimationFrame(draw);
    }

    function still() {
      // reduced motion: one quiet frame, the light resting as the mark
      const dark = document.documentElement.classList.contains('dark');
      ctx!.clearRect(0, 0, W, H);
      const pal = isArctic() ? (dark ? ARCTIC_DARK : ARCTIC_LIGHT) : isNavy() ? (dark ? NAVY_DARK : NAVY_LIGHT) : dark ? DARK : LIGHT;
      ctx!.save(); if (dark) ctx!.globalCompositeOperation = 'lighter';
      specks.forEach((p, k) => { const t = shapes[2][k % shapes[2].length]; ctx!.globalAlpha = dark ? 0.7 : 0.5; ctx!.fillStyle = pal[p.c]; ctx!.beginPath(); ctx!.arc(t[0], t[1], p.s, 0, Math.PI * 2); ctx!.fill(); });
      ctx!.restore();
    }

    layout();
    let resizeT = 0;
    const onResize = () => { window.clearTimeout(resizeT); resizeT = window.setTimeout(() => { layout(); if (reduce) still(); }, 200); };
    const onVis = () => { if (document.hidden) cancelAnimationFrame(raf); else if (!reduce) { last = performance.now(); raf = requestAnimationFrame(draw); } };
    const themeObs = new MutationObserver(() => { if (reduce) still(); });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    if (reduce) still(); else raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf); window.clearTimeout(resizeT); themeObs.disconnect(); unsub?.();
      window.removeEventListener('resize', onResize); window.removeEventListener('pinit:story', play);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [router]);

  return <canvas ref={ref} className="brand-story" aria-hidden="true" />;
}
