/**
 * Phase 2.2 (DB-GAP-06) — field-encryption.ts contract: round-trip,
 * tamper-detection (GCM auth tag), and purpose-based domain separation.
 */
import { describe, test, expect } from '@jest/globals';
import { encryptField, decryptField, encryptJsonField, decryptJsonField } from '../../src/lib/field-encryption';

describe('encryptField / decryptField', () => {
  test('round-trips a plaintext string', () => {
    const packed = encryptField('test-purpose', 'whsec_abc123');
    expect(decryptField('test-purpose', packed)).toBe('whsec_abc123');
  });

  test('round-trips an empty string', () => {
    const packed = encryptField('test-purpose', '');
    expect(decryptField('test-purpose', packed)).toBe('');
  });

  test('produces different ciphertext for the same plaintext on repeated calls (random IV)', () => {
    const a = encryptField('test-purpose', 'same-value');
    const b = encryptField('test-purpose', 'same-value');
    expect(a.equals(b)).toBe(false);
  });

  test('decrypting with the wrong purpose fails (domain separation)', () => {
    const packed = encryptField('purpose-a', 'secret-value');
    expect(() => decryptField('purpose-b', packed)).toThrow();
  });

  test('a tampered ciphertext fails to decrypt (GCM auth tag)', () => {
    const packed = encryptField('test-purpose', 'secret-value');
    const tampered = Buffer.from(packed);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptField('test-purpose', tampered)).toThrow();
  });
});

describe('encryptJsonField / decryptJsonField', () => {
  test('round-trips a JSON object', () => {
    const value = { incomingWebhookUrl: 'https://hooks.slack.com/services/x' };
    const packed = encryptJsonField('test-purpose', value);
    expect(decryptJsonField('test-purpose', packed)).toEqual(value);
  });

  test('round-trips an empty object', () => {
    const packed = encryptJsonField('test-purpose', {});
    expect(decryptJsonField('test-purpose', packed)).toEqual({});
  });
});
