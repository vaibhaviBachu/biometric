/** Trace lists every download of the link a copy was traced to, with how precisely each place is known. */
import { describe, test, expect } from '@jest/globals';
import { downloadsOf } from '../../client/src/components/trace/model';

const path = (token: string | null) => ({ fromShare: true, token, recipient: 'Meera', hops: [] });
const report = (rows: unknown[]) => ({ accessIntelligence: rows }) as never;

const approx = { action: 'DOWNLOADED', timestamp: '2026-11-06T08:02:10.000Z', device: 'desktop', os: 'Windows', browser: 'Edge', city: 'Hyderabad', region: 'Telangana', country: 'India', ipAddress: '203.0.113.5', locationSource: 'ip', shareToken: 'tokA' };
const exact = { ...approx, timestamp: '2026-11-06T08:05:00.000Z', locationSource: 'gps', gpsLat: 17.44012, gpsLng: 78.34891, gpsAccuracyM: 18, address: 'Gachibowli, Hyderabad 500032', city: 'Gachibowli' };

describe('downloadsOf', () => {
  test('an approximate place says so and has no coordinates or map', () => {
    const [d] = downloadsOf(report([approx]), path('tokA'));
    expect(d.precision).toBe('approximate');
    expect(d.place).toBe('Hyderabad, Telangana, India');
    expect(d.who).toBe('desktop · Windows · Edge');
    expect(d.coords).toBeNull();
    expect(d.mapUrl).toBeNull();
    expect(d.ip).toBe('203.0.113.5');
  });

  test('a shared device location is exact, with coordinates, accuracy, address and a map link', () => {
    const [d] = downloadsOf(report([exact]), path('tokA'));
    expect(d.precision).toBe('precise');
    expect(d.coords).toEqual({ lat: 17.44012, lng: 78.34891, accuracyM: 18 });
    expect(d.address).toContain('500032');
    expect(d.mapUrl).toBe('https://www.google.com/maps?q=17.440120,78.348910');
  });

  test('only the link the copy was traced to is listed, oldest first', () => {
    const other = { ...approx, shareToken: 'tokB', timestamp: '2026-11-06T07:00:00.000Z' };
    const list = downloadsOf(report([exact, other, approx]), path('tokA'));
    expect(list.map((d) => d.at)).toEqual([approx.timestamp, exact.timestamp]);
  });

  test('with no matching link recorded, the downloads on record are listed', () => {
    expect(downloadsOf(report([approx]), path(null))).toHaveLength(1);
    expect(downloadsOf(report([approx]), path('unknownToken'))).toHaveLength(1);
  });

  test('each download carries the link it was made through and who that link was made for', () => {
    const [d] = downloadsOf(report([{ ...approx, linkLabel: 'vaibee · Friend' }]), path(null));
    expect(d.linkToken).toBe('tokA');
    expect(d.linkLabel).toBe('vaibee · Friend');
    const [none] = downloadsOf(report([{ ...approx, shareToken: undefined }]), path(null));
    expect(none.linkToken).toBeNull();
    expect(none.linkLabel).toBeNull();
  });

  test('opens, protected exports and entries without a time are not downloads', () => {
    const rows = [
      { ...approx, action: 'VIEWED' },
      { ...approx, action: 'TEP_EXPORT' },
      { ...approx, action: 'PROTECTED_DOWNLOAD' },
      { ...approx, timestamp: undefined },
    ];
    expect(downloadsOf(report(rows), path('tokA'))).toEqual([]);
  });

  test('nothing recorded is said as nothing, and a hidden network is carried through', () => {
    const [d] = downloadsOf(report([{ action: 'DOWNLOADED', timestamp: '2026-11-06T08:00:00Z', hidesLocation: true, country: 'Germany', locationSource: 'ip' }]), path(null));
    expect(d.hidesLocation).toBe(true);
    const [none] = downloadsOf(report([{ action: 'DOWNLOADED', timestamp: '2026-11-06T08:00:00Z', locationSource: 'none' }]), path(null));
    expect(none.precision).toBe('none');
    expect(none.place).toBeNull();
    expect(none.who).toBeNull();
  });
});
