/**
 * Keeps credentials out of the application logs.
 *
 * Redacted everywhere a log line or its metadata is written (the winston logger applies this to every entry):
 *   - JWTs and "Bearer …" values;
 *   - query-string secrets (token, access_token, refresh_token, api_key, signature, otp, password …);
 *   - the refresh cookie (pinit_rt=…) and any Cookie / Set-Cookie / Authorization value;
 *   - share-link tokens in paths (/share/<token>, /s/<token>, handover and client-report links);
 *   - metadata fields whose NAME marks them as secret (token, accessToken, refreshToken, authorization, cookie,
 *     password, secret, apiKey, otp, signature …).
 * Vault IDs and other ordinary identifiers are left alone so logs stay useful.
 */

const REDACTED = '[REDACTED]';

/** Field names whose values are never logged. Matched on the whole name, case-insensitively. */
const SENSITIVE_KEY =
  /^(?:.*token|authorization|proxy-authorization|cookie|set-cookie|.*password|passwd|.*secret|.*api[_-]?key|x-api-key|otp|otpcode|otp_code|.*signature|sig|credential|credentials|refresh_?token_?hash)$/i;

/** Keys that look like they match but are only counts or flags. */
const SAFE_KEY = /^(?:tokens|tokencount|tokentype|hastoken|tokenvalid|tokenpresent)$/i;

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const QUERY_SECRET = /([?&](?:token|access_token|refresh_token|id_token|api_key|apikey|key|signature|sig|otp|password|secret)=)[^&\s"']+/gi;
const REFRESH_COOKIE = /(pinit_rt=)[^;\s"']+/gi;
const SHARE_PATH =
  /(\/(?:share|s)\/)(?!(?:vault|file|living|analytics|timeline|debug|forensics|sessions|unmask-requests|messages|handover|client-report)(?:[/?\s"']|$))[A-Za-z0-9_-]{6,128}/g;
const SPECIAL_SHARE_PATH = /(\/(?:handover|client-report)\/)[A-Za-z0-9_-]{6,128}/g;

export function redactString(text: string): string {
  return text
    .replace(JWT, '[REDACTED_JWT]')
    .replace(BEARER, `$1${REDACTED}`)
    .replace(QUERY_SECRET, `$1${REDACTED}`)
    .replace(REFRESH_COOKIE, `$1${REDACTED}`)
    .replace(SHARE_PATH, `$1${REDACTED}`)
    .replace(SPECIAL_SHARE_PATH, `$1${REDACTED}`);
}

/** A request URL or path for the access log. */
export function redactUrl(url: string): string {
  return redactString(url);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) && !SAFE_KEY.test(key);
}

const MAX_DEPTH = 6;

export function redactValue(value: unknown, key = '', depth = 0): unknown {
  if (key && isSensitiveKey(key)) {
    return value === undefined || value === null || value === '' ? value : REDACTED;
  }
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, '', depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, k, depth + 1);
  }
  return out;
}
