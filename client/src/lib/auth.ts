import axios from 'axios';
import { API_BASE_URL } from '../config/api.config';

const BASE = `${API_BASE_URL}/auth`;
const AUTH_EVENT_KEY = 'pinit_auth_event';
const AUTH_CHANNEL = 'pinit-hub-auth';

export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable';

function credentialedPost(url: string, body?: unknown, timeout = 70000) {
  return axios.post(url, body ?? {}, { timeout, withCredentials: true });
}

/**
 * POST with retry — survives Render free-tier cold starts (the backend sleeps
 * after ~15 min idle and the first request can 5xx / time out while it wakes).
 * Retries on network errors, timeouts, and 5xx responses.
 */
function toApiError(e: unknown): Error {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ax = e as any;
  const msg = ax?.response?.data?.error as string | undefined;
  if (msg) return new Error(msg);
  if (typeof ax?.message === 'string' && ax.message) return new Error(ax.message);
  return new Error('Request failed. Please try again.');
}

async function postWithRetry(url: string, body?: unknown, attempts = 4): Promise<{ data: unknown }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios.post(url, body, { timeout: 70000, withCredentials: true });
    } catch (e: unknown) {
      lastErr = e;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (e as any)?.response?.status as number | undefined;
      const retryable = status === undefined || status >= 500; // network/timeout or server error
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw toApiError(lastErr);
}

/**
 * Fire-and-forget wake-up so the backend is awake by the time the (long)
 * registration/login flow finishes. Safe to call repeatedly.
 */
export function warmBackend(): void {
  axios.get(`${API_BASE_URL}/dna/supported-types`, { timeout: 70000 }).catch(() => {});
}

export interface AuthUser {
  sub: string;
  shortId: string;
  name: string;
  role: string;
  /** Hub is released for Personal accounts only; every user is treated as Personal. */
  accountType?: 'INDIVIDUAL';
  lastActiveShell?: 'PERSONAL';
  capabilities?: {
    buyer_enabled?: boolean;
    can_purchase?: boolean;
    business?: boolean;
    business_setup_complete?: boolean;
  };
}

export function broadcastAuthEvent(type: 'login' | 'logout'): void {
  try {
    localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ type, t: Date.now() }));
  } catch { /* ignore */ }
  try {
    const ch = new BroadcastChannel(AUTH_CHANNEL);
    ch.postMessage({ type });
    ch.close();
  } catch { /* unsupported */ }
}

export function subscribeAuthEvents(onEvent: (type: 'login' | 'logout') => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== AUTH_EVENT_KEY || !e.newValue) return;
    try {
      const parsed = JSON.parse(e.newValue) as { type?: string };
      if (parsed.type === 'login' || parsed.type === 'logout') onEvent(parsed.type);
    } catch { /* ignore */ }
  };
  window.addEventListener('storage', onStorage);
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(AUTH_CHANNEL);
    ch.onmessage = (ev: MessageEvent) => {
      const type = (ev.data as { type?: string } | undefined)?.type;
      if (type === 'login' || type === 'logout') onEvent(type);
    };
  } catch { /* ignore */ }
  return () => {
    window.removeEventListener('storage', onStorage);
    try { ch?.close(); } catch { /* ignore */ }
  };
}

export function getAccessToken(): string | null {
  return localStorage.getItem('pinit_access_token');
}

export function getRefreshToken(): string | null {
  return localStorage.getItem('pinit_refresh_token');
}

export function saveTokens(access: string, _refresh?: string) {
  localStorage.setItem('pinit_access_token', access);
  // Refresh lives in an HttpOnly cookie. Drop any leftover JS-readable copy.
  localStorage.removeItem('pinit_refresh_token');
}

export function clearTokens() {
  localStorage.removeItem('pinit_access_token');
  localStorage.removeItem('pinit_refresh_token');
}

/** Clear all user-specific client caches on logout — prevents cross-tenant data bleed. */
export function clearUserSessionCaches() {
  try {
    sessionStorage.removeItem('pinit_dna_reports');
    sessionStorage.removeItem('pinit_session');
    localStorage.removeItem('pinit_forensic_reports');
  } catch { /* SSR / privacy mode */ }
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k?.startsWith('pinit_')
        && k !== 'pinit_theme'
        && !k.startsWith('pinit_plan_choice_')
      ) keysToRemove.push(k);
    }
    for (const k of keysToRemove) localStorage.removeItem(k);
  } catch { /* ignore */ }
}

export function parseJwt(token: string): AuthUser | null {
  try {
    const p = JSON.parse(atob(token.split('.')[1]));
    return {
      sub: p.sub,
      shortId: p.shortId,
      name: p.name,
      role: p.role,
      // Personal Hub accounts only: whatever the server says, the client treats every user as Personal.
      accountType: 'INDIVIDUAL',
      lastActiveShell: 'PERSONAL',
    };
  } catch {
    return null;
  }
}

/**
 * True when a non-expired Hub access JWT is present. Refresh-only is not a session.
 */
export function hasValidAccessToken(token: string | null = getAccessToken()): boolean {
  if (!token || !parseJwt(token)) return false;
  try {
    const p = JSON.parse(atob(token.split('.')[1]));
    if (p.exp && p.exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

/** Hub session = valid access JWT (refreshed from the HttpOnly cookie on boot). */
export function hasHubSession(): boolean {
  return hasValidAccessToken();
}

export async function apiFetchMe(): Promise<AuthUser | null> {
  const token = getAccessToken();
  const res = await axios.get(`${BASE}/me`, {
    timeout: 70000,
    withCredentials: true,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = (res.data as { data?: AuthUser } | undefined)?.data;
  if (!data?.sub || !data.shortId) return parseJwt(token || '') ;
  return {
    sub: data.sub,
    shortId: data.shortId,
    name: data.name,
    role: String(data.role || 'USER'),
    accountType: 'INDIVIDUAL',
    lastActiveShell: 'PERSONAL',
    capabilities: data.capabilities,
  };
}

export async function apiCreateAccount(): Promise<AuthUser> {
  const res = await postWithRetry(`${BASE}/create`);
  const { accessToken, refreshToken } = (res.data as any).data;
  saveTokens(accessToken, refreshToken);
  broadcastAuthEvent('login');
  return parseJwt(accessToken)!;
}

/** Check shortId against the server without persisting tokens (login pre-flight). */
export async function apiVerifyShortId(shortId: string): Promise<{ valid: boolean; error?: string }> {
  try {
    await axios.post(`${BASE}/login`, { shortId }, { timeout: 70000, withCredentials: true });
    return { valid: true };
  } catch (e: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (e as any)?.response?.status as number | undefined;
    if (status === 401) return { valid: false, error: toApiError(e).message };
    throw toApiError(e);
  }
}

export async function apiLogin(shortId: string): Promise<AuthUser> {
  const res = await postWithRetry(`${BASE}/login`, { shortId });
  const { accessToken, refreshToken } = (res.data as any).data;
  saveTokens(accessToken, refreshToken);
  broadcastAuthEvent('login');
  return parseJwt(accessToken)!;
}

export async function apiLogout() {
  const refreshToken = getRefreshToken();
  try {
    await credentialedPost(`${BASE}/logout`, refreshToken ? { refreshToken } : {});
  } catch { /* still clear locally */ }
  clearTokens();
  clearUserSessionCaches();
  broadcastAuthEvent('logout');
}

/** Renew this long before expiry, so a request never leaves with a token that dies in flight. */
const RENEW_BEFORE_EXPIRY_MS = 60_000;

function expiresWithin(token: string | null, ms: number): boolean {
  if (!token) return true;
  try {
    const p = JSON.parse(atob(token.split('.')[1])) as { exp?: number };
    return !p.exp || p.exp * 1000 - Date.now() < ms;
  } catch {
    return true;
  }
}

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Renew the access token from the HttpOnly refresh cookie.
 *
 * The server rotates the refresh token on every use, so two refreshes racing with the same cookie would make the
 * second one fail and sign the user out. Calls in this tab share one request, and tabs take turns through a Web Lock;
 * a tab that waited first checks whether another tab already stored a fresh token.
 */
export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  const before = getAccessToken();
  const run = async (): Promise<string | null> => {
    const now = getAccessToken();
    if (now && now !== before && !expiresWithin(now, RENEW_BEFORE_EXPIRY_MS)) return now;
    return refreshFromCookie();
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  // The lock is held until run() settles, because the callback returns that promise.
  const attempt: Promise<string | null> = locks
    ? new Promise<string | null>((resolve, reject) => {
        void locks.request('pinit-hub-token-refresh', () => run().then(resolve, reject));
      })
    : run();
  const shared = attempt.finally(() => { refreshInFlight = null; });
  refreshInFlight = shared;
  return shared;
}

/** The current access token, renewed first when it is missing a minute from expiry. Null when signed out. */
export async function getFreshAccessToken(): Promise<string | null> {
  const token = getAccessToken();
  if (token && !expiresWithin(token, RENEW_BEFORE_EXPIRY_MS)) return token;
  if (!token) return null;
  return (await refreshAccessToken()) ?? null;
}

/** How the last refresh ended. 'unavailable' (network, timeout, 5xx) says nothing about the session itself. */
let lastRefreshOutcome: 'ok' | 'rejected' | 'unavailable' = 'ok';

/** True when the last refresh failed only because the server could not be reached; the session may still be valid. */
export function lastRefreshWasUnavailable(): boolean {
  return lastRefreshOutcome === 'unavailable';
}

async function refreshFromCookie(): Promise<string | null> {
  const legacyRefresh = getRefreshToken();
  const startedWith = getAccessToken();
  try {
    const res = await credentialedPost(
      `${BASE}/refresh`,
      legacyRefresh ? { refreshToken: legacyRefresh } : {},
    );
    const accessToken = (res.data as any)?.data?.accessToken as string | undefined;
    if (!accessToken) {
      lastRefreshOutcome = 'rejected';
      return null;
    }
    saveTokens(accessToken);
    lastRefreshOutcome = 'ok';
    return accessToken;
  } catch (e: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (e as any)?.response?.status as number | undefined;
    lastRefreshOutcome = status !== undefined && status >= 400 && status < 500 ? 'rejected' : 'unavailable';
    // Another tab may have signed in or refreshed while this request was out; its token is not ours to drop.
    if (status === 401 && getAccessToken() === startedWith) clearTokens();
    return null;
  }
}

/** Apply tokens returned from face register/login endpoints. */
export function applyFaceAuthTokens(data: { accessToken?: string; refreshToken?: string }): AuthUser | null {
  if (!data.accessToken) return null;
  saveTokens(data.accessToken, data.refreshToken);
  broadcastAuthEvent('login');
  return parseJwt(data.accessToken);
}
