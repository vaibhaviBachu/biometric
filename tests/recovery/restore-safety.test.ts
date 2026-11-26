import { describe, test, expect } from '@jest/globals';
import { classifyRestoreTarget, assertSafeRestoreTarget, ProductionTargetRejectedError } from '../../src/lib/recovery/restore-safety';

describe('restore-safety — classifyRestoreTarget', () => {
  test('a real Supabase pooler host is always production-like', () => {
    const result = classifyRestoreTarget(
      'postgresql://postgres.kqdqmimdqecensurjplh:secret@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres',
    );
    expect(result.classification).toBe('production-like');
  });

  test('a direct *.supabase.co host is production-like', () => {
    expect(classifyRestoreTarget('https://kqdqmimdqecensurjplh.supabase.co').classification).toBe('production-like');
  });

  test('an onrender.com host is production-like', () => {
    expect(classifyRestoreTarget('postgresql://user:pw@some-db.onrender.com:5432/db').classification).toBe('production-like');
  });

  test('localhost with any port is local-safe', () => {
    expect(classifyRestoreTarget('postgresql://pinit:pinit@localhost:5436/pinit_hub_restored').classification).toBe('local-safe');
  });

  test('127.0.0.1 is local-safe', () => {
    expect(classifyRestoreTarget('postgresql://pinit:pinit@127.0.0.1:5435/pinit_hub').classification).toBe('local-safe');
  });

  test('an unrecognized host is unknown, not silently trusted', () => {
    expect(classifyRestoreTarget('postgresql://user:pw@some-random-host.example.net:5432/db').classification).toBe('unknown');
  });

  test('a malformed string is still classified, not thrown from', () => {
    expect(() => classifyRestoreTarget('not a url at all')).not.toThrow();
  });
});

describe('restore-safety — assertSafeRestoreTarget', () => {
  test('throws for a production-like target even with explicit confirmation', () => {
    expect(() =>
      assertSafeRestoreTarget('https://kqdqmimdqecensurjplh.supabase.co', { explicitlyConfirmedNonProduction: true }),
    ).toThrow(ProductionTargetRejectedError);
  });

  test('throws for an unknown target without explicit confirmation', () => {
    expect(() => assertSafeRestoreTarget('postgresql://user:pw@mystery-host:5432/db')).toThrow(ProductionTargetRejectedError);
  });

  test('passes an unknown target through when explicitly confirmed', () => {
    expect(() =>
      assertSafeRestoreTarget('postgresql://user:pw@mystery-host:5432/db', { explicitlyConfirmedNonProduction: true }),
    ).not.toThrow();
  });

  test('passes a local-safe target with no confirmation required', () => {
    expect(() => assertSafeRestoreTarget('postgresql://pinit:pinit@localhost:5436/pinit_hub_restored')).not.toThrow();
  });
});
