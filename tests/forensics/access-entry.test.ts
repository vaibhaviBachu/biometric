/** A download's place is called precise only when the person shared their device location. */
import { describe, test, expect } from '@jest/globals';
import { accessEntryFromLog } from '../../src/lib/access-entry';

const base = { createdAt: new Date('2026-11-06T08:02:00Z'), action: 'DOWNLOADED', ipAddress: '203.0.113.5', device: 'desktop', browser: 'Edge', os: 'Windows' };

describe('accessEntryFromLog', () => {
  test('a network-address place is approximate and carries no coordinates', () => {
    const e = accessEntryFromLog({ ...base, country: 'India', city: 'Hyderabad', region: 'Telangana', lat: 17.38, lng: 78.48 } as never, 'tok');
    expect(e.locationSource).toBe('ip');
    expect(e.city).toBe('Hyderabad');
    expect(e.gpsLat).toBeUndefined();
    expect(e.gpsLng).toBeUndefined();
    expect(e.address).toBeUndefined();
    expect(e.shareToken).toBe('tok');
  });

  test('a shared device location is precise, with its coordinates, accuracy and address', () => {
    const e = accessEntryFromLog({
      ...base, country: 'India', city: 'Hyderabad', region: 'Telangana', locationShared: true,
      gpsLat: 17.4401, gpsLng: 78.3489, gpsAccuracy: 18.4, gpsCity: 'Gachibowli', gpsState: 'Telangana',
      gpsFullAddress: 'Gachibowli, Hyderabad, Telangana 500032', gpsPincode: '500032',
    } as never);
    expect(e.locationSource).toBe('gps');
    expect(e.gpsLat).toBe(17.4401);
    expect(e.gpsAccuracyM).toBe(18);
    expect(e.city).toBe('Gachibowli');
    expect(e.address).toContain('500032');
    expect(e.pincode).toBe('500032');
  });

  test('"shared" without recorded coordinates is not treated as precise', () => {
    const e = accessEntryFromLog({ ...base, country: 'India', locationShared: true, gpsLat: null, gpsLng: null } as never);
    expect(e.locationSource).toBe('ip');
    expect(e.gpsLat).toBeUndefined();
  });

  test('recorded device coordinates are precise even when the "shared" flag was not saved', () => {
    const e = accessEntryFromLog({ ...base, country: 'India', gpsLat: 18.67786, gpsLng: 77.94885, gpsAccuracy: 480, gpsFullAddress: 'Yedpalle, Nizamabad, Telangana 503235' } as never);
    expect(e.locationSource).toBe('gps');
    expect(e.gpsLat).toBe(18.67786);
    expect(e.address).toContain('Yedpalle');
  });

  test('a position the record says came from the network address or was refused is never precise', () => {
    for (const locationSource of ['ip', 'denied']) {
      const e = accessEntryFromLog({ ...base, country: 'India', locationSource, gpsLat: 17.1, gpsLng: 78.1 } as never);
      expect(e.gpsLat).toBeUndefined();
      expect(e.locationSource).toBe('ip');
    }
  });

  test('no place at all is said plainly, and a hidden network is flagged', () => {
    expect(accessEntryFromLog({ ...base } as never).locationSource).toBe('none');
    expect(accessEntryFromLog({ ...base, country: 'Germany', isVpn: true } as never).hidesLocation).toBe(true);
    expect(accessEntryFromLog({ ...base, country: 'India' } as never).hidesLocation).toBeUndefined();
  });

  test('the link the access was made through is named by its token and by who it was made for', () => {
    const e = accessEntryFromLog({ ...base, country: 'India' } as never, 'tokA', ' vaibee · Friend ');
    expect(e.shareToken).toBe('tokA');
    expect(e.linkLabel).toBe('vaibee · Friend');
    expect(accessEntryFromLog({ ...base } as never, 'tokA').linkLabel).toBeUndefined();
  });

  test('blank text becomes absent, not an empty place', () => {
    const e = accessEntryFromLog({ ...base, country: '  ', city: '', device: null, userAgent: 'Mozilla/5.0' } as never);
    expect(e.country).toBeUndefined();
    expect(e.city).toBeUndefined();
    expect(e.device).toBe('Mozilla/5.0');
  });
});
