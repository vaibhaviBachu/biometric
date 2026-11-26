/**
 * What a share link (/s/:token) answers: a page of Open Graph tags for chat-app crawlers, the app for people.
 */
import fs from 'fs';
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockFindLink = jest.fn();
jest.mock('../../src/lib/prisma', () => ({ prisma: { shareLink: { findUnique: (...a: unknown[]) => mockFindLink(...a) } } }));
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { serveShareLandingPage } from '../../src/api/controllers/share-og.controller';

const WHATSAPP = 'WhatsApp/2.23.20.0 A';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TOKEN = '9S4eVqi22n';

const fullLink = (over: Record<string, unknown> = {}) => ({
  id: 'link-1', vaultId: 'vault-1', filename: 'holiday.jpg', mimeType: 'image/jpeg', ownerUserId: 'owner-1',
  isActive: true, expiresAt: null, requireOtp: false, requireName: false, oneTimeUse: false, maxViews: null,
  oneDeviceOnly: false, oneIpOnly: false, allowedCountries: [], allowedDeviceTypes: [], allowedIpPrefixes: [],
  corporateIpRanges: [], domainRestrictions: [], intendedDeviceFingerprint: null, intendedIpAddress: null,
  privacyMaskingEnabled: false, firstViewExpiresAfter: null, ...over,
});

interface Captured { status?: number; body?: string; redirect?: { code: number; url: string }; headers: Record<string, string>; contentType?: string }
function run(opts: { token?: string; ua?: string; host?: string }): Promise<Captured> {
  const out: Captured = { headers: {} };
  const headers: Record<string, string | undefined> = { 'user-agent': opts.ua, host: opts.host ?? 'api.example.onrender.com' };
  const req = { params: { token: opts.token ?? TOKEN }, get: (h: string) => headers[h.toLowerCase()] } as never;
  const res = {
    status(code: number) { out.status = code; return res; },
    type(t: string) { out.contentType = t; return res; },
    setHeader(k: string, v: string) { out.headers[k] = v; return res; },
    redirect(code: number, url: string) { out.redirect = { code, url }; },
    send(body: string) { out.body = body; return res; },
  } as never;
  return serveShareLandingPage(req, res).then(() => out);
}

let existsSpy: jest.SpiedFunction<typeof fs.existsSync>;
beforeEach(() => {
  mockFindLink.mockReset();
  existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false); // the React app is not built beside the API
});
afterEach(() => jest.restoreAllMocks());

describe('a chat-app crawler', () => {
  test('gets Open Graph tags whose image is this link\'s preview, with the file name in the title', async () => {
    mockFindLink.mockResolvedValue(fullLink());
    const r = await run({ ua: WHATSAPP });
    expect(r.contentType).toBe('html');
    expect(r.body).toContain('<meta property="og:title" content="holiday.jpg · PinITHUB" />');
    expect(r.body).toContain(`<meta property="og:image" content="https://api.example.onrender.com/api/v1/share/${TOKEN}/preview.png" />`);
    expect(r.body).toContain('Shared securely with PinITHUB. Open to view.');
    expect(r.headers['Cache-Control']).toBe('public, max-age=60');
    expect(r.redirect).toBeUndefined();
  });

  test('a link with access conditions still gets a preview card, but the description does not promise the asset', async () => {
    mockFindLink.mockResolvedValue(fullLink({ requireOtp: true }));
    const r = await run({ ua: WHATSAPP });
    expect(r.body).toContain('og:image');
    expect(r.body).not.toContain('Shared securely with PinITHUB');
    expect(r.body).toContain('encrypted and tracked');
  });

  test('a revoked link does not reveal its file name', async () => {
    mockFindLink.mockResolvedValue(fullLink({ isActive: false, filename: 'secret-contract.pdf' }));
    const r = await run({ ua: WHATSAPP });
    expect(r.body).not.toContain('secret-contract');
    expect(r.body).toContain('Secure file · PinITHUB');
  });

  test('an unknown link gets the generic card', async () => {
    mockFindLink.mockResolvedValue(null);
    const r = await run({ ua: WHATSAPP });
    expect(r.status).toBeUndefined();
    expect(r.body).toContain('Secure file · PinITHUB');
  });

  test('a database failure still answers, with the generic card', async () => {
    mockFindLink.mockRejectedValue(new Error('database busy'));
    const r = await run({ ua: WHATSAPP });
    expect(r.body).toContain('Secure file · PinITHUB');
  });

  test('an owner-chosen file name cannot inject markup', async () => {
    mockFindLink.mockResolvedValue(fullLink({ filename: '"><script>alert(1)</script>.jpg' }));
    const r = await run({ ua: WHATSAPP });
    expect(r.body).not.toContain('<script>');
    expect(r.body).toContain('&lt;script&gt;');
  });

  test('a hostile Host header is not put into the page', async () => {
    mockFindLink.mockResolvedValue(fullLink());
    const r = await run({ ua: WHATSAPP, host: 'evil.com"><script>alert(1)</script>' });
    expect(r.body).not.toContain('evil.com');
    expect(r.body).not.toContain('<script>');
    expect(r.body).not.toContain('og:image"');
  });
});

describe('everything else', () => {
  test('a token that cannot be a real one is refused before anything is looked up', async () => {
    for (const token of ['x', '<script>', 'a'.repeat(100), "ab'cd12", '../../etc']) {
      const r = await run({ token, ua: WHATSAPP });
      expect(r.status).toBe(404);
    }
    expect(mockFindLink).not.toHaveBeenCalled();
  });

  test('a person with no app built here is sent to the share viewer', async () => {
    const r = await run({ ua: CHROME });
    expect(r.redirect?.code).toBe(302);
    expect(r.redirect?.url).toMatch(new RegExp(`/s/${TOKEN}$`));
    expect(mockFindLink).not.toHaveBeenCalled();
  });

  test('a person with the app built here gets the app page carrying the same tags', async () => {
    existsSpy.mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('<html><head><title>PinITHUB</title></head><body></body></html>');
    mockFindLink.mockResolvedValue(fullLink());
    const r = await run({ ua: CHROME });
    expect(r.body).toContain('<title>PinITHUB</title>');
    expect(r.body).toContain('og:image');
    expect(r.body).toContain('holiday.jpg');
  });
});
