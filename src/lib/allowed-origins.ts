/**
 * Which browser origins may call this API, and whether they may send cookies.
 *
 * Exact matches only. The earlier rule accepted any origin that merely CONTAINED "vercel.app", "ngrok" or
 * "localhost". Anyone can publish a site on vercel.app, so any such site was allowed to call the API with the
 * visitor's cookies and read the answer (including a fresh access token from /auth/refresh).
 *
 * Allowed with cookies:
 *   - the built-in production origins below, and anything listed in ALLOWED_ORIGIN / ALLOWED_ORIGINS,
 *     PUBLIC_APP_URL or EXCHANGE_APP_URL (exact origin match; a Vercel preview URL must be listed to work);
 *   - https subdomains of our own domains (pinithub.com, pinitexchange.com);
 *   - the API's own origin (the app served from the same host);
 *   - localhost and ngrok, only when NODE_ENV is not production (or ALLOW_LOCALHOST_ORIGINS=true).
 * Allowed WITHOUT cookies: browser-extension origins (they use bearer tokens). ALLOWED_EXTENSION_IDS, a
 * comma-separated list, restricts which extensions when it is set.
 * Everything else is refused.
 */

const BUILT_IN_ORIGINS = [
  'https://pinit-dna.vercel.app',
  'https://pinithub.com',
  'https://www.pinithub.com',
  'https://pinitexchange.com',
  'https://www.pinitexchange.com',
];

const OWN_DOMAIN_SUFFIXES = ['.pinithub.com', '.pinitexchange.com'];
const NGROK_SUFFIXES = ['.ngrok.io', '.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const EXTENSION_ORIGIN = /^(?:chrome-extension|extension):\/\/([a-z0-9]{8,64})$/i;

export interface CorsVerdict {
  allowed: boolean;
  /** Whether cookies/credentials may accompany the request. */
  credentials: boolean;
}

const DENY: CorsVerdict = { allowed: false, credentials: false };

/** "https://Host:443/path" -> "https://host" (http/https only), or null. */
function toOrigin(value: string): string | null {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

function isProduction(): boolean {
  return (process.env['NODE_ENV'] || '').toLowerCase() === 'production';
}

function configuredOrigins(): Set<string> {
  const set = new Set(BUILT_IN_ORIGINS);
  const raw = [
    process.env['ALLOWED_ORIGIN'],
    ...(process.env['ALLOWED_ORIGINS'] ?? '').split(','),
    process.env['PUBLIC_APP_URL'],
    process.env['EXCHANGE_APP_URL'],
  ];
  for (const value of raw) {
    if (!value) continue;
    const origin = toOrigin(value);
    if (origin) set.add(origin);
  }
  return set;
}

function allowedExtensionIds(): string[] {
  return (process.env['ALLOWED_EXTENSION_IDS'] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Decides one request. `origin` is the Origin header (undefined for requests that are not cross-origin browser
 * requests), `requestHost` the Host header the API was reached on.
 */
export function resolveCors(origin: string | undefined, requestHost?: string): CorsVerdict {
  if (!origin) return { allowed: true, credentials: false };

  const ext = EXTENSION_ORIGIN.exec(origin);
  if (ext) {
    const ids = allowedExtensionIds();
    return { allowed: ids.length === 0 || ids.includes(ext[1]!.toLowerCase()), credentials: false };
  }

  const normalized = toOrigin(origin);
  if (!normalized) return DENY; // includes the literal "null" origin (sandboxed frames, file://)
  const url = new URL(normalized);

  if (requestHost && url.host === requestHost.trim().toLowerCase()) {
    return { allowed: true, credentials: true }; // the API's own origin
  }
  if (configuredOrigins().has(normalized)) return { allowed: true, credentials: true };
  if (url.protocol === 'https:' && OWN_DOMAIN_SUFFIXES.some((s) => url.hostname.endsWith(s))) {
    return { allowed: true, credentials: true };
  }
  if (!isProduction() || (process.env['ALLOW_LOCALHOST_ORIGINS'] || '').toLowerCase() === 'true') {
    if (LOCAL_HOSTS.has(url.hostname) || NGROK_SUFFIXES.some((s) => url.hostname.endsWith(s))) {
      return { allowed: true, credentials: true };
    }
  }
  return DENY;
}
