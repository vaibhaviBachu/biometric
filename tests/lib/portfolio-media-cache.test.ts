/** Cache headers for portfolio pictures: strict by default, and never a stale window, however it is configured. */
import { describe, test, expect } from '@jest/globals';
import {
  portfolioMediaCacheControl,
  portfolioMediaMaxAgeSeconds,
  OWNER_PREVIEW_CACHE_CONTROL,
  PORTFOLIO_MEDIA_MAX_AGE_CEILING_S,
  PORTFOLIO_MEDIA_MAX_AGE_ENV,
} from '../../src/lib/portfolio-media-cache';

const env = (v?: string): NodeJS.ProcessEnv => (v === undefined ? {} : { [PORTFOLIO_MEDIA_MAX_AGE_ENV]: v });

describe('portfolioMediaCacheControl', () => {
  test('by default a published picture may be kept but must be revalidated before every use', () => {
    expect(portfolioMediaCacheControl(false, env())).toBe('public, no-cache');
  });

  test('the owner\'s preview is private and never stored, whatever is configured', () => {
    expect(portfolioMediaCacheControl(true, env())).toBe(OWNER_PREVIEW_CACHE_CONTROL);
    expect(portfolioMediaCacheControl(true, env('60'))).toBe('private, no-store');
    expect(portfolioMediaCacheControl(true, env('99999'))).toBe('private, no-store');
    expect(OWNER_PREVIEW_CACHE_CONTROL).not.toMatch(/public/);
  });

  test('a short reuse window can be configured, and still has to be revalidated once it ends', () => {
    expect(portfolioMediaCacheControl(false, env('60'))).toBe('public, max-age=60, must-revalidate');
  });

  test('the window is capped, so a hidden picture can never stay visible for long', () => {
    expect(portfolioMediaMaxAgeSeconds(env('99999'))).toBe(PORTFOLIO_MEDIA_MAX_AGE_CEILING_S);
    expect(portfolioMediaCacheControl(false, env('99999'))).toBe(`public, max-age=${PORTFOLIO_MEDIA_MAX_AGE_CEILING_S}, must-revalidate`);
    expect(PORTFOLIO_MEDIA_MAX_AGE_CEILING_S).toBeLessThanOrEqual(120);
  });

  test.each(['', '0', '-5', 'abc', 'NaN', 'Infinity', '  '])('"%s" falls back to the strict default', (value) => {
    expect(portfolioMediaMaxAgeSeconds(env(value))).toBe(0);
    expect(portfolioMediaCacheControl(false, env(value))).toBe('public, no-cache');
  });

  test('fractions are rounded down', () => {
    expect(portfolioMediaMaxAgeSeconds(env('59.9'))).toBe(59);
  });

  test('no configuration can ever produce a stale window', () => {
    for (const value of [undefined, '', '0', '30', '120', '99999', 'abc']) {
      for (const preview of [true, false]) {
        const header = portfolioMediaCacheControl(preview, env(value));
        expect(header).not.toMatch(/stale-while-revalidate|stale-if-error/);
      }
    }
  });
});
