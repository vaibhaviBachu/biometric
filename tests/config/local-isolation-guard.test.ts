/**
 * A local server must not use the production database or file storage (2026-11-16: a local Trace wrote into production).
 */
import { describe, test, expect } from '@jest/globals';
import { checkLocalIsolation } from '../../src/config/local-isolation-guard';

const PROD_DB = 'postgresql://postgres.abc:secret@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';
const LOCAL_DB = 'postgresql://pinit:pinit@localhost:5441/pinit_hub';
const PROD_STORAGE = { SUPABASE_URL: 'https://abcdefgh.supabase.co', SUPABASE_SERVICE_KEY: 'key' };

describe('checkLocalIsolation', () => {
  test('production itself is never stopped', () => {
    const r = checkLocalIsolation({ NODE_ENV: 'production', DATABASE_URL: PROD_DB, DIRECT_URL: PROD_DB, ...PROD_STORAGE });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  test('a local run against the production database and storage is refused, naming each one', () => {
    const r = checkLocalIsolation({ NODE_ENV: 'development', DATABASE_URL: PROD_DB, DIRECT_URL: PROD_DB, ...PROD_STORAGE });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'DATABASE_URL points at aws-1-ap-southeast-1.pooler.supabase.com',
      'DIRECT_URL points at aws-1-ap-southeast-1.pooler.supabase.com',
      'file storage is Supabase abcdefgh.supabase.co',
    ]);
    expect(r.summary).not.toContain('secret');
  });

  test('a service on Render is never stopped, even when its start command does not set NODE_ENV', () => {
    const r = checkLocalIsolation({ RENDER: 'true', DATABASE_URL: PROD_DB, DIRECT_URL: PROD_DB, ...PROD_STORAGE });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  test('NODE_ENV unset counts as local', () => {
    expect(checkLocalIsolation({ DATABASE_URL: PROD_DB }).ok).toBe(false);
  });

  test('a local database alone is not enough while files still go to production storage', () => {
    const r = checkLocalIsolation({ DATABASE_URL: LOCAL_DB, DIRECT_URL: LOCAL_DB, ...PROD_STORAGE });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['file storage is Supabase abcdefgh.supabase.co']);
  });

  test('a production S3 bucket counts as production storage', () => {
    const r = checkLocalIsolation({ DATABASE_URL: LOCAL_DB, STORAGE_BACKEND: 's3', S3_BUCKET: 'pinit-vault' });
    expect(r.ok).toBe(false);
  });

  test('local database and local disk storage: allowed, and the log line says so', () => {
    const r = checkLocalIsolation({ DATABASE_URL: LOCAL_DB, DIRECT_URL: LOCAL_DB, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '' });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('database localhost:5441/pinit_hub, file storage local disk');
  });

  test('an unreadable database URL is treated as production (refused, not guessed safe)', () => {
    expect(checkLocalIsolation({ DATABASE_URL: 'not a url' }).ok).toBe(false);
  });

  test('ALLOW_PRODUCTION_DB=1 lets one run through, and says it is production', () => {
    const r = checkLocalIsolation({ DATABASE_URL: PROD_DB, ALLOW_PRODUCTION_DB: '1', ...PROD_STORAGE });
    expect(r.ok).toBe(true);
    expect(r.overridden).toBe(true);
  });
});
