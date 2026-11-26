/**
 * Imported FIRST by src/server.ts, so it runs before the app and everything it loads (nothing has touched the database yet).
 * Reads .env the same way src/config does (values already set in the shell win), then stops the start-up when a local server
 * would use production. See local-isolation-guard.ts.
 */
import dotenv from 'dotenv';
import { checkLocalIsolation } from './local-isolation-guard';

dotenv.config();

const report = checkLocalIsolation(process.env);
if (!report.ok) {
  // eslint-disable-next-line no-console
  console.error([
    '',
    '  [Isolation] Refusing to start: this is not production, but it would use production data.',
    ...report.problems.map((p) => `    - ${p}`),
    '  Point DATABASE_URL / DIRECT_URL at a local database and leave SUPABASE_URL / SUPABASE_SERVICE_KEY empty',
    '  (files then go to local disk). To use production on purpose for one run, set ALLOW_PRODUCTION_DB=1.',
    '',
  ].join('\n'));
  process.exit(1);
}
// eslint-disable-next-line no-console
console.info(`[Isolation] ${report.summary}${report.overridden ? ' — PRODUCTION allowed by ALLOW_PRODUCTION_DB=1' : ''}`);
