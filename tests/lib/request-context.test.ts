/**
 * PGAP-11 — request-context.ts unit contract: the validation policy, ID
 * generation, and AsyncLocalStorage isolation that request-id.middleware.ts
 * and the cron-job wrapping in vault-scheduler.service.ts both depend on.
 */
import { describe, test, expect } from '@jest/globals';
import {
  isValidRequestId,
  generateRequestId,
  getRequestId,
  runWithRequestContext,
} from '../../src/lib/request-context';

describe('isValidRequestId', () => {
  test.each([
    ['a-normal-uuid-like-id-123', true],
    ['ABC.def_123-456', true],
    ['a', true],
    ['a'.repeat(128), true],
    ['', false],
    ['a'.repeat(129), false],
    ['has a space', false],
    ['has\na\nnewline', false],
    ['has\ta\ttab', false],
    ['semi;colon', false],
    [undefined, false],
    [null, false],
    [123, false],
    [{}, false],
  ])('%j -> %s', (value, expected) => {
    expect(isValidRequestId(value)).toBe(expected);
  });
});

describe('generateRequestId', () => {
  test('produces a well-formed UUID', () => {
    const id = generateRequestId();
    expect(isValidRequestId(id)).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('produces a different value on each call', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateRequestId()));
    expect(ids.size).toBe(20);
  });
});

describe('runWithRequestContext / getRequestId', () => {
  test('getRequestId returns undefined outside any context', () => {
    expect(getRequestId()).toBeUndefined();
  });

  test('getRequestId returns the ID set for the current context', () => {
    runWithRequestContext({ requestId: 'ctx-a' }, () => {
      expect(getRequestId()).toBe('ctx-a');
    });
  });

  test('getRequestId is undefined again after the context exits', () => {
    runWithRequestContext({ requestId: 'ctx-b' }, () => {
      expect(getRequestId()).toBe('ctx-b');
    });
    expect(getRequestId()).toBeUndefined();
  });

  test('concurrent async contexts do not leak into each other', async () => {
    const results: string[] = [];
    await Promise.all([
      runWithRequestContext({ requestId: 'concurrent-1' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(getRequestId() as string);
      }),
      runWithRequestContext({ requestId: 'concurrent-2' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(getRequestId() as string);
      }),
    ]);
    expect(results.sort()).toEqual(['concurrent-1', 'concurrent-2']);
  });

  test('nested contexts restore the outer ID on exit', () => {
    runWithRequestContext({ requestId: 'outer' }, () => {
      expect(getRequestId()).toBe('outer');
      runWithRequestContext({ requestId: 'inner' }, () => {
        expect(getRequestId()).toBe('inner');
      });
      expect(getRequestId()).toBe('outer');
    });
  });
});
