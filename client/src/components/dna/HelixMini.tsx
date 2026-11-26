import { useId } from 'react';
import { cn } from '../ui/utils';

interface HelixMiniProps {
  className?: string;
  /** Gentle 6s float. Stops automatically under reduced motion (global rule in theme.css). */
  float?: boolean;
}

const PAIRS = 9;

/** Small cobalt-and-silver double helix — the DNA signature for empty and loading states. Decorative. */
export function HelixMini({ className, float = true }: HelixMiniProps) {
  const id = useId().replace(/:/g, '');
  const w = 56;
  const h = 96;
  const pairs = Array.from({ length: PAIRS }, (_, i) => {
    const t = (i / (PAIRS - 1)) * Math.PI * 2;
    const y = 8 + (i / (PAIRS - 1)) * (h - 16);
    const a = w / 2 + Math.sin(t) * 18;
    const b = w / 2 - Math.sin(t) * 18;
    return { y, a, b, front: Math.cos(t) > 0 };
  });
  // Strands are sampled finely so they curve smoothly; base pairs stay at PAIRS rungs.
  const strand = (sign: 1 | -1) =>
    Array.from({ length: 49 }, (_, i) => {
      const f = i / 48;
      const x = w / 2 + sign * Math.sin(f * Math.PI * 2) * 18;
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${(8 + f * (h - 16)).toFixed(1)}`;
    }).join(' ');

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={cn('w-14 h-24', float && 'animate-float', className)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`hx-a-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.5" stopColor="#84A5F9" />
          <stop offset="1" stopColor="#11389B" />
        </linearGradient>
        <linearGradient id={`hx-b-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2C65F4" />
          <stop offset="1" stopColor="#DEDFE2" />
        </linearGradient>
      </defs>
      {pairs.map((p, i) => (
        <line key={i} x1={p.a} y1={p.y} x2={p.b} y2={p.y} stroke="#44464D" strokeWidth="2" strokeLinecap="round" opacity={p.front ? 1 : 0.55} />
      ))}
      <path d={strand(1)} fill="none" stroke={`url(#hx-a-${id})`} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d={strand(-1)} fill="none" stroke={`url(#hx-b-${id})`} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      {pairs.map((p, i) => (
        <g key={`n${i}`}>
          <circle cx={p.a} cy={p.y} r="2.6" fill="#131416" stroke="#84A5F9" strokeWidth="1.2" />
          <circle cx={p.b} cy={p.y} r="2.6" fill="#131416" stroke="#DEDFE2" strokeWidth="1.2" />
        </g>
      ))}
    </svg>
  );
}
