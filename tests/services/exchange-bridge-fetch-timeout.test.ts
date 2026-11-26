/**
 * Phase 7 — Hub -> Exchange fetch calls previously had no timeout at all.
 * If Exchange accepted the TCP connection but never responded (a hung
 * process, not a cleanly-down one), the awaiting Hub request would hang
 * indefinitely — the existing try/catch + "unavailable" fallback in
 * exchange-bridge.service.ts does not help here, since nothing throws until
 * something actually rejects.
 *
 * This proves the fix end-to-end with a real (not mocked) AbortSignal: a
 * mocked `fetch` that only ever settles when its `signal` fires abort, wired
 * through a deliberately tiny EXCHANGE_BRIDGE_TIMEOUT_MS, confirms the call
 * actually bounds in real time rather than hanging forever, and that the
 * existing graceful-degradation fallback still fires afterward.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(async () => ({ id: 'user-1', shortId: 'ALICE001' })),
    },
  },
}));

jest.mock('../../src/config', () => {
  const actual = jest.requireActual('../../src/config') as { config: Record<string, unknown> };
  return {
    ...actual,
    config: {
      ...actual.config,
      exchange: { ...(actual.config.exchange as Record<string, unknown>), apiUrl: 'http://exchange.invalid', bridgeSecret: 'test-secret' },
    },
  };
});

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, EXCHANGE_BRIDGE_TIMEOUT_MS: '50' };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
});

describe('exchange-bridge.service.ts — fetch timeout (Phase 7)', () => {
  test('a hung Exchange response does not hang the caller — bounded by EXCHANGE_BRIDGE_TIMEOUT_MS, not indefinite', async () => {
    let sawSignal: AbortSignal | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = jest.fn((_url: any, init: any) => {
      sawSignal = init?.signal;
      // Simulates a hung downstream: the promise only ever settles if the
      // signal aborts — a real server that never responds would behave
      // identically from the caller's perspective.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'TimeoutError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const { exchangeBridgeService } = await import('../../src/services/exchange/exchange-bridge.service');

    const start = Date.now();
    const result = await exchangeBridgeService.getExchangeMarketplaceRole('user-1');
    const elapsedMs = Date.now() - start;

    expect(sawSignal).toBeInstanceOf(AbortSignal);
    expect(elapsedMs).toBeLessThan(2000); // bounded by the 50ms timeout, not hanging forever
    expect(result.unavailable).toBe(true); // existing graceful-degradation fallback still fires
  });

  test('a normal, fast Exchange response is unaffected by the timeout', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = jest.fn(async (_url: any, _init: any) => ({
      ok: true,
      status: 200,
      json: async () => ({ role: 'CREATOR', exchange_role: 'seller', can_list: true, can_purchase: true }),
    })) as unknown as typeof fetch;

    const { exchangeBridgeService } = await import('../../src/services/exchange/exchange-bridge.service');
    const result = await exchangeBridgeService.getExchangeMarketplaceRole('user-1');

    expect(result.unavailable).toBeFalsy();
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
