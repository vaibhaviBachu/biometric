/**
 * Production secret checks: missing, empty, public default, placeholder, too short, low entropy, valid;
 * the startup guard fails closed in production, stays quiet outside it; no secret value is ever reported.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { logger } from '../../src/lib/logger';
import { blockingProblem, evaluateSecrets, MIN_SECRET_LENGTH, REQUIRED_SECRETS } from '../../src/config/secret-validation';
import { checkProductionSecretSafety } from '../../src/config/secret-safety';

const warn = logger.warn as unknown as jest.Mock;
const error = logger.error as unknown as jest.Mock;
const info = logger.info as unknown as jest.Mock;

/** Distinct, long, random-looking values (test data only). */
const GOOD = {
  JWT_SECRET: 'Jq7vK2mXr9LpW4tYb8NcZ3hGd6FsA1eU5oRiP0xT',
  VAULT_MASTER_SECRET: 'Wz3kQ8nBv5MxC2yLd7HgT9rPf4JsA6uE1oIhN0aV',
  LSB_SIGNATURE_SECRET: 'Hn6bT1yRq4VcX9pLk3MsZ8wDg2FaJ7eU5oIuB0tQ',
  SHARE_HMAC_SECRET: 'Ke9pL2vXt7QmC4nBr1WzY6hGd3FsA8uJ5oIaN0xT',
} as const;

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'production', ...GOOD, ...over } as NodeJS.ProcessEnv;
}

beforeEach(() => { warn.mockClear(); error.mockClear(); info.mockClear(); });

describe('blockingProblem', () => {
  test.each([
    [undefined, 'missing'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['dev_jwt_secret_change_in_prod_min_32_chars_long!!', 'known_default'],
    ['dev_vault_secret_change_in_prod', 'known_default'],
    ['pinit-dna-dev-secret-change-me', 'known_default'],
    ['pinit', 'known_default'],
    ['change_me_exchange_bridge_secret_min_32_chars', 'known_default'],
    ['change-me-to-a-long-random-value-please-ok', 'placeholder'],
    ['my_dev_secret_that_is_long_enough_to_pass_len', 'placeholder'],
    ['Short1Value', 'too_short'],
    ['a'.repeat(MIN_SECRET_LENGTH + 8), 'low_entropy'],
    ['ababababababababababababababababababababab', 'low_entropy'],
  ] as const)('%j -> %s', (value, expected) => {
    expect(blockingProblem(value)).toBe(expected);
  });

  test('a long random value is acceptable', () => {
    expect(blockingProblem(GOOD.JWT_SECRET)).toBeNull();
    expect(GOOD.JWT_SECRET.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH);
  });
});

describe('evaluateSecrets', () => {
  test('all four required secrets valid: no errors', () => {
    expect(evaluateSecrets(env()).errors).toEqual([]);
  });

  test.each(REQUIRED_SECRETS)('%s missing, empty, default or weak is an error', (name) => {
    for (const bad of [undefined, '', 'dev_secret_change_in_prod', 'tooshort']) {
      const report = evaluateSecrets(env({ [name]: bad }));
      expect(report.errors.map((e) => e.name)).toContain(name);
    }
  });

  test('an empty value is caught (the config loader would use it as an empty key)', () => {
    const report = evaluateSecrets(env({ JWT_SECRET: '' }));
    expect(report.errors).toEqual([expect.objectContaining({ name: 'JWT_SECRET', problem: 'empty' })]);
  });

  test('optional secrets that are not set are warnings, not errors', () => {
    const report = evaluateSecrets(env());
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((w) => w.name)).toEqual(expect.arrayContaining(['EXCHANGE_BRIDGE_SECRET', 'BIOMETRIC_ENCRYPTION_KEY', 'PHASE3_SIGNING_SECRET']));
  });

  test('an optional secret that IS set must be strong', () => {
    const report = evaluateSecrets(env({ EXCHANGE_BRIDGE_SECRET: 'change_me_exchange_bridge_secret_min_32_chars' }));
    expect(report.errors).toEqual([expect.objectContaining({ name: 'EXCHANGE_BRIDGE_SECRET', problem: 'known_default' })]);
    const empty = evaluateSecrets(env({ TEP_SECRET: '' }));
    expect(empty.errors.map((e) => e.name)).toContain('TEP_SECRET');
  });

  test('a strong optional secret passes', () => {
    const report = evaluateSecrets(env({ EXCHANGE_BRIDGE_SECRET: 'Pd5nM8vXt2QkC7yBr4WzL1hGq9FsA3uJ6oIeN0xT' }));
    expect(report.errors).toEqual([]);
    expect(report.warnings.map((w) => w.name)).not.toContain('EXCHANGE_BRIDGE_SECRET');
  });

  test('a reused value and surrounding whitespace are warnings, not errors', () => {
    const report = evaluateSecrets(env({ SPATIAL_AUTH_SECRET: GOOD.LSB_SIGNATURE_SECRET, TEP_SECRET: `${GOOD.SHARE_HMAC_SECRET.slice(0, 20)}Xq7Lm2Vb9Tn4Rc6Pd\n` }));
    expect(report.errors).toEqual([]);
    const kinds = report.warnings.map((w) => `${w.name}:${w.problem}`);
    expect(kinds).toEqual(expect.arrayContaining(['SPATIAL_AUTH_SECRET:reused', 'LSB_SIGNATURE_SECRET:reused', 'TEP_SECRET:surrounding_whitespace']));
  });

  test('no secret value ever appears in the report', () => {
    const secrets = { ...GOOD, EXCHANGE_BRIDGE_SECRET: 'change_me_exchange_bridge_secret_min_32_chars', TEP_SECRET: 'weak-value-9' };
    const text = JSON.stringify(evaluateSecrets(env(secrets)));
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
  });
});

describe('checkProductionSecretSafety', () => {
  test('production with all good secrets starts', () => {
    expect(() => checkProductionSecretSafety(env())).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });

  test('production refuses to start on a missing or default required secret, naming it but not the value', () => {
    let message = '';
    try {
      checkProductionSecretSafety(env({ JWT_SECRET: undefined, SHARE_HMAC_SECRET: 'pinit-dna-dev-secret-change-me' }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('Refusing to start');
    expect(message).toContain('JWT_SECRET');
    expect(message).toContain('SHARE_HMAC_SECRET');
    expect(message).not.toContain('pinit-dna-dev-secret-change-me');
    expect(error).toHaveBeenCalled();
  });

  test('FAIL_ON_INSECURE_SECRETS=false is an explicit, logged escape hatch', () => {
    expect(() => checkProductionSecretSafety(env({ JWT_SECRET: undefined, FAIL_ON_INSECURE_SECRETS: 'false' }))).not.toThrow();
    expect(error.mock.calls.some((c) => String(c[0]).includes('FAIL_ON_INSECURE_SECRETS=false'))).toBe(true);
  });

  test('outside production nothing is enforced (local development keeps working)', () => {
    expect(() => checkProductionSecretSafety({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => checkProductionSecretSafety({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });

  test('startup log lines never contain a secret value', () => {
    const secrets = { ...GOOD, TEP_SECRET: 'weak-value-9' };
    try { checkProductionSecretSafety(env(secrets)); } catch { /* expected */ }
    const all = [...warn.mock.calls, ...error.mock.calls, ...info.mock.calls].map((c) => String(c[0])).join('\n');
    for (const value of Object.values(secrets)) expect(all).not.toContain(value);
  });
});
