/**
 * PGAP-33 regression: GET /exchange/monitoring-summaries-bridge used to trust
 * a plain ?pinitId= query parameter once X-PinIT-Bridge-Secret checked out.
 * The bridge secret only proves "this caller is Exchange" — Exchange holds
 * it as its own static service credential, so it says nothing about which
 * end-user the call is on behalf of. Anyone who knew (or guessed — Pinit IDs
 * are public) a pinit_id could read that tenant's investigation/monitoring
 * feed with no authentication anywhere in the chain.
 *
 * These tests call the real monitoringSummariesBridge controller directly
 * with real headers, exercising the real verifyServiceBridgeSecret and
 * verifyBridgeToken logic (nothing about the security boundary is mocked).
 * Only the Prisma-backed data lookup (getMonitoringSummaries) is mocked, the
 * same way the project's own upload-presign.controller.test.ts mocks only
 * its external data-layer dependencies.
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// config/index.ts force-reads EXCHANGE_BRIDGE_SECRET straight from the real
// .env on disk (separate from dotenv), which would otherwise clobber this
// test's process.env value — same neutralization as exchange-bridge-secret.test.ts.
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('fs', () => {
  const real = jest.requireActual('fs') as typeof import('fs');
  return {
    ...real,
    existsSync: (p: unknown) => (typeof p === 'string' && p.endsWith('.env') ? false : real.existsSync(p as never)),
  };
});

const touchedKeys = ['NODE_ENV', 'EXCHANGE_BRIDGE_SECRET', 'HUB_BRIDGE_SECRET', 'JWT_SECRET', 'DATABASE_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};
const SECRET = 'a-real-random-bridge-secret-min-32-characters!!';

const mockGetMonitoringSummaries = jest.fn().mockResolvedValue({ pinitId: 'PINIT-USER-ALICE', summaries: [] });

beforeEach(() => {
  for (const k of touchedKeys) savedEnv[k] = process.env[k];
  process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
  process.env['EXCHANGE_BRIDGE_SECRET'] = SECRET;
  delete process.env['HUB_BRIDGE_SECRET'];
  delete process.env['JWT_SECRET'];
  mockGetMonitoringSummaries.mockClear();
  jest.resetModules();
  jest.doMock('../../src/services/exchange/exchange-bridge.service', () => {
    const actual = jest.requireActual('../../src/services/exchange/exchange-bridge.service') as any;
    return {
      ...actual,
      exchangeBridgeService: {
        ...actual.exchangeBridgeService,
        getMonitoringSummaries: (...args: unknown[]) => mockGetMonitoringSummaries(...args),
      },
    };
  });
});

afterEach(() => {
  for (const k of touchedKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.resetModules();
});

function mockReqRes(headers: Record<string, string>, query: Record<string, string> = {}) {
  const req = { headers, query } as unknown as Request;
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, status, json, next };
}

/**
 * Workstream C: signExchangeIdentityToken now signs with `issuer: 'exchange'`
 * and a per-endpoint `audience` ('hub:monitoring-summaries-bridge' here),
 * both enforced by the real verifyBridgeToken call in
 * monitoringSummariesBridge — these defaults mirror a real token for this
 * endpoint; overrides let individual tests mint one for the wrong endpoint
 * or direction.
 */
function identityToken(
  pinitId: string,
  opts: { expiresIn?: string; purpose?: string; secret?: string; issuer?: string; audience?: string } = {},
) {
  const options: jwt.SignOptions = { expiresIn: opts.expiresIn ?? '2m' };
  const issuer = opts.issuer ?? 'exchange';
  const audience = opts.audience ?? 'hub:monitoring-summaries-bridge';
  if (issuer) options.issuer = issuer;
  if (audience) options.audience = audience;
  return jwt.sign({ purpose: opts.purpose ?? 'exchange_identity', pinitId }, opts.secret ?? SECRET, options);
}

async function callController(headers: Record<string, string>, query: Record<string, string> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { monitoringSummariesBridge } = require('../../src/api/controllers/exchange-bridge.controller');
  const { req, res, status, json, next } = mockReqRes(headers, query);
  await monitoringSummariesBridge(req, res, next);
  return { status, json, next };
}

describe('monitoringSummariesBridge — PGAP-33', () => {
  function nextError(next: NextFunction): { statusCode?: number } {
    const calls = (next as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[0][0] as { statusCode?: number };
  }

  test('A — anonymous caller (no bridge secret, no identity token) is rejected', async () => {
    const { status, next } = await callController({}, { pinitId: 'PINIT-USER-ALICE' });
    expect(status).not.toHaveBeenCalledWith(200);
    expect(mockGetMonitoringSummaries).not.toHaveBeenCalled();
    expect(nextError(next).statusCode).toBe(401);
  });

  test('G — bridge secret alone, with no identity token, is rejected', async () => {
    const { status } = await callController(
      { 'x-pinit-bridge-secret': SECRET },
      { pinitId: 'PINIT-USER-ALICE' },
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(mockGetMonitoringSummaries).not.toHaveBeenCalled();
  });

  test('B — valid bridge secret + valid identity token succeeds and uses the verified identity', async () => {
    const { status, json } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE'),
      },
      { pinitId: 'PINIT-USER-ALICE' },
    );
    expect(status).not.toHaveBeenCalledWith(401);
    expect(status).not.toHaveBeenCalledWith(403);
    expect(mockGetMonitoringSummaries).toHaveBeenCalledWith('PINIT-USER-ALICE');
    expect(json).toHaveBeenCalled();
  });

  test('F — valid bridge secret + valid identity token, no query param, still succeeds', async () => {
    const { status } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-BOB'),
      },
      {},
    );
    expect(status).not.toHaveBeenCalledWith(401);
    expect(status).not.toHaveBeenCalledWith(403);
    expect(mockGetMonitoringSummaries).toHaveBeenCalledWith('PINIT-USER-BOB');
  });

  test('C — cross-tenant parameter manipulation is rejected, not silently honoured', async () => {
    const { status } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE'),
      },
      { pinitId: 'PINIT-USER-BOB' },
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(mockGetMonitoringSummaries).not.toHaveBeenCalled();
  });

  test('E — a forged identity token (wrong secret) is rejected', async () => {
    const forged = identityToken('PINIT-USER-ALICE', { secret: 'totally-wrong-secret-not-configured' });
    const { next } = await callController(
      { 'x-pinit-bridge-secret': SECRET, 'x-pinit-identity-token': forged },
      { pinitId: 'PINIT-USER-ALICE' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetMonitoringSummaries).not.toHaveBeenCalled();
  });

  test('a token signed for the wrong purpose is rejected', async () => {
    const wrongPurpose = identityToken('PINIT-USER-ALICE', { purpose: 'exchange_sso' });
    const { next } = await callController(
      { 'x-pinit-bridge-secret': SECRET, 'x-pinit-identity-token': wrongPurpose },
      { pinitId: 'PINIT-USER-ALICE' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetMonitoringSummaries).not.toHaveBeenCalled();
  });

  test('F2 — an expired identity token is rejected', async () => {
    const expired = identityToken('PINIT-USER-ALICE', { expiresIn: '-1s' });
    const { next } = await callController(
      { 'x-pinit-bridge-secret': SECRET, 'x-pinit-identity-token': expired },
      { pinitId: 'PINIT-USER-ALICE' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetMonitoringSummaries).not.toHaveBeenCalled();
  });

  test('a wrong bridge secret entirely is rejected before the identity token is even checked', async () => {
    const { next } = await callController(
      {
        'x-pinit-bridge-secret': 'not-the-real-secret',
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE'),
      },
      { pinitId: 'PINIT-USER-ALICE' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetMonitoringSummaries).not.toHaveBeenCalled();
  });

  test('H — a token with the wrong audience (minted for a different Hub endpoint) is rejected', async () => {
    const { next } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE', { audience: 'hub:protect-upload' }),
      },
      { pinitId: 'PINIT-USER-ALICE' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetMonitoringSummaries).not.toHaveBeenCalled();
  });

  test('I — a token with the wrong issuer (as if minted by Hub for itself) is rejected', async () => {
    const { next } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE', { issuer: 'hub' }),
      },
      { pinitId: 'PINIT-USER-ALICE' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetMonitoringSummaries).not.toHaveBeenCalled();
  });
});
