import { useEffect, useState, ReactNode } from 'react';
import { Check, Loader2, ShieldCheck } from 'lucide-react';

/** Card title block used at the top of most auth steps. */
export function StepHead({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle?: ReactNode }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 18 }}>
      <div
        style={{
          width: 58,
          height: 58,
          margin: '0 auto 14px',
          borderRadius: 17,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(15,79,242,0.12)',
          border: '1px solid rgba(15,79,242,0.28)',
        }}
      >
        {icon}
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>{title}</h1>
      {subtitle && (
        <p className="pa-muted" style={{ fontSize: 14, marginTop: 8, lineHeight: 1.55 }}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

export interface CheckItem {
  label: string;
  done: boolean;
}

/** Animated verification checklist (Identity Creation / Presence screens). */
export function Checklist({ items }: { items: CheckItem[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {items.map((it) => (
        <div key={it.label} className={`pa-check${it.done ? ' on' : ''}`}>
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              background: it.done ? '#5E616B' : 'rgba(93,137,247,0.14)',
              color: it.done ? '#fff' : '#9C9FA7',
              transition: 'background .25s ease',
            }}
          >
            {it.done ? <Check size={13} strokeWidth={3} /> : <Loader2 size={13} className="pa-spin" />}
          </span>
          <span style={{ fontSize: 14, color: it.done ? '#F9F9FA' : '#9C9FA7', fontWeight: 500 }}>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Monospace "system trace" — reveals backend pipeline lines one by one with a
 * subtle check. Calls `onComplete` once every line has been revealed.
 */
export function SystemTrace({
  lines,
  stepMs = 700,
  onComplete,
}: {
  lines: string[];
  stepMs?: number;
  onComplete?: () => void;
}) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= lines.length) {
      onComplete?.();
      return;
    }
    const t = setTimeout(() => setShown((s) => s + 1), stepMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, lines.length]);

  return (
    <div
      className="mono"
      style={{
        marginTop: 16,
        padding: '12px 14px',
        borderRadius: 12,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(93,137,247,0.16)',
        fontSize: 12.5,
        lineHeight: 1.9,
        color: '#A1B8F5',
      }}
    >
      {lines.map((l, i) => (
        <div
          key={l}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            opacity: i < shown ? 1 : 0.45,
            transition: 'opacity .3s ease',
          }}
        >
          {i < shown ? (
            <Check size={12} color="#7C808B" strokeWidth={3} />
          ) : (
            <Loader2 size={12} className="pa-spin" color="#6E717C" />
          )}
          <span style={{ color: i < shown ? '#A5A8B0' : '#6E717C' }}>{l}</span>
        </div>
      ))}
    </div>
  );
}

/** Trust-score badge shown on success screens. */
export function TrustBadge({ score = 99.8 }: { score?: number }) {
  return (
    <div
      className="pa-pop"
      style={{
        margin: '0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        padding: '9px 16px',
        borderRadius: 999,
        background: 'linear-gradient(180deg, rgba(94,97,107,0.14), rgba(94,97,107,0.06))',
        border: '1px solid rgba(94,97,107,0.4)',
      }}
    >
      <ShieldCheck size={17} color="#7C808B" />
      <span style={{ fontSize: 14, fontWeight: 700, color: '#A5A8B0' }}>
        Trust Score: {score.toFixed(1)}%
      </span>
    </div>
  );
}
