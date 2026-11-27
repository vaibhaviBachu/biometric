/**
 * Passive (silent) liveness via MiniFASNetV2 + MiniFASNetV1SE, through ONNX Runtime.
 *
 * Direct, same-math port of `c:\biometric\src\biosys\pad\passive.py` (same repo family,
 * same session) into Node/TypeScript, so this web app gets the same texture-based
 * presentation-attack check instead of only the 48x48-grayscale motion/sharpness
 * heuristic in face-liveness.service.ts. The two checks are complementary and are
 * combined with a hard AND in evaluatePad(), not a replacement for one another:
 * this catches print/screen texture a live-camera-with-motion check cannot; the
 * existing challenge-response catches simple static replay this cannot.
 *
 * Third-party credit: the models and the crop-and-score recipe come from
 * minivision-ai/Silent-Face-Anti-Spoofing (Apache-2.0). Weights are the official ones,
 * already converted to ONNX in the sibling biosys project (scripts/convert_minifasnet.py)
 * and copied here unmodified (models/minifasnet_v2_2.7_80x80.onnx,
 * models/minifasnet_v1se_4.0_80x80.onnx). Input is a BGR patch, raw 0..255 floats,
 * NCHW, 80x80, no mean/std normalisation — same contract as the Python side.
 *
 * Fail closed: any exception, NaN, or missing model file gives p_real = 0 and
 * valid = false, never silently skipped.
 */
import path from 'path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { logger } from '../../lib/logger';

const PATCH = 80;
const REAL_CLASS = 1;

interface ModelSpec {
  key: 'minifas_v2' | 'minifas_v1se';
  file: string;
  scale: number;
}

const MODEL_SPECS: ModelSpec[] = [
  { key: 'minifas_v2', file: 'minifasnet_v2_2.7_80x80.onnx', scale: 2.7 },
  { key: 'minifas_v1se', file: 'minifasnet_v1se_4.0_80x80.onnx', scale: 4.0 },
];

const MODELS_DIR = path.resolve(__dirname, '../../../models');

export interface RgbBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LoadedModel {
  session: ort.InferenceSession;
  scale: number;
}

let modelsPromise: Promise<LoadedModel[]> | null = null;

async function loadModels(): Promise<LoadedModel[]> {
  const loaded: LoadedModel[] = [];
  for (const spec of MODEL_SPECS) {
    const filePath = path.join(MODELS_DIR, spec.file);
    try {
      const session = await ort.InferenceSession.create(filePath, { executionProviders: ['cpu'] });
      loaded.push({ session, scale: spec.scale });
    } catch (err) {
      logger.warn('[MiniFASNet] model unavailable — passive PAD will fail closed', {
        model: spec.key,
        path: filePath,
        error: String(err),
      });
    }
  }
  return loaded;
}

function getModels(): Promise<LoadedModel[]> {
  if (!modelsPromise) modelsPromise = loadModels();
  return modelsPromise;
}

/** Expanded square-ish crop box (left, top, right, bottom), clamped inside the image.
 * Direct port of passive.py's patch_box(). */
function patchBox(srcW: number, srcH: number, box: RgbBox, scale: number): [number, number, number, number] {
  const { x, y, width: bw, height: bh } = box;
  if (bw <= 0 || bh <= 0) throw new Error('empty box');
  const effScale = Math.min((srcH - 1) / bh, Math.min((srcW - 1) / bw, scale));
  const nw = bw * effScale;
  const nh = bh * effScale;
  const cx = x + bw / 2;
  const cy = y + bh / 2;
  let l = cx - nw / 2;
  let t = cy - nh / 2;
  let r = cx + nw / 2;
  let b = cy + nh / 2;
  if (l < 0) { r -= l; l = 0; }
  if (t < 0) { b -= t; t = 0; }
  if (r > srcW - 1) { l -= r - (srcW - 1); r = srcW - 1; }
  if (b > srcH - 1) { t -= b - (srcH - 1); b = srcH - 1; }
  return [Math.trunc(l), Math.trunc(t), Math.trunc(r), Math.trunc(b)];
}

/** Crop a 3:4 (width:height) window centred on the face, full height. Direct port of
 * passive.py's portrait_window(). Frames already narrower than the ratio pass through
 * (left=0, width=srcW — an explicit no-op extract, not a special-cased skip). */
function portraitWindow(srcW: number, srcH: number, box: RgbBox, ratio = 0.75): { left: number; width: number; box: RgbBox } {
  const winW = Math.round(srcH * ratio);
  if (winW >= srcW) return { left: 0, width: srcW, box };
  const cx = box.x + box.width / 2;
  const left = Math.min(Math.max(Math.round(cx - winW / 2), 0), srcW - winW);
  return { left, width: winW, box: { x: box.x - left, y: box.y, width: box.width, height: box.height } };
}

/** Crop+resize to an 80x80 BGR float32 NCHW tensor, matching passive.py's crop_patch(). */
async function cropToTensor(buf: Buffer, srcW: number, srcH: number, box: RgbBox, scale: number): Promise<Float32Array> {
  const [l, t, r, b] = patchBox(srcW, srcH, box, scale);
  const w = Math.max(1, r - l + 1);
  const h = Math.max(1, b - t + 1);
  // raw RGB24 at the crop size, then resize to PATCHxPATCH — same two-step passive.py does
  // (crop with slicing, then cv2.resize).
  const { data } = await sharp(buf)
    .extract({ left: l, top: t, width: w, height: h })
    .resize(PATCH, PATCH, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // data is interleaved RGB, PATCH*PATCH*3 bytes. Model expects BGR, NCHW, raw 0..255 float.
  const out = new Float32Array(3 * PATCH * PATCH);
  const plane = PATCH * PATCH;
  for (let i = 0; i < plane; i++) {
    const o = i * 3;
    const rr = data[o]!;
    const gg = data[o + 1]!;
    const bb = data[o + 2]!;
    out[i] = bb;           // B channel
    out[plane + i] = gg;    // G channel
    out[2 * plane + i] = rr; // R channel
  }
  return out;
}

function softmaxRealProb(logits: Float32Array | number[]): number {
  const arr = Array.from(logits, (v) => Number(v));
  const max = Math.max(...arr);
  const exps = arr.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, v) => a + v, 0) || 1;
  return exps[REAL_CLASS]! / sum;
}

export interface FrameScore {
  pReal: number;
  valid: boolean;
}

/** Score one captured frame (a generously-padded crop around the detected face, as sent
 * by the client, plus the face box in THAT crop's own coordinates). Fails closed. */
export async function scoreFrame(jpegBuf: Buffer, box: RgbBox): Promise<FrameScore> {
  try {
    const models = await getModels();
    if (models.length === 0) return { pReal: 0, valid: false };

    const meta = await sharp(jpegBuf).metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    if (!srcW || !srcH) return { pReal: 0, valid: false };
    if (
      box.width <= 0 || box.height <= 0
      || box.x < -box.width || box.y < -box.height
      || box.x > srcW || box.y > srcH
    ) {
      return { pReal: 0, valid: false };
    }

    const { left, width: windowW, box: windowed } = portraitWindow(srcW, srcH, box);
    const windowBuf = await sharp(jpegBuf)
      .extract({ left, top: 0, width: windowW, height: srcH })
      .toBuffer();
    const windowH = srcH;

    const perModel: number[] = [];
    for (const { session, scale } of models) {
      const tensorData = await cropToTensor(windowBuf, windowW, windowH, windowed, scale);
      const inputName = session.inputNames[0]!;
      const outputName = session.outputNames[0]!;
      const tensor = new ort.Tensor('float32', tensorData, [1, 3, PATCH, PATCH]);
      const results = await session.run({ [inputName]: tensor });
      const logits = results[outputName]!.data as Float32Array;
      perModel.push(softmaxRealProb(logits));
    }
    const pReal = perModel.reduce((a, v) => a + v, 0) / perModel.length;
    if (!Number.isFinite(pReal) || pReal < 0 || pReal > 1) return { pReal: 0, valid: false };
    return { pReal, valid: true };
  } catch (err) {
    logger.warn('[MiniFASNet] frame score failed — treated as not live', { error: String(err) });
    return { pReal: 0, valid: false };
  }
}

export interface PassiveSummary {
  ok: boolean;
  median: number;
  frames: number;
  reason: string;
}

/** Clip-level passive decision: median P(real) over valid frames must reach the threshold.
 * Mirrors passive.py's summarise_passive(), with env-configurable threshold/min-frames
 * the same way the rest of src/config/index.ts's BIOMETRIC_* thresholds are. */
export function summarisePassive(scores: FrameScore[], opts?: { threshold?: number; minFrames?: number }): PassiveSummary {
  const threshold = opts?.threshold ?? parseFloat(process.env['BIOMETRIC_PASSIVE_PAD_THRESHOLD'] ?? '0.5');
  // 4, not 5: enrollment now samples roughly every other frame (see lib/face-liveness.ts
  // client-side) to keep MiniFASNet inference affordable on a single-CPU host, which
  // yields ~5 scored frames at the capture loop's own 10-sample floor — 4 leaves one
  // frame of slack rather than requiring every one of those 5 to extract cleanly.
  const minFrames = opts?.minFrames ?? parseInt(process.env['BIOMETRIC_PASSIVE_PAD_MIN_FRAMES'] ?? '4', 10);
  const valid = scores.filter((s) => s.valid && Number.isFinite(s.pReal)).map((s) => s.pReal);
  if (valid.length < minFrames) {
    return { ok: false, median: NaN, frames: valid.length, reason: 'too_few_frames' };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { ok: median >= threshold, median, frames: valid.length, reason: median >= threshold ? '' : 'below_threshold' };
}
