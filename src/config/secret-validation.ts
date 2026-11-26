/**
 * Pure checks on the secrets the backend is configured with. No secret value is ever returned, logged or put
 * in a message: issues name the variable and the kind of problem only.
 *
 * What is checked, per variable:
 *   missing           not set at all
 *   empty             set to an empty or blank string (the config loader keeps an empty value instead of
 *                     falling back, so an empty JWT/HMAC secret would really be used as an empty key)
 *   known_default     equal to one of the fallback strings that are visible in the source repository
 *   placeholder       looks like a template value ("change_me", "dev_…", "example", "default" …)
 *   too_short         shorter than MIN_SECRET_LENGTH characters
 *   low_entropy       fewer than 10 distinct characters (for example "aaaaaaaa…")
 * Warnings (never block start): surrounding whitespace or control characters in the value, a value reused by
 * another secret, and the optional secrets that are not set and therefore fall back to another one.
 *
 * Compatibility: every derivation in the code (HKDF for vault files, SHA-256 for the biometric key, HMAC for
 * signatures and share tokens, HS256 for JWTs) accepts any non-empty string, so the 32-character minimum is a
 * policy, not a library limit. Secrets are used as typed (no trimming, no decoding), so changing how they are
 * read would change every derived key: this module only inspects, it never alters.
 */

export const MIN_SECRET_LENGTH = 32;

export type SecretProblem =
  | 'missing'
  | 'empty'
  | 'known_default'
  | 'placeholder'
  | 'too_short'
  | 'low_entropy'
  | 'surrounding_whitespace'
  | 'reused'
  | 'falls_back';

export interface SecretIssue {
  name: string;
  problem: SecretProblem;
  /** Human-readable, contains no secret value. */
  detail: string;
}

export interface SecretReport {
  errors: SecretIssue[];
  warnings: SecretIssue[];
}

/** Fallback strings that exist in the repository. A real deployment must never be running on any of them. */
const KNOWN_DEFAULTS = new Set([
  'dev_jwt_secret_change_in_prod_min_32_chars_long!!',
  'dev_biometric_key_change_in_prod',
  'dev_vault_secret_change_in_prod', // BIOMETRIC_ENCRYPTION_KEY's own fallback chain still passes through this
]);

const PLACEHOLDER = /change[_-]?me|change[_-]?in[_-]?prod|replace[_-]?me|(^|[_-])dev([_-]|$)|placeholder|your[_-]?(secret|key)|example|default/i;

/** What each variable protects (shown in the startup log so the impact is clear). */
const PURPOSE: Record<string, string> = {
  JWT_SECRET: 'signs every login session; anyone who knows it can act as any account',
  BIOMETRIC_ENCRYPTION_KEY: 'encrypts stored biometric (face) templates; changing it makes existing templates unreadable',
};

/** Must be set to something strong in production, or the server refuses to start. */
export const REQUIRED_SECRETS = ['JWT_SECRET', 'BIOMETRIC_ENCRYPTION_KEY'] as const;

/**
 * Optional: when unset the code falls back to another secret (a warning), when set it must be strong (an
 * error). `fallsBackTo` is only for the message.
 */
export const OPTIONAL_SECRETS: Array<{ name: string; fallsBackTo: string }> = [];

const PROBLEM_TEXT: Record<SecretProblem, string> = {
  missing: 'is not set',
  empty: 'is set but empty',
  known_default: 'is a public default value from the source code',
  placeholder: 'looks like a placeholder or template value',
  too_short: `is shorter than ${MIN_SECRET_LENGTH} characters`,
  low_entropy: 'has too few different characters to be random',
  surrounding_whitespace: 'has leading or trailing whitespace or a control character (usually a copy-paste slip; it is used exactly as typed)',
  reused: 'has the same value as another secret',
  falls_back: 'is not set separately',
};

/** The first blocking problem with a value, or null when it is acceptable. */
export function blockingProblem(value: string | undefined): SecretProblem | null {
  if (value === undefined) return 'missing';
  if (value.trim() === '') return 'empty';
  if (KNOWN_DEFAULTS.has(value) || KNOWN_DEFAULTS.has(value.trim())) return 'known_default';
  if (PLACEHOLDER.test(value)) return 'placeholder';
  if (value.length < MIN_SECRET_LENGTH) return 'too_short';
  if (new Set(value).size < 10) return 'low_entropy';
  return null;
}

function issue(name: string, problem: SecretProblem, extra = ''): SecretIssue {
  const purpose = PURPOSE[name] ? ` — ${PURPOSE[name]}` : '';
  return { name, problem, detail: `${name} ${PROBLEM_TEXT[problem]}${extra}${purpose}` };
}

export function evaluateSecrets(env: NodeJS.ProcessEnv): SecretReport {
  const errors: SecretIssue[] = [];
  const warnings: SecretIssue[] = [];
  const present = new Map<string, string[]>(); // value -> names that have it (kept in memory only, never returned)

  const note = (name: string, value: string | undefined) => {
    if (value === undefined || value === '') return;
    present.set(value, [...(present.get(value) ?? []), name]);
    // eslint-disable-next-line no-control-regex -- intentional: detects control characters in a secret
    if (/^\s|\s$|[\u0000-\u001f]/.test(value)) warnings.push(issue(name, 'surrounding_whitespace'));
  };

  for (const name of REQUIRED_SECRETS) {
    const value = env[name];
    const problem = blockingProblem(value);
    if (problem) errors.push(issue(name, problem));
    note(name, value);
  }

  for (const { name, fallsBackTo } of OPTIONAL_SECRETS) {
    const value = env[name];
    if (value === undefined) {
      warnings.push(issue(name, 'falls_back', ` (it uses ${fallsBackTo} instead)`));
      continue;
    }
    const problem = blockingProblem(value);
    if (problem) errors.push(issue(name, problem));
    note(name, value);
  }

  for (const names of present.values()) {
    if (names.length > 1) {
      for (const name of names) warnings.push(issue(name, 'reused', ` (shared with ${names.filter((n) => n !== name).join(', ')})`));
    }
  }

  return { errors, warnings };
}
