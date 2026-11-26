/**
 * One access to a shared link (an open or a download), as an investigation reports it.
 *
 * Where the person was is only called precise when they chose to share their device location and the coordinates were
 * recorded. Everything else comes from the network address, which is approximate: it places a connection in a city or a
 * country, never at a street or a person. The entry says which of the two it is so a report can say the same.
 */
export type AccessPlaceSource = 'gps' | 'ip' | 'none';

export interface AccessLogLike {
  /** How the position was obtained: 'gps', 'network' (the browser's own positioning), 'ip' or 'denied'. */
  locationSource?: string | null;
  createdAt: Date;
  action: string;
  ipAddress?: string | null;
  country?: string | null;
  city?: string | null;
  region?: string | null;
  device?: string | null;
  userAgent?: string | null;
  browser?: string | null;
  os?: string | null;
  riskLevel?: string | null;
  isp?: string | null;
  isVpn?: boolean | null;
  isProxy?: boolean | null;
  isTor?: boolean | null;
  locationShared?: boolean | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
  gpsAccuracy?: number | null;
  gpsCity?: string | null;
  gpsVillage?: string | null;
  gpsMandal?: string | null;
  gpsDistrict?: string | null;
  gpsState?: string | null;
  gpsPincode?: string | null;
  gpsFullAddress?: string | null;
}

const text = (v: string | null | undefined): string | undefined => {
  const s = (v ?? '').trim();
  return s ? s : undefined;
};
const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export function accessEntryFromLog(log: AccessLogLike, shareToken?: string, linkLabel?: string) {
  // The gps columns are only written for a position the person's own device gave (a link's IP guess goes in lat/lng),
  // so a recorded position is precise unless the record itself says it came from the network address or was refused.
  const sourceSaysNot = ['ip', 'denied'].includes((log.locationSource ?? '').toLowerCase());
  const precise = finite(log.gpsLat) && finite(log.gpsLng) && !sourceSaysNot;
  const source: AccessPlaceSource = precise ? 'gps' : (text(log.country) || text(log.city) ? 'ip' : 'none');
  return {
    timestamp: log.createdAt.toISOString(),
    action: log.action,
    ipAddress: text(log.ipAddress),
    country: text(log.country),
    city: (precise ? text(log.gpsCity) ?? text(log.gpsVillage) ?? text(log.gpsMandal) : undefined) ?? text(log.city),
    region: (precise ? text(log.gpsState) : undefined) ?? text(log.region),
    device: text(log.device) ?? text(log.userAgent),
    browser: text(log.browser),
    os: text(log.os),
    riskLevel: text(log.riskLevel),
    locationShared: Boolean(log.locationShared),
    locationSource: source,
    // Coordinates only when they are the person's own shared location.
    gpsLat: precise ? log.gpsLat! : undefined,
    gpsLng: precise ? log.gpsLng! : undefined,
    gpsAccuracyM: precise && finite(log.gpsAccuracy) ? Math.round(log.gpsAccuracy) : undefined,
    address: precise ? text(log.gpsFullAddress) : undefined,
    district: precise ? text(log.gpsDistrict) : undefined,
    pincode: precise ? text(log.gpsPincode) : undefined,
    isp: text(log.isp),
    hidesLocation: Boolean(log.isVpn || log.isProxy || log.isTor) || undefined,
    shareToken,
    linkLabel: text(linkLabel),
  };
}
