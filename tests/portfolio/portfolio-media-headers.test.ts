/**
 * A published portfolio's pictures: allowed to show on the page (another site), served from the stored preview, and answered "not
 * changed" without reading any file.
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

const mockAccess = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockThumb = jest.fn<(...a: unknown[]) => Promise<Buffer | null>>();
const mockRetrieve = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/services/portfolio/portfolio.service', () => ({
  portfolioService: { checkPublicMediaAccess: (...a: unknown[]) => mockAccess(...a) },
}));
jest.mock('../../src/services/portfolio/portfolio-views.service', () => ({
  recordPortfolioView: jest.fn(), portfolioShareSummary: jest.fn(), deleteMyPortfolio: jest.fn(),
}));
jest.mock('../../src/services/vault/vault-thumbnail.service', () => ({
  getVaultThumbnail: (...a: unknown[]) => mockThumb(...a),
}));
jest.mock('../../src/services/vault/vault.service', () => ({
  VaultService: class { retrieve(...a: unknown[]) { return mockRetrieve(...a); } },
}));

import { streamPublicPortfolioMedia } from '../../src/api/controllers/portfolio.controller';
import { AppError } from '../../src/api/middleware/error.middleware';
import { publicMediaGate } from '../../src/services/forensics/forensic-gates';

const ACCESS = { ownerUserId: 'owner-1', vaultId: 'vault-1', ownerPreview: false, version: '5555', mimeType: 'image/jpeg' };
const ETAG = 'W/"pm-vault-1-5555-960"';

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    statusCode: 0,
    sent: undefined as unknown,
    ended: false,
    set: (h: Record<string, string>) => { Object.assign(headers, h); return res; },
    setHeader: (k: string, v: string) => { headers[k] = v; return res; },
    status: (c: number) => { res.statusCode = c; return res; },
    send: (b: unknown) => { res.sent = b; return res; },
    end: () => { res.ended = true; return res; },
  };
  return res;
}
const req = (extra: Record<string, unknown> = {}) =>
  ({ params: { slug: 'a', vaultId: 'vault-1' }, query: {}, headers: {}, ip: '203.0.113.9', ...extra }) as never;

let jpg: Buffer;
beforeEach(async () => {
  mockAccess.mockReset().mockResolvedValue(ACCESS);
  mockThumb.mockReset();
  mockRetrieve.mockReset();
  const sharp = (await import('sharp')).default;
  jpg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#335577' } }).jpeg().toBuffer();
  mockThumb.mockResolvedValue(jpg);
});
afterEach(() => {
  delete process.env['PREVIEW_THUMBNAILS'];
  delete process.env['PREVIEW_ETAG'];
  delete process.env['PUBLIC_MEDIA_SLOTS'];
  delete process.env['PUBLIC_MEDIA_QUEUE'];
});

describe('streamPublicPortfolioMedia', () => {
  test('serves the stored 960 px preview with a cross-origin policy, an ETag and a cache lifetime, without reading the original', async () => {
    const res = fakeRes();
    await streamPublicPortfolioMedia(req(), res as never, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.sent).toBe(jpg);
    expect(res.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['ETag']).toBe(ETAG);
    // A cache may keep it but must ask before each use, so a picture hidden later stops showing at once.
    expect(res.headers['Cache-Control']).toBe('public, no-cache');
    expect(mockThumb).toHaveBeenCalledWith(expect.anything(), 'vault-1', 'owner-1', 'large');
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('a browser that already has it is answered 304 before any file or preview is touched', async () => {
    const res = fakeRes();
    await streamPublicPortfolioMedia(req({ headers: { 'if-none-match': ETAG } }), res as never, jest.fn());
    expect(res.statusCode).toBe(304);
    expect(res.ended).toBe(true);
    expect(res.headers['ETag']).toBe(ETAG);
    expect(res.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    expect(mockThumb).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('with PREVIEW_ETAG=off there is no early 304', async () => {
    process.env['PREVIEW_ETAG'] = 'off';
    const res = fakeRes();
    await streamPublicPortfolioMedia(req({ headers: { 'if-none-match': ETAG } }), res as never, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(mockThumb).toHaveBeenCalled();
  });

  test('anything that is not a plain picture is still "not found", without reading it', async () => {
    for (const mimeType of ['application/pdf', 'image/svg+xml', 'video/mp4', '']) {
      mockAccess.mockResolvedValue({ ...ACCESS, mimeType });
      const next = jest.fn();
      await streamPublicPortfolioMedia(req(), fakeRes() as never, next);
      expect((next.mock.calls[0]![0] as AppError).statusCode).toBe(404);
    }
    expect(mockThumb).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('with PREVIEW_THUMBNAILS=off the original is read and resized as before, with the same headers', async () => {
    process.env['PREVIEW_THUMBNAILS'] = 'off';
    mockRetrieve.mockResolvedValue({ originalBuffer: jpg, originalMimeType: 'image/jpeg' });
    const res = fakeRes();
    await streamPublicPortfolioMedia(req(), res as never, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(mockRetrieve).toHaveBeenCalledWith('vault-1', 'owner-1');
    expect(mockThumb).not.toHaveBeenCalled();
    expect(res.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  test('if the stored preview cannot be made, the original is used', async () => {
    mockThumb.mockRejectedValue(new Error('sharp could not decode'));
    mockRetrieve.mockResolvedValue({ originalBuffer: jpg, originalMimeType: 'image/jpeg' });
    const res = fakeRes();
    await streamPublicPortfolioMedia(req(), res as never, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(mockRetrieve).toHaveBeenCalled();
  });

  test('storage that cannot be reached is a 503, not a second attempt through the same storage', async () => {
    mockThumb.mockRejectedValue(new AppError(503, 'Your file storage is temporarily unreachable.'));
    const next = jest.fn();
    await streamPublicPortfolioMedia(req(), fakeRes() as never, next);
    expect((next.mock.calls[0]![0] as AppError).statusCode).toBe(503);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('a flood is answered "busy" with Retry-After instead of queueing without limit', async () => {
    process.env['PUBLIC_MEDIA_SLOTS'] = '1';
    process.env['PUBLIC_MEDIA_QUEUE'] = '0';
    let release!: () => void;
    mockThumb.mockImplementation(() => new Promise<Buffer>((resolve) => { release = () => resolve(jpg); }));
    const first = streamPublicPortfolioMedia(req(), fakeRes() as never, jest.fn());
    await new Promise((r) => setTimeout(r, 10));
    const res = fakeRes();
    const next = jest.fn();
    await streamPublicPortfolioMedia(req({ ip: '198.51.100.7' }), res as never, next);
    expect((next.mock.calls[0]![0] as AppError).statusCode).toBe(503);
    expect(res.headers['Retry-After']).toMatch(/^\d+$/);
    expect(res.headers['Cache-Control']).toBe('no-store'); // a "busy" answer must not be remembered either
    release();
    await first;
    expect(publicMediaGate.stats().refused).toBeGreaterThan(0);
  });
});

/**
 * F2/F3: a picture that is hidden, unpublished, private or deleted must stop showing at once, in browsers and CDNs as well.
 * The server decides on every request; these tests pin that the cache headers never let a stored copy outlive that decision.
 */
describe('streamPublicPortfolioMedia: caches never keep what is no longer allowed', () => {
  const anyStaleWindow = /stale-while-revalidate|stale-if-error|max-age=\d{3,}/;

  test('a published picture must be revalidated before reuse, and never carries a stale window', async () => {
    const res = fakeRes();
    await streamPublicPortfolioMedia(req(), res as never, jest.fn());
    expect(res.headers['Cache-Control']).toBe('public, no-cache');
    expect(res.headers['Cache-Control']).not.toMatch(anyStaleWindow);
  });

  test('the "not changed" answer carries the same revalidation header', async () => {
    const res = fakeRes();
    await streamPublicPortfolioMedia(req({ headers: { 'if-none-match': ETAG } }), res as never, jest.fn());
    expect(res.statusCode).toBe(304);
    expect(res.headers['Cache-Control']).toBe('public, no-cache');
  });

  test('the owner\'s preview of an unpublished portfolio is private and never stored, on every kind of answer', async () => {
    mockAccess.mockResolvedValue({ ...ACCESS, ownerPreview: true });
    const ok = fakeRes();
    await streamPublicPortfolioMedia(req(), ok as never, jest.fn());
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['Cache-Control']).toBe('private, no-store');
    expect(ok.headers['Cache-Control']).not.toMatch(/public/);

    const notModified = fakeRes();
    await streamPublicPortfolioMedia(req({ headers: { 'if-none-match': ETAG } }), notModified as never, jest.fn());
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers['Cache-Control']).toBe('private, no-store');
  });

  test('the original-way fallback also uses the private header for a preview', async () => {
    process.env['PREVIEW_THUMBNAILS'] = 'off';
    mockAccess.mockResolvedValue({ ...ACCESS, ownerPreview: true });
    mockRetrieve.mockResolvedValue({ originalBuffer: jpg, originalMimeType: 'image/jpeg' });
    const res = fakeRes();
    await streamPublicPortfolioMedia(req(), res as never, jest.fn());
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  test.each([
    ['unpublished or hidden', 'This portfolio is not public'],
    ['moved to a private folder or not on this portfolio', 'Media not found'],
    ['deleted', 'Media not found'],
  ])('a picture that was %s is a 404 even when the browser sends its old ETag, and the 404 is not stored', async (_label, message) => {
    mockAccess.mockRejectedValue(new AppError(404, message));
    const res = fakeRes();
    const next = jest.fn();
    await streamPublicPortfolioMedia(req({ headers: { 'if-none-match': ETAG } }), res as never, next);
    expect((next.mock.calls[0]![0] as AppError).statusCode).toBe(404);
    expect(res.statusCode).not.toBe(304);
    expect(res.ended).toBe(false);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['ETag']).toBeUndefined();
    expect(mockThumb).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('access is checked on every request, including the ones answered "not changed"', async () => {
    await streamPublicPortfolioMedia(req({ headers: { 'if-none-match': ETAG } }), fakeRes() as never, jest.fn());
    await streamPublicPortfolioMedia(req({ headers: { 'if-none-match': ETAG } }), fakeRes() as never, jest.fn());
    expect(mockAccess).toHaveBeenCalledTimes(2);
  });

  test('a picture that is allowed one moment and hidden the next is shown, then refused, on the same ETag', async () => {
    const shown = fakeRes();
    await streamPublicPortfolioMedia(req({ headers: { 'if-none-match': ETAG } }), shown as never, jest.fn());
    expect(shown.statusCode).toBe(304);

    mockAccess.mockRejectedValue(new AppError(404, 'This portfolio is not public'));
    const hidden = fakeRes();
    const next = jest.fn();
    await streamPublicPortfolioMedia(req({ headers: { 'if-none-match': ETAG } }), hidden as never, next);
    expect(hidden.statusCode).not.toBe(304);
    expect((next.mock.calls[0]![0] as AppError).statusCode).toBe(404);
  });

  test('storage that cannot be reached is not stored by a cache either', async () => {
    mockThumb.mockRejectedValue(new AppError(503, 'Your file storage is temporarily unreachable.'));
    const res = fakeRes();
    await streamPublicPortfolioMedia(req(), res as never, jest.fn());
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});
