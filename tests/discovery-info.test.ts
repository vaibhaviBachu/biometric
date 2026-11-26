/** The optional "where did you find it" details: sanitised, never verified, never required. */
import { describe, test, expect } from '@jest/globals';
import { parseDiscoveryInfo } from '../src/lib/discovery-info';

const NOW = new Date('2026-11-04T10:00:00.000Z');

describe('parseDiscoveryInfo', () => {
  test('nothing given means nothing stored', () => {
    expect(parseDiscoveryInfo(undefined, NOW)).toBeUndefined();
    expect(parseDiscoveryInfo('', NOW)).toBeUndefined();
    expect(parseDiscoveryInfo('{}', NOW)).toBeUndefined();
    expect(parseDiscoveryInfo({ platform: '   ', notes: '' }, NOW)).toBeUndefined();
    expect(parseDiscoveryInfo('not json', NOW)).toBeUndefined();
  });

  test('a filled form is marked user-provided and unverified, with a server timestamp', () => {
    const d = parseDiscoveryInfo(JSON.stringify({
      foundWhere: 'Profile page of a travel blog', platform: 'Instagram', sourceUrl: 'https://example.com/p/abc',
      firstObservedAt: '2026-10-30', notes: 'Seen via a friend',
      providedAt: '1999-01-01T00:00:00Z', verified: true, provenance: 'SYSTEM_VERIFIED',
    }), NOW);
    expect(d).toEqual({
      provenance: 'USER_PROVIDED', verified: false, providedAt: NOW.toISOString(),
      foundWhere: 'Profile page of a travel blog', platform: 'Instagram', sourceUrl: 'https://example.com/p/abc',
      firstObservedAt: '2026-10-30', notes: 'Seen via a friend',
    });
  });

  test('every field is optional: one field alone is kept', () => {
    expect(parseDiscoveryInfo({ platform: 'Facebook' }, NOW)).toMatchObject({ platform: 'Facebook', verified: false });
  });

  test('only web addresses are accepted as a source URL', () => {
    expect(parseDiscoveryInfo({ sourceUrl: 'javascript:alert(1)', platform: 'x' }, NOW)?.sourceUrl).toBeUndefined();
    expect(parseDiscoveryInfo({ sourceUrl: 'file:///etc/passwd', platform: 'x' }, NOW)?.sourceUrl).toBeUndefined();
    expect(parseDiscoveryInfo({ sourceUrl: 'example.com/page' }, NOW)?.sourceUrl).toBe('https://example.com/page');
    expect(parseDiscoveryInfo({ sourceUrl: 'nonsense ::: ' , platform: 'x' }, NOW)?.sourceUrl).toBeUndefined();
  });

  test('a date in the future or before the web existed is dropped, not stored', () => {
    expect(parseDiscoveryInfo({ firstObservedAt: '2027-05-01', platform: 'x' }, NOW)?.firstObservedAt).toBeUndefined();
    expect(parseDiscoveryInfo({ firstObservedAt: '1980-01-01', platform: 'x' }, NOW)?.firstObservedAt).toBeUndefined();
    expect(parseDiscoveryInfo({ firstObservedAt: 'last tuesday', platform: 'x' }, NOW)?.firstObservedAt).toBeUndefined();
    expect(parseDiscoveryInfo({ firstObservedAt: '2026-11-04T08:30:00Z' }, NOW)?.firstObservedAt).toBe('2026-11-04T08:30:00.000Z');
  });

  test('text is trimmed, stripped of control characters and length-limited', () => {
    const d = parseDiscoveryInfo({ notes: `  a\u0000b\u0007c ${'x'.repeat(2000)}`, platform: 'P'.repeat(300) }, NOW);
    expect(d?.notes?.startsWith('abc ')).toBe(true);
    expect(d?.notes?.length).toBe(1000);
    expect(d?.platform?.length).toBe(80);
  });

  test('an oversized payload is refused outright', () => {
    expect(parseDiscoveryInfo('{"notes":"' + 'a'.repeat(5000) + '"}', NOW)).toBeUndefined();
  });
});
