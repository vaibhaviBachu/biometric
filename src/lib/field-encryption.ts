/**
 * Phase 2.2 (DB-GAP-06) — generic, purpose-separated field encryption for
 * database columns that previously stored a secret in plaintext
 * (OrganizationWebhook.secret, OrganizationIntegration.configJson).
 *
 * Reuses the same AES-256-GCM construction already proven for biometric
 * templates (see auth/biometric-crypto.service.ts) and the same master
 * secret (VAULT_MASTER_SECRET — already REQUIRED, already documented as
 * "derives the key that decrypts every stored file") rather than
 * introducing a new env var. Every call site derives its own key via HMAC
 * over a purpose string, so a bug or future leak in one purpose's derived
 * key can never be replayed against another purpose's ciphertext — the same
 * domain-separation trick this codebase already uses in
 * biometric-crypto.service.ts's own `keyedFingerprint`.
 */
import crypto from 'crypto';
import { config } from '../config';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/** Stamped on every ciphertext so a future key rotation can find and re-wrap rows instead of guessing. */
export const CURRENT_FIELD_KEY_VERSION = 'v1';

function deriveKey(purpose: string): Buffer {
  return crypto.createHmac('sha256', config.vault.masterSecret).update(`field-encryption:${purpose}`).digest();
}

/** Encrypts an arbitrary UTF-8 string for the given purpose. The plaintext is never retained. */
export function encryptField(purpose: string, plaintext: string): Buffer {
  const key = deriveKey(purpose);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

/** Reverses encryptField for the same purpose. Throws if the data was altered (GCM tag mismatch) or the purpose doesn't match. */
export function decryptField(purpose: string, packed: Buffer): string {
  const key = deriveKey(purpose);
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = packed.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Convenience wrapper for JSON-shaped fields (e.g. OrganizationIntegration.configJson). */
export function encryptJsonField(purpose: string, value: unknown): Buffer {
  return encryptField(purpose, JSON.stringify(value ?? {}));
}

export function decryptJsonField<T = Record<string, unknown>>(purpose: string, packed: Buffer): T {
  return JSON.parse(decryptField(purpose, packed)) as T;
}
