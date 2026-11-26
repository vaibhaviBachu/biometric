/**
 * The preview a chat app shows for a share link: the asset's own thumbnail, but ONLY when the link has no access conditions
 * (a thumbnail is shown to everyone and kept by the chat app, so it would bypass a code, a name, a country, a view limit...).
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import sharp from 'sharp';
import {
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  assetPreviewAllowed,
  clearSharePreviewCache,
  composeAssetPreviewJpeg,
  getSharePreviewImage,
  isLinkPreviewCrawler,
  renderBrandedCardPng,
  renderShareOgHtml,
  type PreviewableLink,
} from '../../src/services/share/share-preview.service';

jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const link = (over: Partial<PreviewableLink> = {}): PreviewableLink => ({
  id: 'link-1', vaultId: 'vault-1', filename: 'holiday.jpg', mimeType: 'image/jpeg', ownerUserId: 'owner-1',
  isActive: true, expiresAt: null, requireOtp: false, requireName: false, oneTimeUse: false, maxViews: null,
  oneDeviceOnly: false, oneIpOnly: false, allowedCountries: [], allowedDeviceTypes: [], allowedIpPrefixes: [],
  corporateIpRanges: [], domainRestrictions: [], intendedDeviceFingerprint: null, intendedIpAddress: null,
  privacyMaskingEnabled: false, firstViewExpiresAfter: null,
  ...over,
});

/** A portrait photo-like picture. */
const photo = () => sharp({ create: { width: 800, height: 1200, channels: 3, background: { r: 200, g: 120, b: 60 } } })
  .composite([{ input: Buffer.from('<svg width="400" height="400"><circle cx="200" cy="200" r="180" fill="#2255aa"/></svg>'), top: 400, left: 200 }])
  .jpeg().toBuffer();

beforeEach(() => clearSharePreviewCache());

describe('isLinkPreviewCrawler', () => {
  test.each([
    'WhatsApp/2.23.20.0 A',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; Twitterbot/1.0)',
    'TelegramBot (like TwitterBot)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  ])('%s is a crawler', (ua) => expect(isLinkPreviewCrawler(ua)).toBe(true));

  test.each([
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    '',
  ])('a real browser is not: %s', (ua) => expect(isLinkPreviewCrawler(ua)).toBe(false));

  test('a missing user agent is not a crawler', () => {
    expect(isLinkPreviewCrawler(undefined)).toBe(false);
    expect(isLinkPreviewCrawler(null)).toBe(false);
  });
});

describe('assetPreviewAllowed', () => {
  test('a plain, active image link may show the asset', () => {
    expect(assetPreviewAllowed(link())).toEqual({ allowed: true });
  });

  test.each<[string, Partial<PreviewableLink>]>([
    ['needs a one-time code', { requireOtp: true }],
    ['one-time link', { oneTimeUse: true }],
    ['limited number of views', { maxViews: 3 }],
    ['one device only', { oneDeviceOnly: true }],
    ['one network only', { oneIpOnly: true }],
    ['country restricted', { allowedCountries: ['IN'] }],
    ['device restricted', { allowedDeviceTypes: ['mobile'] }],
    ['network restricted', { allowedIpPrefixes: ['10.'] }],
    ['corporate network only', { corporateIpRanges: ['10.0.0.0/8'] }],
    ['domain restricted', { domainRestrictions: ['example.com'] }],
    ['bound to a device', { intendedDeviceFingerprint: 'abc' }],
    ['bound to a network', { intendedIpAddress: '1.2.3.4' }],
    ['privacy masking', { privacyMaskingEnabled: true }],
    ['expires after first view', { firstViewExpiresAfter: 60 }],
  ])('%s: the asset is not shown', (reason, over) => {
    expect(assetPreviewAllowed(link(over))).toEqual({ allowed: false, reason });
  });

  test('asking the viewer for a name does not hide the asset: it labels the viewer, it does not restrict them', () => {
    expect(assetPreviewAllowed(link({ requireName: true }))).toEqual({ allowed: true });
  });

  test('an inactive, expired or non-image link is not shown', () => {
    expect(assetPreviewAllowed(link({ isActive: false })).allowed).toBe(false);
    expect(assetPreviewAllowed(link({ expiresAt: new Date(Date.now() - 1000) })).allowed).toBe(false);
    expect(assetPreviewAllowed(link({ expiresAt: new Date(Date.now() + 3_600_000) })).allowed).toBe(true);
    expect(assetPreviewAllowed(link({ mimeType: 'application/pdf' })).allowed).toBe(false);
    expect(assetPreviewAllowed(link({ mimeType: 'IMAGE/PNG' })).allowed).toBe(true);
  });

  test('can be switched off for every link', () => {
    expect(assetPreviewAllowed(link(), new Date(), { SHARE_OG_ASSET_PREVIEW: 'false' })).toEqual({ allowed: false, reason: 'switched off' });
    expect(assetPreviewAllowed(link(), new Date(), { SHARE_OG_ASSET_PREVIEW: 'true' }).allowed).toBe(true);
  });
});

describe('renderShareOgHtml', () => {
  const page = { title: 'holiday.jpg · PinITHUB', description: 'Shared securely.', imageUrl: 'https://api.example.com/api/v1/share/abc123/preview.png', pageUrl: 'https://www.pinithub.com/s/abc123' };

  test('has the Open Graph tags a chat app reads, with the asset image', () => {
    const html = renderShareOgHtml(page);
    expect(html).toContain('<meta property="og:title" content="holiday.jpg · PinITHUB" />');
    expect(html).toContain('<meta property="og:image" content="https://api.example.com/api/v1/share/abc123/preview.png" />');
    expect(html).toContain(`<meta property="og:image:width" content="${PREVIEW_WIDTH}" />`);
    expect(html).toContain(`<meta property="og:image:height" content="${PREVIEW_HEIGHT}" />`);
    expect(html).toContain('<meta property="og:url" content="https://www.pinithub.com/s/abc123" />');
    expect(html).toContain('summary_large_image');
  });

  test('sends a person who lands on it to the share viewer', () => {
    const html = renderShareOgHtml(page);
    expect(html).toContain('http-equiv="refresh" content="0;url=https://www.pinithub.com/s/abc123"');
    expect(html).toContain('<a href="https://www.pinithub.com/s/abc123">');
  });

  test('an owner-chosen file name cannot inject markup or break out of an attribute', () => {
    const hostile = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    const html = renderShareOgHtml({ ...page, title: hostile, description: hostile, imageAlt: hostile });
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('"><');
    expect(html).toContain('&lt;script&gt;');
  });

  test('without an image there are no image tags and the card is the small one', () => {
    const html = renderShareOgHtml({ ...page, imageUrl: null });
    expect(html).not.toContain('og:image');
    expect(html).toContain('content="summary"');
  });
});

describe('the images', () => {
  test('the asset preview is a 1200x630 JPEG, small enough for chat apps', async () => {
    const jpeg = await composeAssetPreviewJpeg(await photo());
    const meta = await sharp(jpeg).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', PREVIEW_WIDTH, PREVIEW_HEIGHT]);
    expect(jpeg.length).toBeLessThan(300 * 1024);
  });

  test('a portrait picture is shown whole, not cropped to a strip: its middle and its top edge both appear', async () => {
    const jpeg = await composeAssetPreviewJpeg(await photo());
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [data[(y * info.width + x) * info.channels]!, data[(y * info.width + x) * info.channels + 1]!, data[(y * info.width + x) * info.channels + 2]!];
    // centre: the blue circle of the picture; a point left of the picture: only the blurred, darkened backdrop
    expect(px(600, 315)[2]).toBeGreaterThan(px(600, 315)[0]!);
    expect(px(20, 315)[0]).toBeLessThan(150);
  });

  test('the branded card is a PNG of the same size, and a hostile file name does not break it', async () => {
    const png = await renderBrandedCardPng('<svg onload=alert(1)>&"\'.jpg');
    const meta = await sharp(png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', PREVIEW_WIDTH, PREVIEW_HEIGHT]);
  });
});

describe('getSharePreviewImage', () => {
  test('an allowed link gets the asset as a JPEG', async () => {
    const original = await photo();
    const r = await getSharePreviewImage(link(), { loadOriginal: async () => original });
    expect(r).toMatchObject({ contentType: 'image/jpeg', assetShown: true });
  });

  test('a restricted link gets the branded card and its original is never even read', async () => {
    let reads = 0;
    const r = await getSharePreviewImage(link({ requireOtp: true }), { loadOriginal: async () => { reads++; return photo(); } });
    expect(r).toMatchObject({ contentType: 'image/png', assetShown: false });
    expect(reads).toBe(0);
  });

  test.each([
    ['cannot be read', async () => null],
    ['fails to decrypt', async () => { throw new Error('Vault decrypt failed'); }],
    ['is not an image after all', async () => Buffer.from('not an image')],
  ])('an original that %s falls back to the card instead of failing', async (_label, loadOriginal) => {
    const r = await getSharePreviewImage(link(), { loadOriginal });
    expect(r).toMatchObject({ contentType: 'image/png', assetShown: false });
  });

  test('is read once and then served from memory', async () => {
    const original = await photo();
    let reads = 0;
    const deps = { loadOriginal: async () => { reads++; return original; } };
    await getSharePreviewImage(link(), deps);
    await getSharePreviewImage(link(), deps);
    expect(reads).toBe(1);
  });

  test('simultaneous requests share one read and one render', async () => {
    const original = await photo();
    let reads = 0;
    const deps = { loadOriginal: async () => { reads++; await new Promise((r) => setTimeout(r, 40)); return original; } };
    const all = await Promise.all(Array.from({ length: 6 }, () => getSharePreviewImage(link(), deps)));
    expect(reads).toBe(1);
    expect(all.every((r) => r.assetShown)).toBe(true);
  });

  test('a link that becomes restricted stops showing the asset at once, even if it was cached', async () => {
    const deps = { loadOriginal: async () => photo() };
    expect((await getSharePreviewImage(link(), deps)).assetShown).toBe(true);
    expect((await getSharePreviewImage(link({ requireOtp: true }), deps)).assetShown).toBe(false);
    expect((await getSharePreviewImage(link({ isActive: false }), deps)).assetShown).toBe(false);
  });
});
