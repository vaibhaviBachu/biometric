/**
 * Phase 6: public health discloses only the verdict; API JSON gets a deny-all policy while files keep rendering;
 * pages get a report-only policy; the debug route is for admins only.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const mockReport = {
  status: 'healthy' as 'healthy' | 'degraded' | 'unhealthy',
  timestamp: '2026-10-13T10:00:00.000Z',
  uptime: 1234,
  version: '2.0.0-universal',
  components: {
    database: { status: 'unhealthy', message: 'Database unreachable: Error: connect ECONNREFUSED 10.1.2.3:5432' },
    vault: { status: 'healthy', message: 'ok' },
    storage: { status: 'healthy', message: 'ok' },
    encryption: { status: 'degraded', message: 'Vault master secret appears to be default/weak' },
    supabase: { status: 'healthy', message: 'ok' },
    memory: { status: 'healthy', message: 'heap 512 MB' },
    mediaTools: { status: 'healthy', message: 'ffmpeg' },
  },
};

jest.mock('../../src/lib/health', () => ({ getHealthReport: jest.fn(async () => mockReport) }));

import { publicHealth, detailedHealth } from '../../src/api/controllers/health.controller';
import { apiJsonPolicy, pagePolicyReportOnly, API_JSON_CSP, PAGE_CSP_REPORT_ONLY } from '../../src/api/middleware/security-headers';

function fakeRes() {
  const headers: Record<string, string> = {};
  const out: { status?: number; body?: unknown; headers: Record<string, string> } = { headers };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
    setHeader(k: string, v: string) { headers[k] = v; return this; },
    getHeader(k: string) { return headers[k]; },
  };
  return { res: res as never, out };
}

beforeEach(() => { mockReport.status = 'healthy'; });

describe('public health', () => {
  test('returns only the verdict and a timestamp', async () => {
    const { res, out } = fakeRes();
    await publicHealth({} as never, res);
    expect(out.status).toBe(200);
    expect(Object.keys(out.body as object).sort()).toEqual(['status', 'timestamp']);
  });

  test.each([
    ['healthy', 200], ['degraded', 207], ['unhealthy', 503],
  ] as const)('%s keeps status code %i for platform health gates', async (status, code) => {
    mockReport.status = status;
    const { res, out } = fakeRes();
    await publicHealth({} as never, res);
    expect(out.status).toBe(code);
  });

  test('never discloses database errors, memory, versions, uptime or storage details', async () => {
    mockReport.status = 'unhealthy';
    const { res, out } = fakeRes();
    await publicHealth({} as never, res);
    const text = JSON.stringify(out.body);
    for (const leak of ['ECONNREFUSED', '10.1.2.3', 'Database unreachable', 'heap', '2.0.0-universal', 'uptime', 'ffmpeg', 'master secret', 'components']) {
      expect(text).not.toContain(leak);
    }
  });
});

describe('detailed health (admin route)', () => {
  test('returns the full report with the same status mapping', async () => {
    mockReport.status = 'degraded';
    const { res, out } = fakeRes();
    await detailedHealth({} as never, res);
    expect(out.status).toBe(207);
    expect(out.body).toMatchObject({ version: '2.0.0-universal', uptime: 1234 });
  });

  test('is registered behind sign-in and an admin role, and the public paths use the minimal handler', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'app.ts'), 'utf8');
    expect(source).toMatch(/\/health\/details`?,\s*requireAuth,\s*requireAdminOrSuper,\s*detailedHealth/);
    expect(source).toMatch(/\/health`,\s*publicHealth/);
    expect(source).toMatch(/app\.get\('\/health',\s*publicHealth\)/);
  });
});

describe('debug routes need an admin', () => {
  test('/share/debug/report requires sign-in and an admin role', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'api', 'routes', 'share.routes.ts'), 'utf8');
    expect(source).toMatch(/'\/debug\/report',\s*requireAuth,\s*requireAdminOrSuper,\s*debugReport/);
  });
});

describe('security headers', () => {
  test('a JSON response from the API carries the deny-all policy', () => {
    const { res, out } = fakeRes();
    const sent: unknown[] = [];
    (res as unknown as { json: (b: unknown) => unknown }).json = (b: unknown) => { sent.push(b); return res; };
    apiJsonPolicy({} as never, res, () => undefined);
    (res as unknown as { json: (b: unknown) => void }).json({ ok: true });
    expect(out.headers['Content-Security-Policy']).toBe(API_JSON_CSP);
    expect(API_JSON_CSP).toContain("default-src 'none'");
    expect(sent).toEqual([{ ok: true }]);
  });

  test('a response that is not JSON (a file) gets no policy from this middleware', () => {
    const { res, out } = fakeRes();
    apiJsonPolicy({} as never, res, () => undefined);
    expect(out.headers['Content-Security-Policy']).toBeUndefined();
  });

  test('an existing policy is not overwritten', () => {
    const { res, out } = fakeRes();
    out.headers['Content-Security-Policy'] = "default-src 'self'";
    apiJsonPolicy({} as never, res, () => undefined);
    (res as unknown as { json: (b: unknown) => void }).json({});
    expect(out.headers['Content-Security-Policy']).toBe("default-src 'self'");
  });

  test('pages outside the API prefix get the report-only policy; API paths do not', () => {
    const mw = pagePolicyReportOnly('/api/v1');
    const page = fakeRes();
    mw({ path: '/s/abc123' } as never, page.res, () => undefined);
    expect(page.out.headers['Content-Security-Policy-Report-Only']).toBe(PAGE_CSP_REPORT_ONLY);
    const api = fakeRes();
    mw({ path: '/api/v1/vault' } as never, api.res, () => undefined);
    expect(api.out.headers['Content-Security-Policy-Report-Only']).toBeUndefined();
  });

  test('the page policy allows nothing dangerous: no object embeds, no framing by other sites, no unsafe-eval', () => {
    expect(PAGE_CSP_REPORT_ONLY).toContain("object-src 'none'");
    expect(PAGE_CSP_REPORT_ONLY).toContain("frame-ancestors 'self'");
    expect(PAGE_CSP_REPORT_ONLY).toContain("base-uri 'self'");
    // 'wasm-unsafe-eval' (WebAssembly only) is allowed; plain 'unsafe-eval' is not.
    expect(PAGE_CSP_REPORT_ONLY).not.toContain("'unsafe-eval'");
    expect(PAGE_CSP_REPORT_ONLY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  test('the frontend config carries the same security headers', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'client', 'vercel.json'), 'utf8')) as {
      headers: Array<{ headers: Array<{ key: string; value: string }> }>;
    };
    const keys = vercel.headers[0]!.headers.map((h) => h.key);
    expect(keys).toEqual(expect.arrayContaining(['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Permissions-Policy', 'Content-Security-Policy-Report-Only']));
    const csp = vercel.headers[0]!.headers.find((h) => h.key === 'Content-Security-Policy-Report-Only')!.value;
    expect(csp).toBe(PAGE_CSP_REPORT_ONLY);
  });
});
