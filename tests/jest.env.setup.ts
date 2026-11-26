/**
 * First of all: tests never get the production database or storage keys. The project's `.env` points at production and is loaded
 * into every run, so the connection is decided here (see tests/helpers/db-guard.ts) before anything can read it. Without a safe
 * TEST_DATABASE_URL the database is an unreachable address: mocked suites are unaffected and database suites are skipped.
 * applyTestDatabaseEnv also sets DATABASE_URL and DIRECT_URL before dotenv can refill them, and blanks the Supabase keys.
 */
import { applyTestDatabaseEnv } from './helpers/db-guard';
applyTestDatabaseEnv();

/**
 * The passkey ("fingerprint") step ships as a placeholder by default
 * (config.webauthn.requirePasskey === false) so the flow works across domains.
 * Tests must still exercise the REAL WebAuthn path — the placeholder is a
 * deployment convenience, not the behaviour we want to regress-protect.
 */
process.env.WEBAUTHN_REQUIRE_PASSKEY = 'true';

/**
 * Jest runs one worker per core-ish; sharp/libvips is multi-threaded on its own, so
 * the two multiply into heavy oversubscription. One libvips thread per worker keeps
 * image-heavy suites fast under parallel runs (production keeps sharp's default).
 */
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('sharp').concurrency(1);
} catch {
  /* sharp not installed in this environment — nothing to tune */
}

/**
 * Worker threads are off in tests by default: most suites mock the code a worker would run, and a worker must not bypass the mock.
 * The tests of the pool and of the work done in workers switch them on for themselves.
 */
process.env.FORENSIC_WORKERS = 'off';
