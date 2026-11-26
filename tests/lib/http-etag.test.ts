import { describe, test, expect } from '@jest/globals';
import { etagMatches, portfolioMediaEtag, vaultPreviewEtag } from '../../src/lib/http-etag';

describe('etagMatches', () => {
  const tag = 'W/"pm-v1-5555-960"';
  test.each([
    [tag, true],
    ['"pm-v1-5555-960"', true], // the browser may send it without the weak prefix
    ['W/"other", W/"pm-v1-5555-960"', true],
    ['*', true],
    ['W/"pm-v1-9999-960"', false],
    ['', false],
    [undefined, false],
  ])('If-None-Match %s -> %s', (header, expected) => expect(etagMatches(header as string | undefined, tag)).toBe(expected));

  test('a list sent as an array of headers is read too', () => {
    expect(etagMatches(['W/"a"', tag], tag)).toBe(true);
  });
});

describe('names', () => {
  test('a preview is named from its id and stored size, and the size or kind changes the name', () => {
    expect(vaultPreviewEtag('v1', 100, true)).toBe('W/"vp-v1-100-t"');
    expect(vaultPreviewEtag('v1', 100, false)).toBe('W/"vp-v1-100-f"');
    expect(vaultPreviewEtag('v1', 101, true)).not.toBe(vaultPreviewEtag('v1', 100, true));
    expect(portfolioMediaEtag('v1', '5555')).toBe('W/"pm-v1-5555-960"');
  });
});
