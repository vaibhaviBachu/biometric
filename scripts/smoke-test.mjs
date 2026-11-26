#!/usr/bin/env node
/**
 * Phase 8 — deployment verification smoke test.
 *
 * Checks a *given* base URL's `/health` endpoint and reports whether the
 * service is reachable and what it reports for each component. Deliberately
 * takes the URL as a required argument with no default pointing at any real
 * environment (local or production) — this script must never be able to
 * accidentally hit something a caller didn't explicitly choose.
 *
 * Distinguishes (per Phase 8's own explicit requirement not to conflate
 * these): the HTTP request itself succeeding (the process is "alive" and
 * reachable) versus the JSON body's own `status` field (whether the
 * application considers itself healthy, degraded, or unhealthy) versus each
 * individual `components.*` entry (per-dependency detail). A reachable
 * process reporting "unhealthy" is reported as a failure, not confused with
 * "unreachable".
 *
 * Usage:
 *   node scripts/smoke-test.mjs --url=https://example.onrender.com
 *   node scripts/smoke-test.mjs --url=https://example.onrender.com --timeout-ms=10000
 */

function parseArgs(argv) {
  const get = (name) => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : undefined;
  };
  const url = get('url');
  if (!url) {
    console.error('Usage: node scripts/smoke-test.mjs --url=<base-url> [--timeout-ms=8000]');
    console.error('No default URL exists on purpose — you must name the exact target.');
    process.exit(2);
  }
  const timeoutMs = parseInt(get('timeout-ms') ?? '', 10) || 8000;
  return { url: url.replace(/\/+$/, ''), timeoutMs };
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  return { httpStatus: res.status, ok: res.ok, body };
}

async function main() {
  const { url, timeoutMs } = parseArgs(process.argv.slice(2));
  const target = `${url}/health`;
  console.log(`[smoke-test] GET ${target} (timeout ${timeoutMs}ms)`);

  let result;
  try {
    result = await fetchJson(target, timeoutMs);
  } catch (err) {
    console.error(`[smoke-test] FAIL — process unreachable: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(`[smoke-test] FAIL — reachable, but HTTP ${result.httpStatus}`);
    process.exit(1);
  }

  const appStatus = result.body?.status ?? 'unknown';
  console.log(`[smoke-test] Process reachable. Application status: ${appStatus}`);

  const components = result.body?.components ?? {};
  for (const [name, detail] of Object.entries(components)) {
    const status = detail && typeof detail === 'object' ? detail.status : 'unknown';
    console.log(`[smoke-test]   component "${name}": ${status}`);
  }

  if (appStatus !== 'healthy') {
    console.error(`[smoke-test] FAIL — reachable and responding, but application status is "${appStatus}", not "healthy"`);
    process.exit(1);
  }

  console.log('[smoke-test] PASS');
}

main().catch((err) => {
  console.error('[smoke-test] FAIL — unexpected error:', err);
  process.exit(1);
});
