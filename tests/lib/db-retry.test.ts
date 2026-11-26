/**
 * Phase 7 — failure-injection coverage for the database retry/transient-error
 * classifier (src/lib/db-retry.ts). No real database is used: `isTransientDbError`
 * and `withReadRetry` are pure functions over an error object and an injectable
 * `run`/`sleep`, so a real connection-refused/timeout scenario can be simulated
 * exactly by constructing the same error shape Prisma would produce, without any
 * real network or database dependency — a safe, fast, deterministic chaos test.
 */
import { describe, test, expect, jest } from '@jest/globals';
import { isTransientDbError, withReadRetry, DB_RETRY_DELAY_MS } from '../../src/lib/db-retry';

function prismaError(code: string, message = 'error'): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe('isTransientDbError — classification', () => {
  test.each(['P1001', 'P1002', 'P1008', 'P1017'])('treats Prisma code %s as transient', (code) => {
    expect(isTransientDbError(prismaError(code))).toBe(true);
  });

  test('treats "Can\'t reach database server" (connection refused) as transient', () => {
    expect(isTransientDbError(new Error("Can't reach database server at db:5432"))).toBe(true);
  });

  test('treats a server-closed-connection message as transient', () => {
    expect(isTransientDbError(new Error('Server has closed the connection unexpectedly'))).toBe(true);
  });

  test('does not treat a unique-constraint violation as transient', () => {
    expect(isTransientDbError(prismaError('P2002', 'Unique constraint failed'))).toBe(false);
  });

  test('does not treat a generic application error as transient', () => {
    expect(isTransientDbError(new Error('Vault record not found'))).toBe(false);
  });
});

describe('withReadRetry — Database connection refused (chaos scenario #1)', () => {
  test('a read that fails once with a transient error succeeds on the single retry', async () => {
    let attempts = 0;
    const run = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw prismaError('P1001', "Can't reach database server");
      return 'recovered';
    });
    const sleep = jest.fn(async () => undefined);

    const result = await withReadRetry({ action: 'findUnique' }, run, sleep);

    expect(result).toBe('recovered');
    expect(run).toHaveBeenCalledTimes(2); // original attempt + exactly one retry
    expect(sleep).toHaveBeenCalledWith(DB_RETRY_DELAY_MS);
  });

  test('a read that fails twice with a transient error throws after the single retry — no retry storm', async () => {
    const run = jest.fn(async () => {
      throw prismaError('P1001', "Can't reach database server");
    });
    const sleep = jest.fn(async () => undefined);

    await expect(withReadRetry({ action: 'findMany' }, run, sleep)).rejects.toThrow("Can't reach database server");
    expect(run).toHaveBeenCalledTimes(2); // bounded — never more than one retry
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('withReadRetry — Database query timeout (chaos scenario #2)', () => {
  test('a statement-timeout-style error on a read is retried once', async () => {
    let attempts = 0;
    const run = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw prismaError('P1008', 'Operations timed out');
      return 'ok-after-timeout';
    });

    const result = await withReadRetry({ action: 'count' }, run, async () => undefined);
    expect(result).toBe('ok-after-timeout');
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('withReadRetry — writes are never retried', () => {
  test('a write action that fails with a transient error is not retried, even though the error itself qualifies', async () => {
    const run = jest.fn(async () => {
      throw prismaError('P1001', "Can't reach database server");
    });

    await expect(withReadRetry({ action: 'create' }, run)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1); // never retried — a half-completed write must never be sent twice
  });

  test('an action already inside an open transaction is not retried, even for a transient error', async () => {
    const run = jest.fn(async () => {
      throw prismaError('P1001', "Can't reach database server");
    });

    await expect(withReadRetry({ action: 'findMany', runInTransaction: true }, run)).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1); // retrying inside a dead transaction cannot help
  });

  test('a non-transient error on a read is not retried', async () => {
    const run = jest.fn(async () => {
      throw new Error('Vault record not found');
    });

    await expect(withReadRetry({ action: 'findFirst' }, run)).rejects.toThrow('Vault record not found');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
