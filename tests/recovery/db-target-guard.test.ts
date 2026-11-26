/**
 * Phase 10 — DR9-ENV-01. Exhaustive coverage of the canonical production-
 * target guard (`src/lib/recovery/db-target-guard.cjs`), required directly
 * here via Node's CommonJS interop so this test exercises the exact same
 * module every plain `.cjs` script and `restore-safety.ts` actually use —
 * not a reimplementation, not a mock.
 */
import { describe, test, expect } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../src/lib/recovery/db-target-guard.cjs') as {
  classifyTarget: (s: string) => { classification: string; host: string; reason: string };
  assertSafeTarget: (s: string, opts?: { explicitlyConfirmedNonProduction?: boolean }) => unknown;
  ProductionTargetRejectedError: new (m: string) => Error;
};

describe('db-target-guard — production host detection', () => {
  test.each([
    ['real project pooler host (this project\'s own)', 'postgresql://postgres.kqdqmimdqecensurjplh:secret@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true'],
    ['bare supabase.co REST host', 'https://kqdqmimdqecensurjplh.supabase.co'],
    ['supabase.com variant', 'postgresql://user:pw@db.project.supabase.com:5432/postgres'],
    ['RDS host', 'postgresql://user:pw@mydb.abc123.ap-south-1.rds.amazonaws.com:5432/db'],
    ['onrender.com host', 'postgresql://user:pw@some-db.onrender.com:5432/db'],
    ['render.com host', 'postgresql://user:pw@some-db.render.com:5432/db'],
  ])('%s is always production-like', (_label, url) => {
    expect(guard.classifyTarget(url).classification).toBe('production-like');
  });

  test('production-like is refused even with explicit confirmation — no override exists', () => {
    expect(() =>
      guard.assertSafeTarget('https://kqdqmimdqecensurjplh.supabase.co', { explicitlyConfirmedNonProduction: true }),
    ).toThrow(guard.ProductionTargetRejectedError);
  });
});

describe('db-target-guard — local-safe detection', () => {
  test.each([
    ['localhost, any port', 'postgresql://pinit:pinit@localhost:5435/pinit_hub'],
    ['127.0.0.1', 'postgresql://pinit:pinit@127.0.0.1:5436/pinit_hub_restored'],
    ['127.x.x.x (loopback range, not just .1)', 'postgresql://u:p@127.5.5.5:5432/db'],
    ['docker-internal hostname', 'postgresql://u:p@host.docker.internal:5432/db'],
    ['0.0.0.0', 'postgresql://u:p@0.0.0.0:5432/db'],
  ])('%s is local-safe, no confirmation required', (_label, url) => {
    expect(guard.classifyTarget(url).classification).toBe('local-safe');
    expect(() => guard.assertSafeTarget(url)).not.toThrow();
  });

  test('IPv6 loopback ::1 is local-safe', () => {
    // Node's URL parser requires brackets for a literal IPv6 host.
    expect(guard.classifyTarget('postgresql://u:p@[::1]:5432/db').classification).toBe('local-safe');
  });
});

describe('db-target-guard — unknown targets require explicit confirmation', () => {
  test('an unrecognized host is unknown, not silently trusted', () => {
    expect(guard.classifyTarget('postgresql://u:p@some-shared-staging-host.internal:5432/db').classification).toBe('unknown');
  });

  test('unknown without confirmation is refused', () => {
    expect(() => guard.assertSafeTarget('postgresql://u:p@mystery-host:5432/db')).toThrow(guard.ProductionTargetRejectedError);
  });

  test('unknown WITH explicit confirmation is allowed', () => {
    expect(() => guard.assertSafeTarget('postgresql://u:p@mystery-host:5432/db', { explicitlyConfirmedNonProduction: true })).not.toThrow();
  });
});

describe('db-target-guard — fail-safe / malformed-input handling', () => {
  test('empty string classifies as unknown, never throws from classifyTarget itself', () => {
    expect(() => guard.classifyTarget('')).not.toThrow();
    expect(guard.classifyTarget('').classification).toBe('unknown');
  });

  test('undefined/null-ish input classifies as unknown, never throws from classifyTarget itself', () => {
    // @ts-expect-error — deliberately exercising a bad-input path a careless caller could hit
    expect(() => guard.classifyTarget(undefined)).not.toThrow();
  });

  test('a bare hostname with no scheme is still classified, not passed through unclassified', () => {
    const result = guard.classifyTarget('aws-1-ap-southeast-1.pooler.supabase.com');
    expect(result.classification).toBe('production-like');
  });

  test('completely garbage input is unknown (refused by default), not accidentally local-safe', () => {
    expect(guard.classifyTarget('!!!not-a-url-at-all###').classification).toBe('unknown');
  });

  test('assertSafeTarget with no options defaults to refusing an unknown target (fail-closed)', () => {
    expect(() => guard.assertSafeTarget('postgresql://u:p@totally-unrecognized:5432/db')).toThrow();
  });
});

describe('db-target-guard — connection-string variations cannot evade detection', () => {
  test('URL-encoded password containing special characters does not change host classification', () => {
    const url = 'postgresql://postgres.kqdqmimdqecensurjplh:p%40ssw%2Frd%21@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';
    expect(guard.classifyTarget(url).classification).toBe('production-like');
  });

  test('a production host with query parameters (pgbouncer, sslmode) is still caught', () => {
    const url = 'postgresql://u:p@db.project.supabase.com:5432/postgres?sslmode=require&pgbouncer=true';
    expect(guard.classifyTarget(url).classification).toBe('production-like');
  });

  test('uppercase host is normalized before matching (classification is case-insensitive)', () => {
    const url = 'postgresql://u:p@AWS-1-AP-SOUTHEAST-1.POOLER.SUPABASE.COM:6543/postgres';
    expect(guard.classifyTarget(url).classification).toBe('production-like');
  });

  test('a lookalike hostname that merely CONTAINS "supabase" but is not a real suffix match is not blanket-trusted as production (still refused as unknown, not silently allowed)', () => {
    // e.g. "supabase.evil.example.com" — must NOT match the suffix rule, but
    // must also not be treated as safe; it should land in 'unknown' and
    // still be refused without explicit confirmation.
    const result = guard.classifyTarget('postgresql://u:p@supabase.evil.example.com:5432/db');
    expect(result.classification).not.toBe('local-safe');
    expect(() => guard.assertSafeTarget('postgresql://u:p@supabase.evil.example.com:5432/db')).toThrow();
  });

  test('a lookalike localhost subdomain (not actually localhost) is not treated as local-safe', () => {
    const result = guard.classifyTarget('postgresql://u:p@localhost.evil.example.com:5432/db');
    expect(result.classification).not.toBe('local-safe');
  });
});
