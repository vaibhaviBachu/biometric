/**
 * PGAP-34 regression: GET /exchange/listable-assets-bridge used to trust a
 * plain ?pinitId= query parameter once X-PinIT-Bridge-Secret checked out.
 * Ownership WAS correctly scoped inside the underlying Prisma query — the
 * gap was upstream of it: the bridge secret only proves "this caller is
 * Exchange", not which tenant the call is for, so anyone holding that one
 * static secret could retrieve any tenant's listable vault-asset set (and,
 * before this fix, the tenant's internal ownerUserId along with it).
 *
 * These tests call the real listExchangeAssetsBridge controller directly
 * with real headers, exercising the real verifyServiceBridgeSecret and
 * verifyBridgeToken logic unmocked. Only the Prisma-backed data lookup
 * (getListableAssetsByPinitId) is mocked, the same pattern used by
 * exchange-monitoring-identity.test.ts for the sibling PGAP-33 fix.
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

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

const mockGetListableAssetsByPinitId = jest.fn().mockResolvedValue({
  pinitId: 'PINIT-USER-ALICE001',
  ownerUserId: 'internal-db-id-should-never-leave-this-mock',
  assets: [],
});

beforeEach(() => {
  for (const k of touchedKeys) savedEnv[k] = process.env[k];
  process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
  process.env['EXCHANGE_BRIDGE_SECRET'] = SECRET;
  delete process.env['HUB_BRIDGE_SECRET'];
  delete process.env['JWT_SECRET'];
  mockGetListableAssetsByPinitId.mockClear();
  jest.resetModules();
  jest.doMock('../../src/services/exchange/exchange-bridge.service', () => {
    const actual = jest.requireActual('../../src/services/exchange/exchange-bridge.service') as any;
    return {
      ...actual,
      exchangeBridgeService: {
        ...actual.exchangeBridgeService,
        getListableAssetsByPinitId: (...args: unknown[]) => mockGetListableAssetsByPinitId(...args),
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
 * and a per-endpoint `audience` ('hub:listable-assets-bridge' here), both
 * enforced by the real verifyBridgeToken call in listExchangeAssetsBridge —
 * so these defaults mirror what a real Exchange-minted token for this
 * specific endpoint looks like, and the `issuer`/`audience` overrides below
 * let individual tests mint a token for the wrong endpoint or direction.
 */
function identityToken(
  pinitId: string,
  opts: { expiresIn?: string; purpose?: string; secret?: string; issuer?: string; audience?: string } = {},
) {
  const options: jwt.SignOptions = { expiresIn: opts.expiresIn ?? '2m' };
  const issuer = opts.issuer ?? 'exchange';
  const audience = opts.audience ?? 'hub:listable-assets-bridge';
  if (issuer) options.issuer = issuer;
  if (audience) options.audience = audience;
  return jwt.sign({ purpose: opts.purpose ?? 'exchange_identity', pinitId }, opts.secret ?? SECRET, options);
}

async function callController(headers: Record<string, string>, query: Record<string, string> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { listExchangeAssetsBridge } = require('../../src/api/controllers/exchange-bridge.controller');
  const { req, res, status, json, next } = mockReqRes(headers, query);
  await listExchangeAssetsBridge(req, res, next);
  return { status, json, next };
}

function nextError(next: NextFunction): { statusCode?: number } {
  const calls = (next as jest.Mock).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0][0] as { statusCode?: number };
}

describe('listExchangeAssetsBridge — PGAP-34', () => {
  test('A — anonymous caller (no bridge secret, no identity token) is rejected', async () => {
    const { next } = await callController({}, { pinitId: 'PINIT-USER-ALICE001' });
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetListableAssetsByPinitId).not.toHaveBeenCalled();
  });

  test('B — bridge secret alone, with no identity token, is rejected', async () => {
    const { status } = await callController(
      { 'x-pinit-bridge-secret': SECRET },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(mockGetListableAssetsByPinitId).not.toHaveBeenCalled();
  });

  test('C — valid bridge secret + valid identity token succeeds, using the verified identity', async () => {
    const { status, json } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001'),
      },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(status).not.toHaveBeenCalledWith(401);
    expect(status).not.toHaveBeenCalledWith(403);
    expect(mockGetListableAssetsByPinitId).toHaveBeenCalledWith('PINIT-USER-ALICE001');
    expect(json).toHaveBeenCalled();
  });

  test('D — cross-tenant identity manipulation is rejected, not silently honoured', async () => {
    const { status } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001'),
      },
      { pinitId: 'PINIT-USER-BOB00456' },
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(mockGetListableAssetsByPinitId).not.toHaveBeenCalled();
  });

  test('prefix-variant pinitIds for the same person are NOT treated as a mismatch', async () => {
    // PINIT-USER-ALICE001 and PINIT-EX-ALICE001 share the same underlying code —
    // extractPinitCode must reconcile them rather than rejecting on raw
    // string inequality.
    const { status } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001'),
      },
      { pinitId: 'PINIT-EX-ALICE001' },
    );
    expect(status).not.toHaveBeenCalledWith(403);
    expect(mockGetListableAssetsByPinitId).toHaveBeenCalledWith('PINIT-USER-ALICE001');
  });

  test('E — missing tenant identity (empty pinitId inside an otherwise well-formed token) is rejected', async () => {
    const emptyIdentity = jwt.sign(
      { purpose: 'exchange_identity', pinitId: '' },
      SECRET,
      { expiresIn: '2m', issuer: 'exchange', audience: 'hub:listable-assets-bridge' },
    );
    const { status } = await callController(
      { 'x-pinit-bridge-secret': SECRET, 'x-pinit-identity-token': emptyIdentity },
      {},
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(mockGetListableAssetsByPinitId).not.toHaveBeenCalled();
  });

  test('H — a token with the wrong audience (minted for a different Hub endpoint) is rejected', async () => {
    const { next } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001', { audience: 'hub:protect-upload' }),
      },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetListableAssetsByPinitId).not.toHaveBeenCalled();
  });

  test('I2 — a token with the wrong issuer (as if minted by Hub for itself) is rejected', async () => {
    const { next } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001', { issuer: 'hub' }),
      },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetListableAssetsByPinitId).not.toHaveBeenCalled();
  });

  test('F — a forged identity token (wrong secret) is rejected', async () => {
    const forged = identityToken('PINIT-USER-ALICE001', { secret: 'totally-wrong-secret-not-configured' });
    const { next } = await callController(
      { 'x-pinit-bridge-secret': SECRET, 'x-pinit-identity-token': forged },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetListableAssetsByPinitId).not.toHaveBeenCalled();
  });

  test('G — an expired identity token is rejected', async () => {
    const expired = identityToken('PINIT-USER-ALICE001', { expiresIn: '-1s' });
    const { next } = await callController(
      { 'x-pinit-bridge-secret': SECRET, 'x-pinit-identity-token': expired },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetListableAssetsByPinitId).not.toHaveBeenCalled();
  });

  test('G2 — a token signed for the wrong purpose is rejected', async () => {
    const wrongPurpose = identityToken('PINIT-USER-ALICE001', { purpose: 'exchange_sso' });
    const { next } = await callController(
      { 'x-pinit-bridge-secret': SECRET, 'x-pinit-identity-token': wrongPurpose },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetListableAssetsByPinitId).not.toHaveBeenCalled();
  });

  test('I — internal ownerUserId is never exposed in the response, even though the data layer returns it', async () => {
    const { json } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001'),
      },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    const body = (json as jest.Mock).mock.calls[0]?.[0];
    expect(body).toBeDefined();
    expect(body.ownerUserId).toBeUndefined();
    expect(mockGetListableAssetsByPinitId).toHaveBeenCalled(); // the mock DOES return ownerUserId; the controller must strip it
  });

  test('a wrong bridge secret entirely is rejected before the identity token is even checked', async () => {
    const { next } = await callController(
      {
        'x-pinit-bridge-secret': 'not-the-real-secret',
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001'),
      },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockGetListableAssetsByPinitId).not.toHaveBeenCalled();
  });
});
