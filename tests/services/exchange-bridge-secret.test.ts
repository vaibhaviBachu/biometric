/**
 * verifyServiceBridgeSecret() used to unconditionally accept the literal
 * string 'change_me_exchange_bridge_secret_min_32_chars' — the exact
 * placeholder checked into .env.example and this repo's README — regardless
 * of what EXCHANGE_BRIDGE_SECRET was actually configured to. Anyone who read
 * the public repo had a permanent, always-valid credential for every Hub
 * bridge endpoint (listing assets, confirming sales, minting licensed
 * shares, silently protecting files as another Pinit ID). This pins the fix:
 * only the real configured secret is accepted.
 */
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('dotenv', () => ({ config: jest.fn() }));

// config/index.ts also force-reads EXCHANGE_BRIDGE_SECRET straight from the
// real .env on disk (separate from dotenv) — neutralize that read so this
// test's process.env value is the only source of truth.
jest.mock('fs', () => {
  const real = jest.requireActual('fs') as typeof import('fs');
  return {
    ...real,
    existsSync: (p: unknown) => (typeof p === 'string' && p.endsWith('.env') ? false : real.existsSync(p as never)),
  };
});

const touchedKeys = ['NODE_ENV', 'JWT_SECRET', 'EXCHANGE_BRIDGE_SECRET', 'EXCHANGE_BRIDGE_SECRET_PREVIOUS', 'DATABASE_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of touchedKeys) savedEnv[k] = process.env[k];
  process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  for (const k of touchedKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.resetModules();
});

function loadFresh(): { verifyServiceBridgeSecret: (headerValue: string | undefined) => void } {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/services/exchange/exchange-bridge.service');
}

const PUBLIC_PLACEHOLDER = 'change_me_exchange_bridge_secret_min_32_chars';

describe('verifyServiceBridgeSecret', () => {
  test('rejects the public placeholder default even when it is not the configured secret', () => {
    process.env['EXCHANGE_BRIDGE_SECRET'] = 'a-real-random-bridge-secret-not-the-placeholder';
    const { verifyServiceBridgeSecret } = loadFresh();
    expect(() => verifyServiceBridgeSecret(PUBLIC_PLACEHOLDER)).toThrow('Invalid Exchange bridge credentials');
  });

  test('accepts the real configured secret', () => {
    process.env['EXCHANGE_BRIDGE_SECRET'] = 'a-real-random-bridge-secret-not-the-placeholder';
    const { verifyServiceBridgeSecret } = loadFresh();
    expect(() => verifyServiceBridgeSecret('a-real-random-bridge-secret-not-the-placeholder')).not.toThrow();
  });

  test('rejects an empty or missing header', () => {
    process.env['EXCHANGE_BRIDGE_SECRET'] = 'a-real-random-bridge-secret-not-the-placeholder';
    const { verifyServiceBridgeSecret } = loadFresh();
    expect(() => verifyServiceBridgeSecret(undefined)).toThrow('Invalid Exchange bridge credentials');
    expect(() => verifyServiceBridgeSecret('')).toThrow('Invalid Exchange bridge credentials');
  });

  test('rejects any other wrong value', () => {
    process.env['EXCHANGE_BRIDGE_SECRET'] = 'a-real-random-bridge-secret-not-the-placeholder';
    const { verifyServiceBridgeSecret } = loadFresh();
    expect(() => verifyServiceBridgeSecret('totally-wrong-guess')).toThrow('Invalid Exchange bridge credentials');
  });

  test('even with EXCHANGE_BRIDGE_SECRET unset (falls back to JWT_SECRET), the placeholder is still rejected', () => {
    delete process.env['EXCHANGE_BRIDGE_SECRET'];
    process.env['JWT_SECRET'] = 'a-real-random-jwt-secret-not-the-default-value';
    const { verifyServiceBridgeSecret } = loadFresh();
    expect(() => verifyServiceBridgeSecret(PUBLIC_PLACEHOLDER)).toThrow('Invalid Exchange bridge credentials');
    expect(() => verifyServiceBridgeSecret('a-real-random-jwt-secret-not-the-default-value')).not.toThrow();
  });

  describe('Workstream C — key rotation grace period (EXCHANGE_BRIDGE_SECRET_PREVIOUS)', () => {
    test('the current secret is accepted when a previous one is also configured', () => {
      process.env['EXCHANGE_BRIDGE_SECRET'] = 'current-rotated-secret-min-32-characters!!';
      process.env['EXCHANGE_BRIDGE_SECRET_PREVIOUS'] = 'previous-pre-rotation-secret-min-32-chars!!';
      const { verifyServiceBridgeSecret } = loadFresh();
      expect(() => verifyServiceBridgeSecret('current-rotated-secret-min-32-characters!!')).not.toThrow();
    });

    test('the previous secret is still accepted during the grace period', () => {
      process.env['EXCHANGE_BRIDGE_SECRET'] = 'current-rotated-secret-min-32-characters!!';
      process.env['EXCHANGE_BRIDGE_SECRET_PREVIOUS'] = 'previous-pre-rotation-secret-min-32-chars!!';
      const { verifyServiceBridgeSecret } = loadFresh();
      expect(() => verifyServiceBridgeSecret('previous-pre-rotation-secret-min-32-chars!!')).not.toThrow();
    });

    test('a value that is neither the current nor the previous secret is rejected', () => {
      process.env['EXCHANGE_BRIDGE_SECRET'] = 'current-rotated-secret-min-32-characters!!';
      process.env['EXCHANGE_BRIDGE_SECRET_PREVIOUS'] = 'previous-pre-rotation-secret-min-32-chars!!';
      const { verifyServiceBridgeSecret } = loadFresh();
      expect(() => verifyServiceBridgeSecret('neither-of-the-two-configured-values')).toThrow('Invalid Exchange bridge credentials');
    });

    test('with no previous secret configured (the default, no rotation in progress), only the current one works', () => {
      process.env['EXCHANGE_BRIDGE_SECRET'] = 'current-rotated-secret-min-32-characters!!';
      delete process.env['EXCHANGE_BRIDGE_SECRET_PREVIOUS'];
      const { verifyServiceBridgeSecret } = loadFresh();
      expect(() => verifyServiceBridgeSecret('current-rotated-secret-min-32-characters!!')).not.toThrow();
      expect(() => verifyServiceBridgeSecret('previous-pre-rotation-secret-min-32-chars!!')).toThrow('Invalid Exchange bridge credentials');
    });

    test('an empty EXCHANGE_BRIDGE_SECRET_PREVIOUS never itself authenticates an empty supplied value', () => {
      process.env['EXCHANGE_BRIDGE_SECRET'] = 'current-rotated-secret-min-32-characters!!';
      process.env['EXCHANGE_BRIDGE_SECRET_PREVIOUS'] = '';
      const { verifyServiceBridgeSecret } = loadFresh();
      expect(() => verifyServiceBridgeSecret('')).toThrow('Invalid Exchange bridge credentials');
      expect(() => verifyServiceBridgeSecret(undefined)).toThrow('Invalid Exchange bridge credentials');
    });
  });
});
