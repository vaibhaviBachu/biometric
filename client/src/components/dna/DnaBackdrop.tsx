/*
  The backdrop the glass floats over: a fixed, non-interactive layer behind every page.
  Light: soft grey and blue light drifting slowly, with a faint DNA helix on the right.
  Dark: lighter grey smoke drifting behind the floating window.
  Styled in styles/floating-glass.css (on top of .dna-backdrop in styles/theme.css). Each theme hides the other's layers.
  The component keeps its name and place in main.tsx so the app shell is unchanged.
*/

import { BrandStory } from './BrandStory';

// DNA helix drawn once at module load: two strands, rungs between them, nodes on the strands
const W = 300;
const H = 1200;
const A = 90;
const CX = 150;
const TURNS = 3;
const phase = (y: number) => (y / H) * 2 * Math.PI * TURNS;

function strand(offset: number) {
  const pts: string[] = [];
  for (let y = 0; y <= H; y += 20) pts.push(`${(CX + A * Math.sin(phase(y) + offset)).toFixed(1)},${y}`);
  return `M${pts.join(' L')}`;
}

const STRAND_A = strand(0);
const STRAND_B = strand(Math.PI);
const RUNGS = Array.from({ length: Math.floor((H - 20) / 50) + 1 }, (_, i) => {
  const y = 20 + i * 50;
  const t = phase(y);
  const depth = Math.abs(Math.cos(t));
  return { y, x1: CX + A * Math.sin(t), x2: CX + A * Math.sin(t + Math.PI), depth, key: i % 3 === 0 };
});

export function DnaBackdrop({ router }: { router?: unknown }) {
  return (
    <div className="dna-backdrop" aria-hidden="true">
      <BrandStory router={router} />
      <div className="fg-orbs">
        <i className="o1" /><i className="o2" /><i className="o3" /><i className="o4" /><i className="o5" />
      </div>
      <svg className="fg-helix" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        <g fill="none" strokeLinecap="round">
          <path d={STRAND_A} stroke="var(--muted)" strokeWidth="2.2" />
          <path d={STRAND_B} stroke="var(--blue)" strokeOpacity="0.55" strokeWidth="2.2" />
        </g>
        <g stroke="var(--faint)" strokeWidth="1.6">
          {RUNGS.map((r) => (
            <line key={r.y} x1={r.x1.toFixed(1)} y1={r.y} x2={r.x2.toFixed(1)} y2={r.y} strokeOpacity={(0.25 + 0.5 * r.depth).toFixed(2)} />
          ))}
        </g>
        <g>
          {RUNGS.map((r) => (
            <g key={r.y}>
              <circle cx={r.x1.toFixed(1)} cy={r.y} r={(3 + 2 * r.depth).toFixed(1)} fill={r.key ? 'var(--blue)' : 'var(--muted)'} />
              <circle cx={r.x2.toFixed(1)} cy={r.y} r={(3 + 2 * r.depth).toFixed(1)} fill="var(--faint)" />
            </g>
          ))}
        </g>
      </svg>
      <div className="fg-smoke">
        <i className="w w1" /><i className="w w2" /><i className="w w3" /><i className="grain" />
      </div>
    </div>
  );
}
