/**
 * The capture details a client sends with a Pin It upload (what the camera knew at the shutter).
 * Device-reported, so it is stored as-is but only after every field is checked: known keys only, bounded numbers, short strings.
 */

type Json = Record<string, unknown>;

function str(v: unknown, max = 60): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function num(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

function iso(v: unknown): string | undefined {
  const s = str(v, 40);
  return s && !Number.isNaN(new Date(s).getTime()) ? new Date(s).toISOString() : undefined;
}

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

export function sanitizeCaptureDetails(raw: unknown): Json | undefined {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > 4000) return undefined;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const d = obj(parsed);
  if (!d) return undefined;

  const out: Json = {};
  const shutterAt = iso(d.shutterAt);
  if (shutterAt) out.shutterAt = shutterAt;
  const timezone = str(d.timezone, 64);
  if (timezone) out.timezone = timezone;
  if (d.facing === 'back' || d.facing === 'front') out.facing = d.facing;
  const mode = str(d.mode, 24);
  if (mode) out.mode = mode;
  if (typeof d.flash === 'boolean') out.flash = d.flash;
  const filter = str(d.filter, 24);
  if (filter) out.filter = filter;
  if (d.orientation === 'portrait' || d.orientation === 'landscape') out.orientation = d.orientation;

  const res = obj(d.resolution);
  const w = num(res?.width, 1, 100000);
  const h = num(res?.height, 1, 100000);
  if (w && h) out.resolution = { width: Math.round(w), height: Math.round(h) };

  const zoom = num(d.zoom, 0, 1000);
  if (zoom != null) out.zoom = zoom;
  const frameRate = num(d.frameRate, 0, 1000);
  if (frameRate != null) out.frameRate = frameRate;
  const isoSpeed = num(d.iso, 1, 1000000);
  if (isoSpeed != null) out.iso = isoSpeed;
  const exposureTime = num(d.exposureTime, 0, 100000);
  if (exposureTime != null) out.exposureTime = exposureTime;
  const whiteBalance = str(d.whiteBalance, 24);
  if (whiteBalance) out.whiteBalance = whiteBalance;
  const focusDistance = num(d.focusDistance, 0, 1000000);
  if (focusDistance != null) out.focusDistance = focusDistance;

  const loc = obj(d.location);
  const lat = num(loc?.latitude, -90, 90);
  const lng = num(loc?.longitude, -180, 180);
  if (lat != null && lng != null) {
    const location: Json = { latitude: lat, longitude: lng };
    const accuracy = num(loc?.accuracy, 0, 1_000_000);
    if (accuracy != null) location.accuracy = accuracy;
    const altitude = num(loc?.altitude, -1000, 100000);
    if (altitude != null) location.altitude = altitude;
    const fixedAt = iso(loc?.fixedAt);
    if (fixedAt) location.fixedAt = fixedAt;
    out.location = location;
  }

  return Object.keys(out).length ? out : undefined;
}
