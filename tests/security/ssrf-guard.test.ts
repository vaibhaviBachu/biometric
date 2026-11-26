/**
 * Phase 5: server-side URL fetching. Address ranges (IPv4, IPv6, mapped forms, metadata), URL parsing,
 * DNS answers checked on the connection (rebinding, mixed answers), redirect re-validation, size and time limits.
 */
import { describe, test, expect, jest, afterEach, afterAll } from '@jest/globals';
import dns from 'dns';
import http from 'http';
import type { AddressInfo } from 'net';

import {
  isBlockedAddress, parseSafeUrl, guardedLookup, safeRequest, UnsafeUrlError, ResponseTooLargeError,
} from '../../src/lib/ssrf-guard';

afterEach(() => { jest.restoreAllMocks(); });

describe('isBlockedAddress', () => {
  test.each([
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '192.168.255.254', '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.100.100.200',
    '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250',
    '240.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::1',
    '2001::1', '64:ff9b::7f00:1', '[::1]',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254', '0:0:0:0:0:ffff:7f00:1',
  ])('%s is blocked', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  test.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '192.169.0.1', '198.17.255.255', '198.20.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e',
    '::ffff:8.8.8.8', '::ffff:808:808',
  ])('%s is public', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  test('anything that is not an IP address is refused', () => {
    for (const v of ['', 'example.com', '999.1.1.1', '1.2.3', 'abc']) expect(isBlockedAddress(v)).toBe(true);
  });

  test('loopback can be allowed for development and tests; the other internal ranges stay blocked', () => {
    expect(isBlockedAddress('127.0.0.1', { allowLoopback: true })).toBe(false);
    expect(isBlockedAddress('::1', { allowLoopback: true })).toBe(false);
    expect(isBlockedAddress('::ffff:127.0.0.1', { allowLoopback: true })).toBe(false);
    expect(isBlockedAddress('10.0.0.1', { allowLoopback: true })).toBe(true);
    expect(isBlockedAddress('169.254.169.254', { allowLoopback: true })).toBe(true);
  });
});

describe('parseSafeUrl', () => {
  test.each([
    'file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com', 'javascript:alert(1)', 'data:text/html,hi',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fe80::1]/',
    'http://10.1.2.3/', 'http://192.168.1.1/admin', 'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/', 'http://localhost/', 'http://LOCALHOST:8001/', 'http://app.localhost/',
    'http://metadata.google.internal/computeMetadata/v1/', 'http://printer.local/', 'http://db.internal/',
    'http://user:pass@example.com/',
    'not a url', '',
  ])('%s is refused', (url) => {
    expect(() => parseSafeUrl(url)).toThrow(UnsafeUrlError);
  });

  test.each([
    'https://example.com/', 'http://example.com:8080/path?q=1', 'https://8.8.8.8/', 'https://[2606:4700:4700::1111]/',
    'https://sub.domain.example.org/a/b',
  ])('%s is accepted', (url) => {
    expect(parseSafeUrl(url)).toBeInstanceOf(URL);
  });

  test('loopback names and addresses only with the development option', () => {
    expect(() => parseSafeUrl('http://localhost:3000/', { allowLoopback: true })).not.toThrow();
    expect(() => parseSafeUrl('http://127.0.0.1:3000/', { allowLoopback: true })).not.toThrow();
    expect(() => parseSafeUrl('http://10.0.0.1/', { allowLoopback: true })).toThrow(UnsafeUrlError);
  });
});

describe('DNS answers are checked on the connection', () => {
  function stubDns(answers: Array<{ address: string; family: number }>) {
    jest.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: unknown) => void) => cb(null, answers)) as never);
  }
  function lookup(host: string, options: Record<string, unknown> = {}) {
    return new Promise<{ err: Error | null; result: unknown }>((resolve) => {
      guardedLookup()(host, options, (err: Error | null, ...rest: unknown[]) => resolve({ err, result: rest }));
    });
  }

  test('a name that resolves to an internal address is refused (DNS rebinding)', async () => {
    stubDns([{ address: '10.0.0.5', family: 4 }]);
    const { err } = await lookup('rebind.example.test');
    expect(err).toBeInstanceOf(UnsafeUrlError);
  });

  test('a name with several answers is refused if any one is internal', async () => {
    stubDns([{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]);
    expect((await lookup('mixed.example.test')).err).toBeInstanceOf(UnsafeUrlError);
  });

  test('an IPv4-mapped IPv6 answer for an internal address is refused', async () => {
    stubDns([{ address: '::ffff:127.0.0.1', family: 6 }]);
    expect((await lookup('mapped.example.test')).err).toBeInstanceOf(UnsafeUrlError);
  });

  test('all-public answers pass, in the shape the caller asked for', async () => {
    stubDns([{ address: '93.184.216.34', family: 4 }]);
    const single = await lookup('ok.example.test');
    expect(single.err).toBeNull();
    expect(single.result).toEqual(['93.184.216.34', 4]);
    const all = await lookup('ok.example.test', { all: true });
    expect(all.result).toEqual([[{ address: '93.184.216.34', family: 4 }]]);
  });

  test('safeRequest refuses a host that resolves internally without connecting', async () => {
    stubDns([{ address: '192.168.0.10', family: 4 }]);
    await expect(safeRequest('http://rebind.example.test/')).rejects.toThrow(/blocked/);
  });
});

describe('safeRequest against a local server (loopback allowed for the test only)', () => {
  const servers: http.Server[] = [];
  afterAll(() => { for (const s of servers) s.close(); });

  function serve(handler: http.RequestListener): Promise<string> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    });
  }
  const LOCAL = { allowLoopback: true };

  test('loopback is refused by default', async () => {
    const base = await serve((_req, res) => res.end('secret'));
    await expect(safeRequest(`${base}/`)).rejects.toThrow(UnsafeUrlError);
    await expect(safeRequest(base.replace('127.0.0.1', 'localhost'))).rejects.toThrow(UnsafeUrlError);
  });

  test('a normal response is returned', async () => {
    const base = await serve((_req, res) => { res.setHeader('content-type', 'text/plain'); res.end('hello'); });
    const out = await safeRequest(`${base}/x`, LOCAL);
    expect(out.status).toBe(200);
    expect(out.body.toString()).toBe('hello');
    expect(out.finalUrl).toBe(`${base}/x`);
  });

  test('POST sends the body and Content-Length', async () => {
    let seen = '';
    let length = '';
    const base = await serve((req, res) => {
      length = String(req.headers['content-length']);
      req.on('data', (c) => { seen += c; });
      req.on('end', () => res.end('ok'));
    });
    const out = await safeRequest(`${base}/`, { ...LOCAL, method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
    expect(out.status).toBe(200);
    expect(seen).toBe('{"a":1}');
    expect(length).toBe('7');
  });

  test('a response larger than the limit is stopped while streaming', async () => {
    const base = await serve((_req, res) => {
      res.write(Buffer.alloc(64 * 1024, 1));
      const timer = setInterval(() => { if (!res.write(Buffer.alloc(64 * 1024, 1))) clearInterval(timer); }, 1);
      res.on('close', () => clearInterval(timer));
    });
    await expect(safeRequest(`${base}/`, { ...LOCAL, maxBytes: 100 * 1024 })).rejects.toThrow(ResponseTooLargeError);
  });

  test('a declared size over the limit is refused before the body is read', async () => {
    const base = await serve((_req, res) => { res.setHeader('content-length', String(10 * 1024 * 1024)); res.write('x'); });
    await expect(safeRequest(`${base}/`, { ...LOCAL, maxBytes: 1024 })).rejects.toThrow(/too large/i);
  });

  test('a response that never finishes is cut off by the time limit', async () => {
    const base = await serve((_req, res) => { res.write('start'); });
    await expect(safeRequest(`${base}/`, { ...LOCAL, timeoutMs: 300 })).rejects.toThrow(/timeout/i);
  });

  test('a redirect to a public-looking path on the same host is followed; the final URL is reported', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/start') { res.statusCode = 302; res.setHeader('location', '/end'); res.end(); return; }
      res.end('arrived');
    });
    const out = await safeRequest(`${base}/start`, LOCAL);
    expect(out.body.toString()).toBe('arrived');
    expect(out.finalUrl).toBe(`${base}/end`);
  });

  test.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://[fe80::1]:9/',
    'http://[::ffff:169.254.169.254]/',
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_PING',
    'http://metadata.google.internal/',
  ])('a redirect to %s is refused (every hop is validated again)', async (target) => {
    const base = await serve((_req, res) => { res.statusCode = 302; res.setHeader('location', target); res.end(); });
    await expect(safeRequest(`${base}/`, { ...LOCAL, maxRedirects: 3 })).rejects.toThrow(UnsafeUrlError);
  });

  test('redirect loops stop at the limit', async () => {
    const base = await serve((_req, res) => { res.statusCode = 302; res.setHeader('location', '/again'); res.end(); });
    await expect(safeRequest(`${base}/`, { ...LOCAL, maxRedirects: 2 })).rejects.toThrow(/redirects/);
  });

  test('with redirects switched off (webhooks) a redirect is refused, not followed', async () => {
    const base = await serve((_req, res) => { res.statusCode = 302; res.setHeader('location', '/elsewhere'); res.end(); });
    await expect(safeRequest(`${base}/`, { ...LOCAL, maxRedirects: 0 })).rejects.toThrow(UnsafeUrlError);
  });
});
