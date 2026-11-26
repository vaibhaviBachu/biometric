/**
 * The report-signing key: a configured key is used whether it was pasted with real line breaks or on one line with
 * literal "\n" (what a hosting dashboard often stores); an unreadable key is reported loudly instead of silently
 * breaking signing; with no key a random one is used (and, in production with signing on, that is warned about).
 * Only throwaway keys made in this test are used.
 */
import crypto from 'crypto';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../src/lib/logger', () => ({ logger: mockLogger }));

const ENV_KEYS = ['PHASE3_ED25519_PRIVATE_KEY_PEM', 'NODE_ENV', 'DNA_PHASE3_ENABLED'] as const;
const saved: Record<string, string | undefined> = {};

function loadFresh(): typeof import('../../src/services/evidence/phase3-crypto.service') {
  let mod!: typeof import('../../src/services/evidence/phase3-crypto.service');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('../../src/services/evidence/phase3-crypto.service');
  });
  return mod;
}

const throwaway = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPemOf = (privatePem: string) => crypto.createPublicKey(crypto.createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' }).toString();

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  jest.clearAllMocks();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('PHASE3_ED25519_PRIVATE_KEY_PEM', () => {
  test('a key with real line breaks is used, and is the same key every time (signatures verify across restarts)', () => {
    const pem = throwaway();
    process.env.PHASE3_ED25519_PRIVATE_KEY_PEM = pem;
    const first = loadFresh();
    const sig = first.signEd25519('report-hash');
    expect(sig).toBeTruthy();
    expect(first.getPublicKeyPem()).toBe(publicPemOf(pem));
    const restarted = loadFresh(); // a new start with the same key
    expect(restarted.verifyEd25519('report-hash', sig!)).toBe(true);
  });

  test('a key stored on one line with literal \\n is accepted too', () => {
    const pem = throwaway();
    process.env.PHASE3_ED25519_PRIVATE_KEY_PEM = pem.trim().replace(/\n/g, '\\n');
    expect(process.env.PHASE3_ED25519_PRIVATE_KEY_PEM).not.toContain('\n');
    const mod = loadFresh();
    expect(mod.getPublicKeyPem()).toBe(publicPemOf(pem));
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('a key that cannot be read is reported loudly and does not silently fall back to a random key', () => {
    process.env.PHASE3_ED25519_PRIVATE_KEY_PEM = '-----BEGIN PRIVATE KEY-----\nnot a real key\n-----END PRIVATE KEY-----';
    const mod = loadFresh();
    expect(mod.signEd25519('x')).toBeNull();
    expect(mod.getPublicKeyPem()).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('PHASE3_ED25519_PRIVATE_KEY_PEM is set but is not a valid private key'), expect.anything());
  });
});

describe('no key configured', () => {
  test('a random key is made so signing still works, differing between starts', () => {
    delete process.env.PHASE3_ED25519_PRIVATE_KEY_PEM;
    process.env.NODE_ENV = 'test';
    const a = loadFresh();
    const b = loadFresh();
    expect(a.signEd25519('x')).toBeTruthy();
    expect(a.getPublicKeyPem()).not.toBe(b.getPublicKeyPem());
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('in production with signing switched on, it warns that earlier reports will not verify after a restart', () => {
    delete process.env.PHASE3_ED25519_PRIVATE_KEY_PEM;
    process.env.NODE_ENV = 'production';
    process.env.DNA_PHASE3_ENABLED = 'true';
    loadFresh();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('PHASE3_ED25519_PRIVATE_KEY_PEM is not set'));
  });
});
