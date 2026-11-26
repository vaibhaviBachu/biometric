/**
 * What the PINIT camera sends with a Pin It upload: only known, bounded fields are kept, and the Work report reads them back.
 */
import { describe, test, expect } from '@jest/globals';
import { sanitizeCaptureDetails } from '../src/lib/capture-details';
import { readPinitProtect } from '../src/services/intelligence/original-capture-exif';
import { describePinningDevice } from '../src/lib/user-agent';

const good = {
  shutterAt: '2026-11-03T03:57:58.000Z',
  timezone: 'Asia/Kolkata',
  facing: 'back',
  mode: 'photo',
  flash: false,
  filter: 'Original',
  orientation: 'portrait',
  resolution: { width: 480, height: 640 },
  location: { latitude: 17.440123, longitude: 78.348912, accuracy: 12, fixedAt: '2026-11-03T03:57:57.000Z' },
};

describe('sanitizeCaptureDetails', () => {
  test('keeps a complete set of details, from a JSON string or an object', () => {
    const fromString = sanitizeCaptureDetails(JSON.stringify(good));
    expect(fromString).toEqual({ ...good, resolution: { width: 480, height: 640 } });
    expect(sanitizeCaptureDetails(good)).toEqual(fromString);
  });

  test('drops unknown keys and keeps nothing it cannot check', () => {
    const out = sanitizeCaptureDetails({ ...good, isAdmin: true, __proto__: { x: 1 }, location: { latitude: 'x', longitude: 5 } });
    expect(out).not.toHaveProperty('isAdmin');
    expect(out).not.toHaveProperty('location');
    expect(out?.shutterAt).toBe(good.shutterAt);
  });

  test('rejects coordinates outside the globe and absurd numbers', () => {
    const out = sanitizeCaptureDetails({ location: { latitude: 120, longitude: 10 }, zoom: -4, iso: 1e12, resolution: { width: 0, height: 5 } });
    expect(out).toBeUndefined();
  });

  test('a bad or oversized payload is ignored, never thrown', () => {
    expect(sanitizeCaptureDetails('not json')).toBeUndefined();
    expect(sanitizeCaptureDetails('x'.repeat(5000))).toBeUndefined();
    expect(sanitizeCaptureDetails(undefined)).toBeUndefined();
    expect(sanitizeCaptureDetails([1, 2])).toBeUndefined();
  });

  test('long strings are cut short', () => {
    const out = sanitizeCaptureDetails({ mode: 'm'.repeat(500), filter: 'f'.repeat(500) });
    expect(String(out?.mode).length).toBeLessThanOrEqual(24);
    expect(String(out?.filter).length).toBeLessThanOrEqual(24);
  });
});

describe('readPinitProtect', () => {
  test('reads back the capture time, device, receive time, network place and shutter details', () => {
    const snap = readPinitProtect({
      pinitProtect: {
        timezone: 'Asia/Kolkata',
        captureMethod: 'PinIT Camera',
        capturedAt: good.shutterAt,
        deviceModel: 'Android phone',
        software: 'PinIT Camera',
        receivedAt: '2026-11-03T03:58:25.000Z',
        networkCountry: 'IN',
        details: good,
        gpsLatitude: 17.44021,
        gpsLongitude: 78.349005,
        gpsAccuracy: 9,
      },
    });
    expect(snap?.capturedAt).toBe(good.shutterAt);
    expect(snap?.deviceModel).toBe('Android phone');
    expect(snap?.receivedAt).toBe('2026-11-03T03:58:25.000Z');
    expect(snap?.networkCountry).toBe('IN');
    expect((snap?.details as { location?: { accuracy?: number } })?.location?.accuracy).toBe(12);
  });

  test('a file pinned before this existed reads back with the new fields empty', () => {
    const snap = readPinitProtect({ pinitProtect: { timezone: 'Asia/Kolkata', captureMethod: 'Upload' } });
    expect(snap?.capturedAt).toBeNull();
    expect(snap?.details).toBeNull();
  });
});

describe('describePinningDevice', () => {
  const ua = {
    androidChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  };

  test('tells a phone, a tablet and a computer apart', () => {
    expect(describePinningDevice(ua.androidChrome)).toEqual({ deviceType: 'Mobile phone', os: 'Android', browser: 'Chrome' });
    expect(describePinningDevice(ua.iphone)).toEqual({ deviceType: 'Mobile phone', os: 'iOS', browser: 'Safari' });
    expect(describePinningDevice(ua.windowsEdge)).toEqual({ deviceType: 'Computer', os: 'Windows', browser: 'Edge' });
    expect(describePinningDevice(ua.ipad)?.deviceType).toBe('Tablet');
    expect(describePinningDevice(ua.androidTablet)?.deviceType).toBe('Tablet');
  });

  test('nothing to describe when there is no user agent', () => {
    expect(describePinningDevice(undefined)).toBeNull();
    expect(describePinningDevice('   ')).toBeNull();
  });
});
