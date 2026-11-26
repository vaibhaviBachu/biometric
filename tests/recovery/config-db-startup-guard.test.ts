/**
 * Phase 10 — DR9-ENV-01. Proves `src/config/index.ts` itself warns (and can
 * be made to fail closed) when DATABASE_URL classifies as production-like
 * while NODE_ENV is not 'production' — the in-app layer of defense,
 * complementing the npm-script-level gate (`scripts/guard-db-target.cjs`)
 * and the test-environment sentinel (`jest.env.setup.ts`).
 *
 * Each case re-requires `src/config` in an isolated module registry so the
 * module-level evaluation (where the check runs) happens fresh every time,
 * with a controlled NODE_ENV/DATABASE_URL combination.
 */
import { describe, test, expect, jest, afterEach } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };
const PRODUCTION_LIKE_URL = 'postgresql://u:p@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';
const LOCAL_SAFE_URL = 'postgresql://pinit:pinit@localhost:5435/pinit_hub';

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env['FAIL_ON_NONLOCAL_DB_IN_DEV'];
  jest.resetModules();
});

describe('src/config — DR9-ENV-01 startup guard', () => {
  test('production-like DATABASE_URL + NODE_ENV=development -> warns loudly, does NOT throw by default', () => {
    process.env['NODE_ENV'] = 'development';
    process.env['DATABASE_URL'] = PRODUCTION_LIKE_URL;
    delete process.env['FAIL_ON_NONLOCAL_DB_IN_DEV'];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.resetModules();
    expect(() => require('../../src/config')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL points at a production-like host'));
    warnSpy.mockRestore();
  });

  test('production-like DATABASE_URL + NODE_ENV=development + FAIL_ON_NONLOCAL_DB_IN_DEV=true -> throws, refuses to start', () => {
    process.env['NODE_ENV'] = 'development';
    process.env['DATABASE_URL'] = PRODUCTION_LIKE_URL;
    process.env['FAIL_ON_NONLOCAL_DB_IN_DEV'] = 'true';

    jest.resetModules();
    expect(() => require('../../src/config')).toThrow(/REFUSING TO START/);
  });

  test('local-safe DATABASE_URL + NODE_ENV=development -> no warning, no throw', () => {
    process.env['NODE_ENV'] = 'development';
    process.env['DATABASE_URL'] = LOCAL_SAFE_URL;
    delete process.env['FAIL_ON_NONLOCAL_DB_IN_DEV'];

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.resetModules();
    expect(() => require('../../src/config')).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('production-like host'));
    warnSpy.mockRestore();
  });

  test('production-like DATABASE_URL + NODE_ENV=production -> no warning, no throw (production IS the correct target there)', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DATABASE_URL'] = PRODUCTION_LIKE_URL;
    process.env['FAIL_ON_NONLOCAL_DB_IN_DEV'] = 'true'; // even with the strict flag set, production itself must not be blocked

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.resetModules();
    expect(() => require('../../src/config')).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('production-like host'));
    warnSpy.mockRestore();
  });

  test('production-like DATABASE_URL + NODE_ENV=test -> no warning, no throw (test environment is separately isolated by jest.env.setup.ts)', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = PRODUCTION_LIKE_URL;
    process.env['FAIL_ON_NONLOCAL_DB_IN_DEV'] = 'true';

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.resetModules();
    expect(() => require('../../src/config')).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('production-like host'));
    warnSpy.mockRestore();
  });
});
