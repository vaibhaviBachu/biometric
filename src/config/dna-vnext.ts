/**
 * PinIT DNA vNext — additive provenance layer.
 * Does not replace 15-layer DNA, vault AES-GCM, or 8×8 HMAC (DNA A).
 */

function flag(key: string, defaultValue = true): boolean {
  const v = (process.env[key] ?? '').trim().toLowerCase();
  if (!v) return defaultValue;
  return v === '1' || v === 'true' || v === 'yes';
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const DNA_VNEXT_VERSION = '1.0.0';
export const DNA_VNEXT_WATERMARK_VERSION = 'robust-dwt-v1';
export const DNA_VNEXT_AUTH_VERSION = 'hmac-hierarchy-v1';
export const DNA_VNEXT_FILE_ANALYSIS_KEY = 'pinitDnaVnextV1';

export const dnaVnextConfig = {
  enabled: flag('DNA_VNEXT_ENABLED', true),
  /**
   * DNA B pixel mark on delivered copies (shared-link views, protected downloads, TEP exports). Vault store remains
   * skip-watermark for speed.
   *
   * OFF by default since 2026-11-20. The mark showed as a dotted grid on smooth skies, night photos and along edges in
   * shared links and downloads. Measured that day on real photos: even its faintest strength changes 58-100% of an image's
   * areas by more than their own detail can hide, so no strength of the current mark is invisible on a real photo.
   * Delivered copies keep their original pixels (identity still travels in the metadata and the tail, and copies are still
   * matched by their fingerprint). Turn it back on (DNA_VNEXT_WATERMARK_ON_DOWNLOAD=true) only with a mark that passes the
   * clarity gate's visible check on real photos; the gate still blocks any copy it can see.
   */
  watermarkOnProtectedDownload: flag('DNA_VNEXT_WATERMARK_ON_DOWNLOAD', false),
  secret: optional(
    'DNA_VNEXT_SECRET',
    optional('BLOCK_DNA_SECRET', optional('SPATIAL_AUTH_SECRET', optional('LSB_SIGNATURE_SECRET', 'dev_dna_vnext_secret'))),
  ),
} as const;

export function isDnaVnextEnabled(): boolean {
  return dnaVnextConfig.enabled;
}
