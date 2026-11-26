/**
 * Workstream B regression: POST /exchange/protect-upload used to trust a
 * plain req.body.pinitId once X-PinIT-Bridge-Secret checked out. The bridge
 * secret only proves "this caller is Exchange" — it says nothing about which
 * tenant the upload is for, and Hub's own service layer
 * (protectUploadForExchange -> getListableAssetsByPinitId) resolved that
 * claimed pinitId straight to an ownerUserId with no independent check.
 * Anyone who could reach Exchange's /protect-upload as any signed-in seller
 * could have Hub silently protect a file into an arbitrary other tenant's
 * vault.
 *
 * These tests call the real protectUploadBridge controller directly with
 * real headers, exercising the real verifyServiceBridgeSecret and
 * verifyBridgeToken logic unmocked. Only the Prisma/vault-touching service
 * layer (protectUploadForExchange) is mocked, the same pattern used by
 * exchange-listable-assets-identity.test.ts and
 * exchange-monitoring-identity.test.ts for the sibling PGAP-33/34 fixes.
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
jest.mock('fs/promises', () => {
  const real = jest.requireActual('fs/promises') as typeof import('fs/promises');
  return { ...real, readFile: jest.fn().mockResolvedValue(Buffer.from('')), unlink: jest.fn().mockResolvedValue(undefined) };
});

const touchedKeys = ['NODE_ENV', 'EXCHANGE_BRIDGE_SECRET', 'HUB_BRIDGE_SECRET', 'JWT_SECRET', 'DATABASE_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};
const SECRET = 'a-real-random-bridge-secret-min-32-characters!!';

const mockProtectUploadForExchange = jest.fn().mockResolvedValue({
  id: 'asset-1',
  vaultId: 'vault-1',
  dnaRecordId: 'dna-1',
  pinit_id: 'PINIT-USER-ALICE001',
  title: 'upload.bin',
});

beforeEach(() => {
  for (const k of touchedKeys) savedEnv[k] = process.env[k];
  process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
  process.env['EXCHANGE_BRIDGE_SECRET'] = SECRET;
  delete process.env['HUB_BRIDGE_SECRET'];
  delete process.env['JWT_SECRET'];
  mockProtectUploadForExchange.mockClear();
  jest.resetModules();
  jest.doMock('../../src/services/exchange/exchange-bridge.service', () => {
    const actual = jest.requireActual('../../src/services/exchange/exchange-bridge.service') as any;
    return {
      ...actual,
      exchangeBridgeService: {
        ...actual.exchangeBridgeService,
        protectUploadForExchange: (...args: unknown[]) => mockProtectUploadForExchange(...args),
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

const DEFAULT_FILE = { buffer: Buffer.from('fake-file-bytes'), originalname: 'upload.bin', mimetype: 'application/octet-stream', size: 16, path: '' };

function mockReqRes(
  headers: Record<string, string>,
  body: Record<string, string> = {},
  file: Record<string, unknown> | null = DEFAULT_FILE,
) {
  const req = { headers, body, file: file === null ? undefined : file } as unknown as Request;
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, status, json, next };
}

/**
 * Workstream C: signExchangeIdentityToken now signs with `issuer: 'exchange'`
 * and a per-endpoint `audience` ('hub:protect-upload' here), both enforced
 * by the real verifyBridgeToken call in protectUploadBridge — these
 * defaults mirror a real token for this endpoint; overrides let individual
 * tests mint one for the wrong endpoint or direction.
 */
function identityToken(
  pinitId: string,
  opts: { expiresIn?: string; purpose?: string; secret?: string; issuer?: string; audience?: string } = {},
) {
  const options: jwt.SignOptions = { expiresIn: opts.expiresIn ?? '2m' };
  const issuer = opts.issuer ?? 'exchange';
  const audience = opts.audience ?? 'hub:protect-upload';
  if (issuer) options.issuer = issuer;
  if (audience) options.audience = audience;
  return jwt.sign({ purpose: opts.purpose ?? 'exchange_identity', pinitId }, opts.secret ?? SECRET, options);
}

async function callController(
  headers: Record<string, string>,
  body: Record<string, string> = {},
  file: Record<string, unknown> | null = DEFAULT_FILE,
) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { protectUploadBridge } = require('../../src/api/controllers/exchange-bridge.controller');
  const { req, res, status, json, next } = mockReqRes(headers, body, file);
  await protectUploadBridge(req, res, next);
  return { status, json, next };
}

function nextError(next: NextFunction): { statusCode?: number } {
  const calls = (next as jest.Mock).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0][0] as { statusCode?: number };
}

describe('protectUploadBridge — Workstream B (protect-upload)', () => {
  test('A — anonymous caller (no bridge secret, no identity token) is rejected', async () => {
    const { next } = await callController({}, { pinitId: 'PINIT-USER-ALICE001' });
    expect(nextError(next).statusCode).toBe(401);
    expect(mockProtectUploadForExchange).not.toHaveBeenCalled();
  });

  test('B — bridge secret alone, with no identity token, is rejected', async () => {
    const { status } = await callController(
      { 'x-pinit-bridge-secret': SECRET },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(mockProtectUploadForExchange).not.toHaveBeenCalled();
  });

  test('C — forged identity token (wrong secret) is rejected', async () => {
    const { next } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001', { secret: 'a-completely-wrong-secret-value!' }),
      },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockProtectUploadForExchange).not.toHaveBeenCalled();
  });

  test('D — expired identity token is rejected', async () => {
    const expired = jwt.sign(
      { purpose: 'exchange_identity', pinitId: 'PINIT-USER-ALICE001' },
      SECRET,
      { expiresIn: '-10s', issuer: 'exchange', audience: 'hub:protect-upload' },
    );
    const { next } = await callController(
      { 'x-pinit-bridge-secret': SECRET, 'x-pinit-identity-token': expired },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockProtectUploadForExchange).not.toHaveBeenCalled();
  });

  test('E — wrong-purpose token is rejected', async () => {
    const wrongPurpose = identityToken('PINIT-USER-ALICE001', { purpose: 'something_else' });
    const { next } = await callController(
      { 'x-pinit-bridge-secret': SECRET, 'x-pinit-identity-token': wrongPurpose },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockProtectUploadForExchange).not.toHaveBeenCalled();
  });

  test('F — Tenant A authenticated, body claims Tenant B: rejected, not silently honoured', async () => {
    const { status } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001'),
      },
      { pinitId: 'PINIT-USER-BOB00456' },
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(mockProtectUploadForExchange).not.toHaveBeenCalled();
  });

  test('G — missing file upload is rejected before any service call', async () => {
    const { status } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001'),
      },
      { pinitId: 'PINIT-USER-ALICE001' },
      null,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(mockProtectUploadForExchange).not.toHaveBeenCalled();
  });

  test('H — valid bridge secret + valid identity token + matching claim succeeds, using the verified identity', async () => {
    const { status, json } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001'),
      },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(status).not.toHaveBeenCalledWith(401);
    expect(status).not.toHaveBeenCalledWith(403);
    expect(mockProtectUploadForExchange).toHaveBeenCalledWith(
      expect.objectContaining({ pinitId: 'PINIT-USER-ALICE001' }),
    );
    expect(json).toHaveBeenCalled();
  });

  test('I — valid identity token with no claimed pinitId in the body at all still succeeds, bound to the verified identity', async () => {
    const { status } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001'),
      },
      {},
    );
    expect(status).not.toHaveBeenCalledWith(401);
    expect(status).not.toHaveBeenCalledWith(403);
    expect(mockProtectUploadForExchange).toHaveBeenCalledWith(
      expect.objectContaining({ pinitId: 'PINIT-USER-ALICE001' }),
    );
  });

  test('J — missing tenant identity (empty pinitId inside an otherwise well-formed token) is rejected', async () => {
    const emptyIdentity = jwt.sign(
      { purpose: 'exchange_identity', pinitId: '' },
      SECRET,
      { expiresIn: '2m', issuer: 'exchange', audience: 'hub:protect-upload' },
    );
    const { status } = await callController(
      { 'x-pinit-bridge-secret': SECRET, 'x-pinit-identity-token': emptyIdentity },
      {},
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(mockProtectUploadForExchange).not.toHaveBeenCalled();
  });

  test('K — a token with the wrong audience (minted for a different Hub endpoint) is rejected', async () => {
    const { next } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001', { audience: 'hub:listable-assets-bridge' }),
      },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockProtectUploadForExchange).not.toHaveBeenCalled();
  });

  test('L — a token with the wrong issuer (as if minted by Hub for itself) is rejected', async () => {
    const { next } = await callController(
      {
        'x-pinit-bridge-secret': SECRET,
        'x-pinit-identity-token': identityToken('PINIT-USER-ALICE001', { issuer: 'hub' }),
      },
      { pinitId: 'PINIT-USER-ALICE001' },
    );
    expect(nextError(next).statusCode).toBe(401);
    expect(mockProtectUploadForExchange).not.toHaveBeenCalled();
  });
});
