/**
 * A server started on a developer's machine must not use the production database or the production file storage.
 *
 * The project's .env points at production (Supabase). On 2026-11-16 a local Trace wrote evidence, lineage and DNA records into
 * production. Outside production (NODE_ENV !== 'production'), the server now refuses to start while DATABASE_URL, DIRECT_URL or
 * the file storage points at a hosted production service, unless ALLOW_PRODUCTION_DB=1 is set on purpose for that run.
 *
 * Production is never affected: NODE_ENV=production (Dockerfile, render.yaml, `npm run start:fast`), or any service on Render
 * (RENDER is set there automatically), whatever its start command.
 */

export interface IsolationReport {
  /** True when the run may go ahead. */
  ok: boolean;
  /** Why it may not (empty when ok). */
  problems: string[];
  /** One line for the startup log: where the database and the files are. */
  summary: string;
  /** The run is allowed to use production on purpose. */
  overridden: boolean;
}

const PRODUCTION_HOST_SUFFIXES = ['.supabase.co', '.supabase.com'];

function hostOf(url: string | undefined): string | null {
  if (!url || !url.trim()) return null;
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return '(unreadable)';
  }
}

function describeDb(url: string | undefined): string {
  if (!url || !url.trim()) return 'not set';
  try {
    const u = new URL(url.trim());
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unreadable)';
  }
}

const isProductionHost = (host: string | null): boolean =>
  !!host && (host === '(unreadable)' || PRODUCTION_HOST_SUFFIXES.some((s) => host.endsWith(s)));

export function checkLocalIsolation(env: NodeJS.ProcessEnv = process.env): IsolationReport {
  // Render sets RENDER=true on every service it runs. A server on Render is never a developer's machine, so the guard never
  // stops it, even if its start command does not set NODE_ENV (e.g. a plain `npm start`).
  const onRender = !!(env['RENDER'] ?? '').trim();
  const isProduction = onRender || (env['NODE_ENV'] ?? '').trim().toLowerCase() === 'production';
  const overridden = (env['ALLOW_PRODUCTION_DB'] ?? '').trim() === '1';

  const storageBackend = (env['STORAGE_BACKEND'] ?? 'supabase').trim().toLowerCase();
  const supabaseHost = hostOf(env['SUPABASE_URL']);
  const supabaseStorageOn = storageBackend !== 's3' && !!supabaseHost && !!(env['SUPABASE_SERVICE_KEY'] ?? '').trim();
  const s3On = storageBackend === 's3' && !!(env['S3_BUCKET'] ?? '').trim();
  const storage = s3On ? `s3 bucket ${env['S3_BUCKET']}` : supabaseStorageOn ? `supabase ${supabaseHost}` : 'local disk';

  const summary = `database ${describeDb(env['DATABASE_URL'])}, file storage ${storage}`;
  if (isProduction) return { ok: true, problems: [], summary, overridden: false };

  const problems: string[] = [];
  for (const name of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const host = hostOf(env[name]);
    if (isProductionHost(host)) problems.push(`${name} points at ${host}`);
  }
  if (supabaseStorageOn && isProductionHost(supabaseHost)) problems.push(`file storage is Supabase ${supabaseHost}`);
  if (s3On) problems.push(`file storage is the S3 bucket ${env['S3_BUCKET']}`);

  return { ok: overridden || problems.length === 0, problems, summary, overridden: overridden && problems.length > 0 };
}
