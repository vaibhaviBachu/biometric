/**
 * PINIT-DNA — Central Configuration
 *
 * All environment variables are validated and typed here.
 * Import `config` throughout the app — never read process.env directly.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { ALL_ACCEPTED_MIME_TYPES, GLOBAL_MAX_FILE_SIZE_BYTES } from './supported-file-types';
import { DNA_GENERATOR_VERSION, DNA_SCHEMA_VERSION } from './dna-versions';

dotenv.config();
// Ensure Exchange bridge secret from .env wins even if a shell JWT_SECRET was already set
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8');
    const match = text.match(/^EXCHANGE_BRIDGE_SECRET=(.*)$/m);
    if (match) {
      const val = match[1].trim().replace(/^["']|["']$/g, '');
      if (val) process.env.EXCHANGE_BRIDGE_SECRET = val;
    }
  }
} catch {
  /* ignore */
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) throw new Error(`Env var ${key} must be an integer, got: ${value}`);
  return parsed;
}

/**
 * Phase 10 — DR9-ENV-01. A developer's own local `.env` can legitimately
 * hold the real production Supabase connection string (to see real data
 * locally) — this does not warn/fail in production itself (that is the
 * correct, intended target there), only when NODE_ENV is NOT 'production'
 * and the resolved DATABASE_URL still classifies as production-like,
 * meaning this process is about to run non-production code paths (dev
 * server, a locally-run script, a REPL) against the real database.
 *
 * Warns loudly always; hard-fails only when FAIL_ON_NONLOCAL_DB_IN_DEV=true
 * is explicitly set — mirroring this codebase's own established convention
 * for this exact warn-vs-fail-closed decision (see secret-safety.ts's
 * FAIL_ON_INSECURE_SECRETS). Default stays non-disruptive: an existing
 * developer workflow that intentionally runs the real app locally against
 * real data keeps working unchanged unless they opt into the stricter mode.
 */
function warnOrFailIfDatabaseUrlIsProductionLike(databaseUrl: string): void {
  const nodeEnv = (process.env['NODE_ENV'] || '').toLowerCase();
  if (nodeEnv === 'production' || nodeEnv === 'test') return; // production is the correct target there; tests are isolated in jest.env.setup.ts

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { classifyTarget } = require('../lib/recovery/db-target-guard.cjs') as {
    classifyTarget: (url: string) => { classification: string; host: string };
  };
  const result = classifyTarget(databaseUrl);
  if (result.classification !== 'production-like') return;

  const message =
    `[config] *** DATABASE_URL points at a production-like host (${result.host}) while NODE_ENV='${nodeEnv || 'development'}' *** ` +
    'This process will read/write the REAL production database. If unintended, point DATABASE_URL at a local database instead ' +
    '(see docker-compose.dev.yml). See DR9-ENV-01 / PHASE_9_RECOVERY_SECURITY_AND_ACCESS_CONTROL.pdf.';

  if ((process.env['FAIL_ON_NONLOCAL_DB_IN_DEV'] || '').toLowerCase() === 'true') {
    throw new Error(message.replace('***', '*** REFUSING TO START ***'));
  }
  // eslint-disable-next-line no-console
  console.warn(message);
}


/** Public Hub origin used when PUBLIC_APP_URL is not set in production. */
const PRODUCTION_HUB_URL = 'https://pinit-dna.vercel.app';

function resolveHubAppUrl(): string {
  const explicit = (process.env.PUBLIC_APP_URL || process.env.HUB_APP_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (!isProd) return 'http://localhost:3002';
  return PRODUCTION_HUB_URL;
}

/** Public marketplace origin used when EXCHANGE_APP_URL is not configured in production. */
const PRODUCTION_EXCHANGE_URL = 'https://www.pinitexchange.com';

/**
 * Resolve the Exchange app origin.
 *
 * Local dev keeps the localhost default. Production must never emit a
 * localhost SSO link, so an unset value falls back to the public marketplace
 * and logs loudly rather than failing silently.
 */
function resolveExchangeAppUrl(): string {
  const explicit = process.env.EXCHANGE_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (!isProd) return 'http://localhost:5174';

  // eslint-disable-next-line no-console
  console.warn(
    '[config] EXCHANGE_APP_URL is not set in production — falling back to ' +
      `${PRODUCTION_EXCHANGE_URL}. Set EXCHANGE_APP_URL explicitly on the backend service.`,
  );
  return PRODUCTION_EXCHANGE_URL;
}

/** Exchange API service used when EXCHANGE_API_URL is not configured in production. */
const PRODUCTION_EXCHANGE_API_URL = 'https://pinit-exchange-api-sg.onrender.com';

/**
 * Resolve the Exchange API origin — same rule as the app URL above.
 *
 * The localhost default made every server-side Exchange call in production
 * (listed-assets, role, seller desk) quietly fail, so My Assets lost its
 * Exchange tags while localhost — where an Exchange server really does run on
 * :5000 — kept showing them.
 */
function resolveExchangeApiUrl(): string {
  const explicit = process.env.EXCHANGE_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (!isProd) return 'http://localhost:5000';

  // eslint-disable-next-line no-console
  console.warn(
    '[config] EXCHANGE_API_URL is not set in production — falling back to ' +
      `${PRODUCTION_EXCHANGE_API_URL}. Set EXCHANGE_API_URL explicitly on the backend service.`,
  );
  return PRODUCTION_EXCHANGE_API_URL;
}

export const config = {
  env: optional('NODE_ENV', 'development') as 'development' | 'production' | 'test',
  port: optionalInt('PORT', 4000),
  apiPrefix: optional('API_PREFIX', '/api/v1'),

  /**
   * New Pinit accounts are open.
   * Set REGISTRATION_OPEN=false on the API to close sign-up again.
   * Login for existing accounts is unaffected.
   */
  registration: {
    open: optional('REGISTRATION_OPEN', 'true').toLowerCase() !== 'false',
  },

  hub: {
    appUrl: resolveHubAppUrl(),
  },

  db: {
    url: (() => {
      const url = required('DATABASE_URL');
      warnOrFailIfDatabaseUrlIsProductionLike(url);
      return url;
    })(),
  },

  upload: {
    /**
     * Phase 0+: all supported MIME types are accepted at the upload boundary.
     * The UniversalFileRouter enforces which types have live engines.
     * Override via ALLOWED_FILE_TYPES env var (comma-separated) if needed.
     */
    allowedMimeTypes: process.env['ALLOWED_FILE_TYPES']
      ? process.env['ALLOWED_FILE_TYPES'].split(',')
      : ALL_ACCEPTED_MIME_TYPES,
    /**
     * Global ceiling — the largest single-type max (500 MB for ZIP/VIDEO).
     * Per-type ceilings are enforced by the router after detection.
     */
    maxFileSizeBytes: optionalInt('MAX_FILE_SIZE', GLOBAL_MAX_FILE_SIZE_BYTES),
    tempDir: path.resolve(optional('UPLOAD_TEMP_DIR', './tmp/uploads')),
  },

  dna: {
    // WHY defaults from dna-versions (Task A1): same strings as before; env override unchanged.
    schemaVersion: optional('DNA_SCHEMA_VERSION', DNA_SCHEMA_VERSION),
    /** Universal engine version — bumped each phase */
    engineVersion: optional('DNA_ENGINE_VERSION', DNA_GENERATOR_VERSION),
  },

  stego: {
    signatureSecret: optional('LSB_SIGNATURE_SECRET', 'dev_secret_change_in_prod'),
  },

  vault: {
    // Master secret for HKDF key derivation — never stored derived keys
    masterSecret: optional('VAULT_MASTER_SECRET', 'dev_vault_secret_change_in_prod'),
    // Directory where AES-256-GCM encrypted vault files are stored
    storageDir: path.resolve(optional('VAULT_STORAGE_DIR', './vault/encrypted')),
  },

  /**
   * Object storage backend selection. Defaults to 'supabase' — the current,
   * unchanged production path. Set STORAGE_BACKEND=s3 only once a real S3
   * bucket exists (see src/lib/s3-storage.ts); flipping this without a
   * provisioned bucket/credentials will fail every vault store/retrieve.
   */
  storage: {
    backend: optional('STORAGE_BACKEND', 'supabase') as 'supabase' | 's3',
    s3Bucket: optional('S3_BUCKET', ''),
    awsRegion: optional('AWS_REGION', 'ap-south-1'),
  },

  /**
   * Background job dispatch. Defaults to false — the current, unchanged
   * in-process fire-and-forget path (vault.service.ts calling
   * upgradePdfInBackground/protectVideoFrames directly). Set
   * BACKGROUND_JOBS_USE_QUEUE=true only once a real worker process
   * (src/worker.ts) is actually running and consuming JOB_QUEUE_BACKEND —
   * flipping this with no consumer running means PDF/video background
   * protection is published but never processed.
   */
  jobs: {
    useQueue: optional('BACKGROUND_JOBS_USE_QUEUE', 'false').toLowerCase() === 'true',
  },

  /**
   * Phase 4 — shared Redis (rate-limit counters, read-through caches).
   * Defaults OFF: with no REDIS_URL and REDIS_ENABLED unset, every consumer
   * (rate limiter, cache) falls back to its pre-Phase-4, process-local
   * behavior — this flag changes nothing until explicitly turned on in an
   * environment that actually has a Redis instance reachable at REDIS_URL.
   */
  redis: {
    enabled: optional('REDIS_ENABLED', 'false').toLowerCase() === 'true',
    url: optional('REDIS_URL', 'redis://127.0.0.1:6379'),
    connectTimeoutMs: optionalInt('REDIS_CONNECT_TIMEOUT_MS', 2000),
    commandTimeoutMs: optionalInt('REDIS_COMMAND_TIMEOUT_MS', 500),
  },

  jwt: {
    secret: optional('JWT_SECRET', 'dev_jwt_secret_change_in_prod_min_32_chars_long!!'),
    // Access tokens sit in localStorage, so keep them short-lived: a copied token stops working within minutes.
    // The browser renews it from the HttpOnly refresh cookie (client/src/lib/auth.ts).
    accessTtl: optional('JWT_ACCESS_TTL', '15m'),
  },

  share: {
    // `||` (not `optional`) on purpose: matches the pre-existing behavior in
    // share-link.service.ts, where an EMPTY env var also fell back to the default
    // rather than becoming an empty HMAC key.
    hmacSecret: process.env['SHARE_HMAC_SECRET'] || 'pinit-dna-dev-secret-change-me',
  },

  webauthn: {
    rpName: optional('WEBAUTHN_RP_NAME', 'PINIT'),
    rpID: optional('WEBAUTHN_RP_ID', 'localhost'),
    origin: optional('WEBAUTHN_ORIGIN', 'http://localhost:3002'),
    /**
     * When false, the "fingerprint" step is a placeholder: no passkey is required
     * to register or log in, and none is enrolled. Authentication then rests on
     * face (+ optional voice) alone — the device-possession factor is GONE.
     *
     * Passkeys are bound to one domain by design, so a credential enrolled on
     * localhost cannot be used on the deployed site; this flag exists so the
     * flow stays usable across environments until per-domain enrollment is built.
     *
     * Set WEBAUTHN_REQUIRE_PASSKEY=true to restore real WebAuthn verification.
     */
    requirePasskey: optional('WEBAUTHN_REQUIRE_PASSKEY', 'false').toLowerCase() === 'true',
  },

  biometric: {
    encryptionKey: optional('BIOMETRIC_ENCRYPTION_KEY', optional('VAULT_MASTER_SECRET', 'dev_biometric_key_change_in_prod')),
    /**
     * Live matcher. Keep face-api-v1 until a commercially licensed ArcFace-family
     * engine is approved and weights are installed. Setting arcface-family-licensed
     * without weights fails closed (MODEL_UNAVAILABLE) — never bypasses biometrics.
     */
    recognitionEngine: (optional('BIOMETRIC_RECOGNITION_ENGINE', 'face-api-v1') === 'arcface-family-licensed'
      ? 'arcface-family-licensed'
      : 'face-api-v1') as 'face-api-v1' | 'arcface-family-licensed',
    thresholds: {
      // face-api.js L2 on normalized 128-d.
      //
      // Measured on this deployment (2026-08-19), not theoretical:
      //   same person, own enrolled face .......... 0.137
      //   different person vs that same face ...... 0.375, 0.471
      //
      // At the previous 0.48 both strangers fell UNDER the threshold, which
      // (a) blocked real teammates from registering — they were reported as
      // duplicates of an existing account — and (b) meant a stranger holding
      // someone's Pinit ID was inside the 1:1 login threshold too.
      //
      // 0.33 sits between the observed same-person and different-person bands.
      // Revisit with more samples across lighting/angles: too tight and a
      // badly-lit capture of the legitimate owner starts failing login.
      faceLogin: parseFloat(optional('BIOMETRIC_FACE_LOGIN_THRESHOLD', '0.38')),
      // Same value — 1:N enroll uniqueness. A hit rejects registration (sign in instead).
      faceDuplicate: parseFloat(optional('BIOMETRIC_FACE_DUPLICATE_THRESHOLD', '0.38')),
      // Best match must beat 2nd-best by this margin when ≥2 templates exist.
      faceLoginMargin: parseFloat(optional('BIOMETRIC_FACE_LOGIN_MARGIN', '0.08')),
      /**
       * 1:N among the enrolled faces. Live glances of an enrolled person on this
       * deployment land around 0.31–0.35 from their own template. The next
       * person is farther. Accept the nearest face inside this ceiling only
       * when it leads the next face by faceIdentifyMargin. A near tie refuses.
       */
      faceIdentify: parseFloat(optional('BIOMETRIC_FACE_IDENTIFY_THRESHOLD', '0.38')),
      faceIdentifyMargin: parseFloat(optional('BIOMETRIC_FACE_IDENTIFY_MARGIN', '0.03')),
      voiceLogin: parseFloat(optional('BIOMETRIC_VOICE_LOGIN_THRESHOLD', '0.45')),
      voiceDuplicate: parseFloat(optional('BIOMETRIC_VOICE_DUPLICATE_THRESHOLD', '0.35')),
      fingerprintLogin: parseFloat(optional('BIOMETRIC_FINGERPRINT_LOGIN_THRESHOLD', '0.40')),
      fingerprintDuplicate: parseFloat(optional('BIOMETRIC_FINGERPRINT_DUPLICATE_THRESHOLD', '0.30')),
      fusionMinConfidence: parseFloat(optional('BIOMETRIC_FUSION_MIN_CONFIDENCE', '72')),
      weights: {
        face: parseFloat(optional('BIOMETRIC_WEIGHT_FACE', '0.50')),
        voice: parseFloat(optional('BIOMETRIC_WEIGHT_VOICE', '0.30')),
        fingerprint: parseFloat(optional('BIOMETRIC_WEIGHT_FINGERPRINT', '0.20')),
      },
    },
  },

  rateLimit: {
    windowMs: optionalInt('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), // 15 min
    max: optionalInt('RATE_LIMIT_MAX', 2000),
  },

  /**
   * Freemium subscription enforcement.
   * When false, all features are allowed (emergency bypass). Default: true.
   * Quota limits below are configurable via env — not hardcoded in business logic.
   */
  subscription: {
    enforcementEnabled: optional('SUBSCRIPTION_ENFORCEMENT', 'true').toLowerCase() !== 'false',
    freeAssetLimit: optionalInt('SUBSCRIPTION_FREE_ASSET_LIMIT', 5),
    businessFreeTeamLimit: optionalInt('SUBSCRIPTION_BUSINESS_FREE_TEAM_LIMIT', 1),
    businessFreeWorkspaceLimit: optionalInt('SUBSCRIPTION_BUSINESS_FREE_WORKSPACE_LIMIT', 1),
    /**
     * Phase 1 Razorpay Test Mode override — replaces the PRO plan's price and
     * storage allowance for testing only. NEVER applied when RAZORPAY_KEY_ID
     * looks like a live key (rzp_live_...) — see
     * constants/plans.ts#resolveEffectivePlan, which throws rather than
     * silently ignoring or silently applying an unsafe combination. The real
     * ₹999 / 100 GB PRO plan in constants/plans.ts is never edited by this —
     * it stays the production truth regardless of this flag.
     */
    testPriceOverrideEnabled: optional('SUBSCRIPTION_TEST_PRICE_OVERRIDE', 'false').toLowerCase() === 'true',
    testProPricePaise: optionalInt('SUBSCRIPTION_TEST_PRO_PRICE_PAISE', 0),
    testProStorageGb: optionalInt('SUBSCRIPTION_TEST_PRO_STORAGE_GB', 0),
    /** Storage top-up packs via Razorpay (INR) — shares the override flag above, its own per-GB rate. */
    testStorageTopUpPricePaisePerGb: optionalInt('RAZORPAY_TEST_STORAGE_PRICE_PAISE_PER_GB', 0),
    /**
     * Phase 1B — free-trial storage grant. One per user, ever (see
     * entitlement.service.ts#ensureTrialGrant); expires on its own clock,
     * independent of any plan or subscription period.
     */
    trialStorageGb: optionalInt('SUBSCRIPTION_TRIAL_STORAGE_GB', 2),
    trialDurationDays: optionalInt('SUBSCRIPTION_TRIAL_DURATION_DAYS', 14),
  },

  razorpay: {
    keyId: optional('RAZORPAY_KEY_ID', '').trim(),
    keySecret: optional('RAZORPAY_KEY_SECRET', '').trim(),
    webhookSecret: optional('RAZORPAY_WEBHOOK_SECRET', '').trim(),
  },

  /**
   * Stripe — a second, independent payment provider alongside Razorpay.
   * Deliberately its own config block with its own test-price override: the
   * Razorpay override must never leak into Stripe pricing, and vice versa.
   * No production price has been approved for Stripe yet — see
   * services/subscription/billing/stripe.service.ts for the fail-closed
   * guard that refuses to apply the test override against a live key.
   */
  stripe: {
    secretKey: optional('STRIPE_SECRET_KEY', '').trim(),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET', '').trim(),
    testPriceOverrideEnabled: optional('STRIPE_TEST_PRICE_OVERRIDE', 'false').toLowerCase() === 'true',
    testProPriceCents: optionalInt('STRIPE_TEST_PRO_PRICE_CENTS', 0),
    testProStorageGb: optionalInt('STRIPE_TEST_PRO_STORAGE_GB', 0),
    testCurrency: optional('STRIPE_TEST_CURRENCY', 'usd').toLowerCase(),
    /** Storage top-up packs — a per-GB test rate so any pack size resolves without a new env var per pack. */
    testStoragePriceCentsPerGb: optionalInt('STRIPE_TEST_STORAGE_PRICE_CENTS_PER_GB', 0),
    /** INR equivalent, independently configurable — unset (0) until a product owner approves an INR price. */
    testStoragePricePaisePerGb: optionalInt('STRIPE_TEST_STORAGE_PRICE_PAISE_PER_GB', 0),
  },

  /**
   * Pinit Exchange bridge — marketplace stays a separate app.
   * Hub owns identity / vault / DNA; Exchange only receives public-safe listing payloads.
   */
  exchange: {
    // The localhost defaults are for local development only. In production an
    // unset EXCHANGE_APP_URL used to silently produce a localhost SSO link,
    // which sent every "Exchange" click to a machine the user does not have —
    // so production falls back to the real marketplace instead, and warns.
    appUrl: resolveExchangeAppUrl(),
    apiUrl: resolveExchangeApiUrl(),
    bridgeSecret: optional(
      'EXCHANGE_BRIDGE_SECRET',
      optional('JWT_SECRET', 'dev_jwt_secret_change_in_prod_min_32_chars_long!!'),
    ),
    /**
     * Workstream C key rotation: set during a rotation window so a bridge
     * secret can be rotated on Hub and Exchange without a moment where every
     * in-flight request from the side still holding the old value is
     * rejected. Empty (the default) means no rotation is in progress — only
     * the current `bridgeSecret` is accepted. Never falls back to JWT_SECRET
     * or any other secret: an unset previous-key slot must mean "no grace
     * period," not "accept something else instead."
     */
    bridgeSecretPrevious: process.env['EXCHANGE_BRIDGE_SECRET_PREVIOUS'] || '',
  },

  log: {
    level: optional('LOG_LEVEL', 'debug'),
  },

  /**
   * PinitHUB Master Admin — a fully separate app (own Vite project, own port),
   * same split as Exchange. Hub has no password login, so the admin app cannot
   * run its own sign-in form; instead an already-logged-in Hub user requests a
   * short-lived signed bridge token and is redirected into the admin app with it.
   */
  admin: {
    appUrl: optional('ADMIN_APP_URL', 'http://localhost:3003').replace(/\/$/, ''),
    bridgeSecret: optional(
      'ADMIN_BRIDGE_SECRET',
      optional('JWT_SECRET', 'dev_jwt_secret_change_in_prod_min_32_chars_long!!'),
    ),
  },
} as const;

export type Config = typeof config;
