/**
 * Where an investigator says they found the copy they are checking.
 *
 * Everything here is told to us by the person running the check. PINIT Hub does not verify it, so it is stored and
 * printed as "user-provided, not verified" and never mixed with what the system measured. All of it is optional.
 */

export interface DiscoveryInfo {
  provenance: 'USER_PROVIDED';
  verified: false;
  /** When the investigator entered it (set by the server, not the client). */
  providedAt: string;
  /** Free text: where the copy was found ("Instagram profile of…", "a printed flyer", …). */
  foundWhere?: string;
  platform?: string;
  /** http(s) only. */
  sourceUrl?: string;
  /** ISO date the investigator first saw the copy. */
  firstObservedAt?: string;
  notes?: string;
}

const LIMITS = { foundWhere: 200, platform: 80, sourceUrl: 500, notes: 1000 } as const;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(CONTROL, '').trim().slice(0, max);
  return s || undefined;
}

function cleanUrl(v: unknown): string | undefined {
  const s = clean(v, LIMITS.sourceUrl);
  if (!s) return undefined;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cleanDate(v: unknown, now: Date): string | undefined {
  const s = clean(v, 40);
  if (!s) return undefined;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return undefined;
  // Not in the future (a day of slack for time zones) and not before the web existed.
  if (t > now.getTime() + 24 * 3600 * 1000 || t < Date.UTC(1990, 0, 1)) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(t).toISOString();
}

/** Accepts the JSON string from a multipart field, or an object from a JSON body. Returns undefined when nothing usable was given. */
export function parseDiscoveryInfo(raw: unknown, now: Date = new Date()): DiscoveryInfo | undefined {
  let src: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > 4000) return undefined;
    try { src = JSON.parse(raw); } catch { return undefined; }
  }
  if (!src || typeof src !== 'object') return undefined;
  const o = src as Record<string, unknown>;
  const out = {
    foundWhere: clean(o['foundWhere'], LIMITS.foundWhere),
    platform: clean(o['platform'], LIMITS.platform),
    sourceUrl: cleanUrl(o['sourceUrl']),
    firstObservedAt: cleanDate(o['firstObservedAt'], now),
    notes: clean(o['notes'], LIMITS.notes),
  };
  if (!Object.values(out).some(Boolean)) return undefined;
  return {
    provenance: 'USER_PROVIDED',
    verified: false,
    providedAt: now.toISOString(),
    ...Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)),
  };
}
