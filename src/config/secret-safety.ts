/**
 * Production secret safety check — run once at server startup.
 *
 * Several secrets in this codebase have hardcoded, PUBLICLY VISIBLE fallback
 * values (search this repo for "_change_in_prod" / "dev_..._secret" style
 * strings). If the real env var is unset in production, the app silently
 * uses that public fallback — meaning anyone who reads the source can forge
 * whatever that secret protects. Found and fixed for JWT_SECRET (2026-09-22):
 * it was unset in production, so every session was signed with a secret
 * visible on GitHub — a full account-takeover vector, live, for an unknown
 * period. That was caught by manual inspection, not by any automated check.
 * This function is that automated check.
 *
 * Deliberately does NOT hard-crash the process by default — a wrongly-timed
 * hard-fail here would take down a live deploy over a single missing/typo'd
 * env var, which is its own kind of outage, and at the time this was written
 * two of the secrets below (LSB_SIGNATURE_SECRET, TEP_SIGNING_SECRET) had
 * just been rotated locally but not yet confirmed set on Render. So: logs
 * loudly, every single startup, impossible to miss — but only refuses to
 * start when FAIL_ON_INSECURE_SECRETS=true is explicitly set, which should
 * only be turned on once every secret below is confirmed correct in the
 * target environment.
 *
 * VAULT_MASTER_SECRET was rotated 2026-09-23 via scripts/rotate-vault-master-secret.ts
 * — it derives the key that encrypts every stored vault file and the HMAC
 * that signs every certificate, so a naive rotation would have made all of
 * them unreadable/invalid. Migrated 26/44 vault records and 32/32
 * certificates (the other 18 vault records were already unreadable in
 * production before this rotation, for unrelated reasons — missing storage
 * objects and pre-existing auth-tag failures — and were left untouched,
 * since rotation cannot make an already-broken record any worse).
 * BIOMETRIC_ENCRYPTION_KEY was independently decoupled from this secret
 * first (same day) so biometric templates were never at risk.
 *
 * EXCHANGE_BRIDGE_SECRET's own hardcoded-default backdoor (a literal string
 * that was ALWAYS accepted regardless of this env var — see
 * exchange-bridge.service.ts's verifyServiceBridgeSecret()) was fixed
 * 2026-09-23, and the value itself was rotated on both Hub and Exchange. What
 * remains here is the ordinary case: warn if it was never independently set.
 */
import { logger } from '../lib/logger';
import { config } from './index';
import { evaluateSecrets } from './secret-validation';

type Severity = 'critical' | 'high';

interface SecretCheck {
  envVar: string;
  insecure: boolean;
  severity: Severity;
  note: string;
}

function isProdEnv(): boolean {
  return (process.env['NODE_ENV'] || '').toLowerCase() === 'production';
}

function buildChecks(): SecretCheck[] {
  return [
    {
      envVar: 'JWT_SECRET',
      insecure: config.jwt.secret === 'dev_jwt_secret_change_in_prod_min_32_chars_long!!',
      severity: 'critical',
      note: 'Forges a login session for any account.',
    },
    {
      envVar: 'BIOMETRIC_ENCRYPTION_KEY',
      insecure: config.biometric.encryptionKey === 'dev_biometric_key_change_in_prod',
      severity: 'critical',
      note: 'Encrypts every stored face template — the most sensitive data this app holds.',
    },
  ];
}

/**
 * Workstream C: evaluateSecrets() (secret-validation.ts) is a thorough,
 * already-unit-tested pure checker — missing/empty/known-default/
 * placeholder-pattern/too-short/low-entropy/reused-across-secrets — that
 * was built but never actually wired into server startup; only its own
 * test file ever called it. checkProductionSecretSafety above only catches
 * a secret still equal to one exact known default string, so a secret set
 * to something short or low-entropy but NOT byte-identical to that string
 * (e.g. EXCHANGE_BRIDGE_SECRET=weak123) passed silently. This runs the
 * broader checker for real, every production startup, logging every issue
 * the same way checkProductionSecretSafety does, and reuses the same
 * FAIL_ON_INSECURE_SECRETS=true flag for fail-closed behavior rather than
 * introducing a second toggle an operator would have to learn.
 */
export function runSecretValidation(): void {
  if (!isProdEnv()) return;

  const { errors, warnings } = evaluateSecrets(process.env);

  for (const w of warnings) {
    logger.warn(`[SecretValidation] ${w.detail}`);
  }

  if (!errors.length) {
    logger.info('[SecretValidation] No blocking secret-configuration problems found.');
    return;
  }

  for (const e of errors) {
    logger.error(`[SecretValidation] *** ${e.detail} ***`);
  }

  const hardFail = (process.env['FAIL_ON_INSECURE_SECRETS'] || '').toLowerCase() === 'true';
  if (hardFail) {
    const names = errors.map((e) => e.name).join(', ');
    throw new Error(
      `[SecretValidation] Refusing to start: ${errors.length} secret(s) failed validation (${names}). ` +
      'Set FAIL_ON_INSECURE_SECRETS=false to downgrade this to a warning instead — but fix the secrets, not the flag.',
    );
  }
}

export function checkProductionSecretSafety(): void {
  if (!isProdEnv()) return;

  const results = buildChecks();
  const insecure = results.filter((c) => c.insecure);

  if (!insecure.length) {
    logger.info('[SecretSafety] All checked secrets are independently configured — no known public defaults in use.');
    return;
  }

  for (const c of insecure) {
    logger.error(
      `[SecretSafety] *** ${c.envVar} is INSECURE in production (${c.severity}) *** ${c.note}`,
    );
  }

  const hardFail = (process.env['FAIL_ON_INSECURE_SECRETS'] || '').toLowerCase() === 'true';
  if (hardFail) {
    const names = insecure.map((c) => c.envVar).join(', ');
    throw new Error(
      `[SecretSafety] Refusing to start: ${insecure.length} secret(s) are insecure in production (${names}). ` +
      `Set FAIL_ON_INSECURE_SECRETS=false to downgrade this to a warning instead — but fix the secrets, not the flag.`,
    );
  }
}
