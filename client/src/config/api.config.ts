/**
 * PINIT — Centralised API Base URL
 *
 * Priority:
 *   1. VITE_API_BASE_URL env var (required for any production build)
 *   2. '/api/v1'                 (dev only — uses Vite's proxy to localhost:4000)
 *
 * A production build with VITE_API_BASE_URL unset throws at build time instead of
 * silently falling back to some other deployment's backend — this repo used to hardcode
 * a specific Render URL here, which meant a forgotten env var would quietly misroute
 * every request to someone else's API. Fail loudly instead.
 *
 * DO NOT import axios here. Only export the base URL string.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _env = (import.meta as any).env as Record<string, string | undefined>;
const _raw = (_env['VITE_API_BASE_URL'] ?? '').trim().replace(/\/$/, '');

if (!_raw && _env['PROD']) {
  throw new Error(
    'VITE_API_BASE_URL is not set. A production build must know its own backend URL explicitly — ' +
    'set it in your deployment platform\'s environment variables (e.g. Vercel project settings).',
  );
}

export const API_BASE_URL: string = _raw || '/api/v1';
