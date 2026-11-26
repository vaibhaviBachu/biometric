/**
 * Web presentation-attack detection (PAD) for face login / register.
 *
 * Method: server-issued unpredictable pose challenge + server-side checks on a short
 * grayscale patch sequence (motion, sharpness, single-face, quality) — the "active"
 * check — combined with a texture-based passive check (MiniFASNet, see
 * minifasnet-pad.service.ts) via a hard AND. Either one failing denies.
 *
 * This is still NOT ISO 30107 certified and has no IR/depth sensor. The active check
 * alone cannot tell a live camera from a live relay/deepfake reacting to the prompts in
 * real time; the passive check alone cannot tell a well-lit static photo apart from a
 * live face if someone defeats the active motion/pose requirement. Together they close
 * most of the gap either one leaves open on its own, not all of it.
 */
import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { scoreFrame, summarisePassive as summarisePassiveTexture, type RgbBox } from './minifasnet-pad.service';

export const PAD_ACTIONS = ['yaw_left', 'yaw_right', 'pitch_down'] as const;
export type PadAction = (typeof PAD_ACTIONS)[number];
export type PadVerdict = 'LIVE' | 'SPOOF' | 'UNKNOWN';

export const PAD_PATCH_SIZE = 48;
export const PAD_LIMITS = {
  /** Multi-step login (face → passkey → voice → submit) needs headroom past a short scan. */
  challengeTtlMs: 10 * 60_000,
  minSamples: 10,
  minDurationMs: 1800,
  // Was 40s. Shrinking the window shrinks how much a long, generic "look around in a
  // few directions" pre-recorded clip can be trimmed to "happen to" satisfy a random
  // challenge sequence. Not shrunk all the way to 25s: issuePadChallenge now sometimes
  // asks for all 3 moves instead of always 2, and a 3-move challenge genuinely needs
  // more real time to perform than a 2-move one — 32s keeps real users comfortable.
  maxDurationMs: 32_000,
  yaw: 0.14,
  pitch: 0.10,
  minBoxRatio: 0.08,
  maxBoxRatio: 0.72,
  minBrightness: 38,
  maxBrightness: 230,
  /** Mean abs pixel delta / 255. Still photos sit near 0. */
  minLiveMotion: 0.028,
  staticMotion: 0.012,
  minSharpness: 18,
  yawThreshold: 0.14,
  pitchThreshold: 0.10,
};

/** Glance login — no head-turn challenge. Still requires live motion vs a still photo. */
export const PAD_VERIFY_LIMITS = {
  minSamples: 6,
  minDurationMs: 700,
  minLiveMotion: 0.014,
  minBrightness: 6,
  maxBrightness: 252,
  minBoxRatio: 0.035,
  minSharpness: 10,
};

export interface PadSample {
  t: number;
  yaw: number;
  pitch: number;
  faceCount: number;
  boxRatio: number;
  brightness: number;
}

export interface RgbPadFrame {
  /** Base64 JPEG of a generously-padded crop around the detected face (not the raw
   * video frame) — large enough that the server can re-derive both MiniFASNet models'
   * expansion windows from it. */
  jpeg: string;
  /** The face box's position WITHIN that JPEG crop (not video coordinates). */
  box: { x: number; y: number; width: number; height: number };
}

export interface PadEvidence {
  challengeToken?: string;
  samples?: PadSample[];
  patches?: string[];
  /** Passive texture-based PAD input (MiniFASNet) — see minifasnet-pad.service.ts.
   * Optional/absent is treated as "no passive signal" (fails closed), never skipped. */
  rgbPatches?: RgbPadFrame[];
}

export interface IssuedPadChallenge {
  v: 1;
  jti: string;
  nonce: string;
  actions: PadAction[];
  iat: number;
  exp: number;
}

export interface PadEvaluation {
  verdict: PadVerdict;
  reasons: string[];
  scores: {
    motion: number;
    sharpness: number;
    durationMs: number;
    sampleCount: number;
    challengeOk: boolean;
  };
  jti?: string;
}

const HMAC_KEY = crypto.createHash('sha256').update(`pad:${config.biometric.encryptionKey}`).digest();
const usedJti = new Map<string, number>();

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function signPayload(payload: IssuedPadChallenge): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = b64url(crypto.createHmac('sha256', HMAC_KEY).update(body).digest());
  return `${body}.${mac}`;
}

export function parsePadChallenge(token: string | undefined): IssuedPadChallenge | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = b64url(crypto.createHmac('sha256', HMAC_KEY).update(parts[0]).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as IssuedPadChallenge;
    if (parsed?.v !== 1 || !parsed.jti || !Array.isArray(parsed.actions)) {
      return null;
    }
    if (parsed.actions.length !== 0 && (parsed.actions.length < 2 || parsed.actions.length > PAD_ACTIONS.length)) {
      return null;
    }
    if (parsed.actions.length > 0 && !parsed.actions.every((a) => (PAD_ACTIONS as readonly string[]).includes(a))) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function issuePadChallenge(
  mode: 'active' | 'passive' = 'active',
): { token: string; challenge: IssuedPadChallenge; instructions: Record<PadAction, string> } {
  const now = Date.now();
  let actions: PadAction[] = [];
  if (mode !== 'passive') {
    const pool = [...PAD_ACTIONS];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }
    // Randomize the count too (2 or all 3), not just the order — more possible
    // sequences for a pre-recorded clip to have to cover.
    const count = crypto.randomInt(2, pool.length + 1);
    actions = pool.slice(0, count) as PadAction[];
  }
  const challenge: IssuedPadChallenge = {
    v: 1,
    jti: crypto.randomUUID(),
    nonce: crypto.randomBytes(16).toString('hex'),
    actions,
    iat: now,
    exp: now + PAD_LIMITS.challengeTtlMs,
  };
  return {
    token: signPayload(challenge),
    challenge,
    instructions: {
      yaw_left: 'Turn your head left, then face the camera',
      yaw_right: 'Turn your head right, then face the camera',
      pitch_down: 'Look down, then look back at the camera',
    },
  };
}

// Base64 of PAD_PATCH_SIZE^2 raw bytes, plus headroom for any non-multiple-of-3 padding.
const PAD_PATCH_B64_MAX = Math.ceil((PAD_PATCH_SIZE * PAD_PATCH_SIZE * 4) / 3) + 8;

export function decodePadPatch(b64: string): Uint8Array | null {
  if (typeof b64 !== 'string' || b64.length < 8 || b64.length > PAD_PATCH_B64_MAX) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== PAD_PATCH_SIZE * PAD_PATCH_SIZE) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return n ? sum / n / 255 : 0;
}

function sharpnessScore(patch: Uint8Array): number {
  const w = PAD_PATCH_SIZE;
  let acc = 0;
  let n = 0;
  for (let y = 1; y < w - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = Math.abs(
        4 * patch[i]! - patch[i - 1]! - patch[i + 1]! - patch[i - w]! - patch[i + w]!,
      );
      acc += lap;
      n++;
    }
  }
  return n ? acc / n : 0;
}

/**
 * Video is unmirrored (raw camera feed, no CSS flip) — turning the head to the
 * subject's own left shifts the nose toward larger x (screen-right) in that feed,
 * the same reason your right hand appears on the left side of an unmirrored call.
 */
function poseHit(action: PadAction, yaw: number, pitch: number): boolean {
  if (action === 'yaw_left') return yaw >= PAD_LIMITS.yaw;
  if (action === 'yaw_right') return yaw <= -PAD_LIMITS.yaw;
  return pitch >= PAD_LIMITS.pitch;
}

function challengeSequenceOk(actions: PadAction[], samples: PadSample[]): boolean {
  let idx = 0;
  for (const s of samples) {
    const action = actions[idx];
    if (!action) break;
    if (poseHit(action, s.yaw, s.pitch)) idx += 1;
  }
  return idx >= actions.length;
}

/**
 * The original active check (pose challenge + grayscale motion/sharpness). Unchanged
 * logic, just renamed internal — evaluatePad() below wraps this with the passive
 * texture check and combines both via a hard AND.
 * Missing patches or challenge → UNKNOWN (never LIVE).
 */
function evaluateActivePad(challenge: IssuedPadChallenge | null, evidence: PadEvidence | null | undefined): PadEvaluation {
  const reasons: string[] = [];
  const emptyScores = { motion: 0, sharpness: 0, durationMs: 0, sampleCount: 0, challengeOk: false };

  if (!challenge) {
    return { verdict: 'UNKNOWN', reasons: ['missing_or_invalid_challenge'], scores: emptyScores };
  }

  const now = Date.now();
  if (now > challenge.exp) {
    return { verdict: 'UNKNOWN', reasons: ['challenge_expired'], scores: emptyScores, jti: challenge.jti };
  }
  if (now + 500 < challenge.iat) {
    return { verdict: 'UNKNOWN', reasons: ['challenge_clock'], scores: emptyScores, jti: challenge.jti };
  }

  const samples = Array.isArray(evidence?.samples) ? evidence!.samples! : [];
  const patchesRaw = Array.isArray(evidence?.patches) ? evidence!.patches! : [];
  const patches = patchesRaw.map(decodePadPatch);
  const passive = challenge.actions.length === 0;
  const minSamples = passive ? PAD_VERIFY_LIMITS.minSamples : PAD_LIMITS.minSamples;
  const minDurationMs = passive ? PAD_VERIFY_LIMITS.minDurationMs : PAD_LIMITS.minDurationMs;
  const minLiveMotion = passive ? PAD_VERIFY_LIMITS.minLiveMotion : PAD_LIMITS.minLiveMotion;
  if (samples.length < minSamples || patches.some((p) => !p) || patches.length < minSamples) {
    return {
      verdict: 'UNKNOWN',
      reasons: ['insufficient_samples'],
      scores: { ...emptyScores, sampleCount: samples.length },
      jti: challenge.jti,
    };
  }

  const times = samples.map((s) => s.t);
  const durationMs = Math.max(0, (times[times.length - 1] ?? 0) - (times[0] ?? 0));
  if (durationMs < minDurationMs || durationMs > PAD_LIMITS.maxDurationMs) {
    return {
      verdict: 'UNKNOWN',
      reasons: ['duration_out_of_range'],
      scores: { ...emptyScores, durationMs, sampleCount: samples.length },
      jti: challenge.jti,
    };
  }
  for (let i = 1; i < times.length; i++) {
    if (!Number.isFinite(times[i]) || times[i]! < times[i - 1]!) {
      return { verdict: 'UNKNOWN', reasons: ['timestamps_invalid'], scores: emptyScores, jti: challenge.jti };
    }
  }

  const minBoxRatio = passive ? PAD_VERIFY_LIMITS.minBoxRatio : PAD_LIMITS.minBoxRatio;
  const minBrightness = passive ? PAD_VERIFY_LIMITS.minBrightness : PAD_LIMITS.minBrightness;
  const maxBrightness = passive ? PAD_VERIFY_LIMITS.maxBrightness : PAD_LIMITS.maxBrightness;
  const minSharpness = passive ? PAD_VERIFY_LIMITS.minSharpness : PAD_LIMITS.minSharpness;
  let noFace = false;
  let multiFace = false;
  let poorQuality = false;
  for (const s of samples) {
    if (!Number.isFinite(s.faceCount) || s.faceCount < 1) noFace = true;
    if (s.faceCount > 1) multiFace = true;
    if (
      !Number.isFinite(s.boxRatio) || s.boxRatio < minBoxRatio || s.boxRatio > PAD_LIMITS.maxBoxRatio
      || !Number.isFinite(s.brightness) || s.brightness < minBrightness || s.brightness > maxBrightness
    ) {
      poorQuality = true;
    }
  }
  if (noFace) {
    return { verdict: 'UNKNOWN', reasons: ['no_face'], scores: { ...emptyScores, durationMs, sampleCount: samples.length }, jti: challenge.jti };
  }
  if (multiFace) {
    return { verdict: 'UNKNOWN', reasons: ['multiple_faces'], scores: { ...emptyScores, durationMs, sampleCount: samples.length }, jti: challenge.jti };
  }
  if (poorQuality) {
    logger.warn('[PAD] poor_quality diagnostic', {
      boxRatio: { min: Math.min(...samples.map((s) => s.boxRatio)), max: Math.max(...samples.map((s) => s.boxRatio)) },
      brightness: { min: Math.min(...samples.map((s) => s.brightness)), max: Math.max(...samples.map((s) => s.brightness)) },
      limits: {
        minBoxRatio,
        maxBoxRatio: PAD_LIMITS.maxBoxRatio,
        minBrightness,
        maxBrightness,
      },
    });
    return { verdict: 'UNKNOWN', reasons: ['poor_quality'], scores: { ...emptyScores, durationMs, sampleCount: samples.length }, jti: challenge.jti };
  }

  const decoded = patches as Uint8Array[];
  let motion = 0;
  for (let i = 1; i < decoded.length; i++) motion += meanAbsDiff(decoded[i]!, decoded[i - 1]!);
  motion /= Math.max(1, decoded.length - 1);

  let sharp = 0;
  for (const p of decoded) sharp += sharpnessScore(p);
  sharp /= decoded.length;

  const challengeOk = challengeSequenceOk(challenge.actions, samples);
  const yawSpan = Math.max(...samples.map((s) => s.yaw)) - Math.min(...samples.map((s) => s.yaw));
  const pitchSpan = Math.max(...samples.map((s) => s.pitch)) - Math.min(...samples.map((s) => s.pitch));
  const claimedPoseMotion = !passive && yawSpan + pitchSpan > 0.18;

  const scores = {
    motion,
    sharpness: sharp,
    durationMs,
    sampleCount: samples.length,
    challengeOk,
  };

  if (motion <= PAD_LIMITS.staticMotion) {
    reasons.push('static_presentation');
    return { verdict: 'SPOOF', reasons, scores, jti: challenge.jti };
  }
  if (claimedPoseMotion && motion < minLiveMotion * 0.7) {
    reasons.push('pose_pixel_inconsistent');
    return { verdict: 'SPOOF', reasons, scores, jti: challenge.jti };
  }
  if (sharp < minSharpness) {
    reasons.push('low_sharpness');
    return { verdict: 'UNKNOWN', reasons, scores, jti: challenge.jti };
  }
  if (!challengeOk) {
    reasons.push('challenge_not_completed');
    return { verdict: 'UNKNOWN', reasons, scores, jti: challenge.jti };
  }
  if (!passive && motion < minLiveMotion) {
    reasons.push('insufficient_motion');
    return { verdict: 'UNKNOWN', reasons, scores, jti: challenge.jti };
  }

  return { verdict: 'LIVE', reasons: ['ok'], scores, jti: challenge.jti };
}

/** Passive texture check over the evidence's rgbPatches (MiniFASNet). Absent/too-few
 * frames is UNKNOWN, never silently treated as passing. */
async function evaluatePassiveTexture(evidence: PadEvidence | null | undefined): Promise<{ ok: boolean; reason: string }> {
  const frames = Array.isArray(evidence?.rgbPatches) ? evidence!.rgbPatches! : [];
  if (frames.length === 0) return { ok: false, reason: 'no_rgb_frames' };
  const scores = await Promise.all(frames.map(async (f) => {
    try {
      const buf = Buffer.from(f.jpeg, 'base64');
      const box: RgbBox = f.box;
      return await scoreFrame(buf, box);
    } catch {
      return { pReal: 0, valid: false };
    }
  }));
  const summary = summarisePassiveTexture(scores);
  return { ok: summary.ok, reason: summary.reason || (summary.ok ? 'ok' : 'unknown') };
}

/**
 * Authoritative PAD decision: the active (pose challenge + motion/sharpness) check AND
 * the passive (MiniFASNet texture) check must both pass. Client "livenessPassed" is
 * ignored either way. Short-circuits on an already-failed active check so a spoof photo
 * never pays for the extra inference cost.
 */
export async function evaluatePad(challenge: IssuedPadChallenge | null, evidence: PadEvidence | null | undefined): Promise<PadEvaluation> {
  const active = evaluateActivePad(challenge, evidence);
  if (active.verdict !== 'LIVE') return active;

  const passive = await evaluatePassiveTexture(evidence);
  if (passive.ok) return active;

  const reasons = [...active.reasons, `passive_${passive.reason}`];
  // "No signal at all" (client sent nothing, or a bug) is UNKNOWN, not an accusation of
  // spoofing; an actual below-threshold texture score is treated as SPOOF, same severity
  // as the active check's own static_presentation/pose_pixel_inconsistent cases.
  const verdict: PadVerdict = passive.reason === 'below_threshold' ? 'SPOOF' : 'UNKNOWN';
  return { ...active, verdict, reasons };
}

export function padDenyMessage(verdict: PadVerdict, reasons?: string[]): string {
  if (verdict === 'SPOOF') {
    return 'Use a live camera. A photo or a screen cannot sign in.';
  }
  if (reasons?.includes('challenge_expired')) {
    return 'Look at the camera again.';
  }
  if (reasons?.includes('multiple_faces')) return 'Make sure only one person is visible.';
  if (reasons?.includes('low_sharpness')) return 'Hold still for a moment.';
  if (reasons?.includes('poor_quality') || reasons?.includes('no_face')) return 'Look at the camera.';
  return 'Hold still and look at the camera.';
}

async function jtiAlreadyUsed(jti: string): Promise<boolean> {
  const mem = usedJti.get(jti);
  if (mem && mem > Date.now()) return true;
  try {
    const row = await prisma.securityEvent.findFirst({
      where: {
        eventType: 'LIVENESS_CHALLENGE_USED',
        deviceId: `pad:${jti}`,
        createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
      },
      select: { id: true },
    });
    return Boolean(row);
  } catch {
    return false;
  }
}

async function markJtiUsed(jti: string, success: boolean, detail: Record<string, unknown>): Promise<void> {
  usedJti.set(jti, Date.now() + 15 * 60 * 1000);
  if (usedJti.size > 4000) {
    const now = Date.now();
    for (const [k, exp] of usedJti) {
      if (exp < now) usedJti.delete(k);
    }
  }
  try {
    await prisma.securityEvent.create({
      data: {
        eventType: 'LIVENESS_CHALLENGE_USED',
        deviceId: `pad:${jti}`,
        success,
        detail: detail as object,
      },
    });
  } catch (err) {
    logger.warn('[PAD] Could not persist used challenge id', { error: String(err) });
  }
}

/**
 * Verify PAD and consume the challenge (success or fail) so the capture cannot be replayed.
 * Only verdict LIVE may proceed to embedding match / JWT.
 */
export async function consumePadEvidence(
  evidence: PadEvidence | null | undefined,
): Promise<PadEvaluation> {
  const challenge = parsePadChallenge(evidence?.challengeToken);
  const evaluation = await evaluatePad(challenge, evidence);
  const jti = evaluation.jti ?? challenge?.jti;
  if (jti) {
    if (await jtiAlreadyUsed(jti)) {
      return {
        ...evaluation,
        verdict: 'SPOOF',
        reasons: ['replay_detected'],
        jti,
      };
    }
    await markJtiUsed(jti, evaluation.verdict === 'LIVE', {
      verdict: evaluation.verdict,
      reasons: evaluation.reasons,
      scores: evaluation.scores,
    });
  }
  return evaluation;
}
