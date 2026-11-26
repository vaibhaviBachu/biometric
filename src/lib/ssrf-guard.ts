/**
 * Server-side URL fetching that cannot be turned against the server's own network (SSRF).
 *
 * Every place that fetches a URL chosen by a user or found by a crawl goes through safeRequest():
 *   - only http and https, no credentials in the URL;
 *   - the destination must be a public address: loopback, private (RFC 1918), carrier-grade NAT, link-local
 *     (including the cloud metadata address 169.254.169.254), multicast, reserved, documentation, 6to4/Teredo/NAT64
 *     and the IPv6 equivalents are refused. The ranges are checked with Node's net.BlockList, not string tests;
 *   - the check is made on the address the connection really uses: the DNS answer is validated inside the socket's
 *     own `lookup`, so an attacker's DNS server cannot answer "public" to a check and "internal" to the connect
 *     (DNS rebinding), and a hostname with several records is refused if any one of them is internal;
 *   - IP literals (including IPv4-mapped IPv6 such as ::ffff:127.0.0.1 and ::ffff:7f00:1) are checked directly;
 *   - every redirect is parsed and validated again, and the number of redirects is limited;
 *   - the response size is capped while it streams (the body is never fully buffered first) and a total time limit
 *     applies, so a slow or endless response cannot tie the server up.
 * Callers get UnsafeUrlError (message contains "blocked"), ResponseTooLargeError ("too large") or a plain Error
 * ("timeout"), which the existing callers already classify by message.
 */
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response too large (limit ${limit} bytes)`);
    this.name = 'ResponseTooLargeError';
  }
}

// ── Address ranges ───────────────────────────────────────────────────────────

function buildBlockList(includeLoopback: boolean): net.BlockList {
  const list = new net.BlockList();
  const v4: Array<[string, number]> = [
    ['0.0.0.0', 8],         // "this" network
    ['10.0.0.0', 8],        // private
    ['100.64.0.0', 10],     // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
    ['169.254.0.0', 16],    // link-local, cloud metadata 169.254.169.254
    ['172.16.0.0', 12],     // private
    ['192.0.0.0', 24],      // IETF protocol assignments
    ['192.0.2.0', 24],      // documentation
    ['192.88.99.0', 24],    // 6to4 relay
    ['192.168.0.0', 16],    // private
    ['198.18.0.0', 15],     // benchmarking
    ['198.51.100.0', 24],   // documentation
    ['203.0.113.0', 24],    // documentation
    ['224.0.0.0', 4],       // multicast
    ['240.0.0.0', 4],       // reserved, includes 255.255.255.255
  ];
  if (includeLoopback) v4.push(['127.0.0.0', 8]);
  for (const [addr, prefix] of v4) list.addSubnet(addr, prefix, 'ipv4');

  const v6: Array<[string, number]> = [
    ['::', 128],            // unspecified
    ['64:ff9b::', 96],      // NAT64 (embeds an IPv4 address)
    ['64:ff9b:1::', 48],    // local-use NAT64
    ['100::', 64],          // discard-only
    ['2001::', 32],         // Teredo
    ['2001:db8::', 32],     // documentation
    ['2002::', 16],         // 6to4
    ['fc00::', 7],          // unique local
    ['fe80::', 10],         // link-local
    ['fec0::', 10],         // site-local (deprecated)
    ['ff00::', 8],          // multicast
  ];
  if (includeLoopback) v6.push(['::1', 128]);
  for (const [addr, prefix] of v6) list.addSubnet(addr, prefix, 'ipv6');
  return list;
}

const BLOCKED = buildBlockList(true);
const BLOCKED_ALLOW_LOOPBACK = buildBlockList(false);

/** ::ffff:a.b.c.d and ::ffff:xxxx:yyyy are IPv4 addresses in IPv6 clothing; return the IPv4 form, else the input. */
function unmapIpv4(address: string): string {
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1]!;
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return address;
}

/** True when the address must not be fetched. Anything that is not a valid IP address is treated as blocked. */
export function isBlockedAddress(address: string, opts: { allowLoopback?: boolean } = {}): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // [::1] and zone ids (fe80::1%eth0)
  const normalized = unmapIpv4(bare);
  const family = net.isIP(normalized);
  if (family === 0) return true;
  const list = opts.allowLoopback ? BLOCKED_ALLOW_LOOPBACK : BLOCKED;
  return list.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];
const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

export interface SafeUrlOptions {
  /** Development and tests only: lets 127.0.0.0/8 and ::1 through. Every other internal range stays blocked. */
  allowLoopback?: boolean;
}

/** Parses a URL and refuses anything that is not a public http(s) destination (before any DNS lookup). */
export function parseSafeUrl(raw: string, opts: SafeUrlOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('blocked: not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`blocked: scheme ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) throw new UnsafeUrlError('blocked: credentials in the URL are not allowed');

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) throw new UnsafeUrlError('blocked: no host');
  if (net.isIP(unmapIpv4(host)) !== 0) {
    if (isBlockedAddress(host, opts)) throw new UnsafeUrlError('blocked: address is not public');
  } else {
    const loopbackName = host === 'localhost' || host.endsWith('.localhost');
    if (!(opts.allowLoopback && loopbackName)) {
      if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
        throw new UnsafeUrlError('blocked: host name is internal');
      }
    }
  }
  return url;
}

/** The `lookup` used by the sockets: resolves the name and refuses it if ANY answer is not public. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node's lookup callback shape differs by version
export type GuardedLookup = (hostname: string, options: any, callback: (...args: any[]) => void) => void;

export function guardedLookup(opts: SafeUrlOptions = {}): GuardedLookup {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...(options ?? {}), all: true }, (err, addresses) => {
      if (err) { callback(err, '', 0); return; }
      const list = Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: 4 }];
      if (list.length === 0) { callback(new UnsafeUrlError('blocked: host did not resolve'), '', 0); return; }
      for (const a of list) {
        if (isBlockedAddress(a.address, opts)) {
          callback(new UnsafeUrlError('blocked: host resolves to a non-public address'), '', 0);
          return;
        }
      }
      if (options && options.all) {
        callback(null, list);
      } else {
        callback(null, list[0]!.address, list[0]!.family);
      }
    });
  };
}

// ── The request ─────────────────────────────────────────────────────────────

export interface SafeRequestOptions extends SafeUrlOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Total time for the request including redirects. Default 15 s. */
  timeoutMs?: number;
  /** Largest response body accepted. Default 5 MB. */
  maxBytes?: number;
  /** Redirects followed (each is validated again). Default 3; use 0 for none. */
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function requestOnce(url: URL, opts: SafeRequestOptions, deadline: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const transport = url.protocol === 'https:' ? https : http;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('Request timeout'));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };

    const req = transport.request(url, {
      method: opts.method ?? 'GET',
      headers: opts.body !== undefined
        ? { ...opts.headers, 'Content-Length': String(Buffer.byteLength(opts.body)) }
        : opts.headers,
      lookup: guardedLookup(opts) as never,
      agent: false, // no connection reuse across hosts
    }, (res) => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes && !REDIRECT_STATUS.has(res.statusCode ?? 0)) {
        res.destroy();
        finish(() => reject(new ResponseTooLargeError(maxBytes)));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          req.destroy();
          finish(() => reject(new ResponseTooLargeError(maxBytes)));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })));
      res.on('error', (e) => finish(() => reject(e)));
    });

    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new Error('Request timeout')));
    }, remaining);

    req.on('error', (e) => finish(() => reject(e)));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Fetches a public URL with the protections described at the top of this file. */
export async function safeRequest(rawUrl: string, opts: SafeRequestOptions = {}): Promise<SafeResponse> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let current = parseSafeUrl(rawUrl, opts);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(current, opts, deadline);
    const location = res.headers['location'];
    if (REDIRECT_STATUS.has(res.status) && typeof location === 'string' && location) {
      if (hop === maxRedirects) throw new UnsafeUrlError('blocked: too many redirects');
      current = parseSafeUrl(new URL(location, current).toString(), opts); // validated again
      continue;
    }
    return { ...res, finalUrl: current.toString() };
  }
  throw new UnsafeUrlError('blocked: too many redirects');
}
