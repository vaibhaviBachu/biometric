/**
 * Import this FIRST in a test of the pixel mark's MECHANICS: whether it reads back after JPEG, resize, crop and so on.
 * It switches the mark on (off on delivered copies by default since 2026-11-20) and lifts the clarity gate's visible
 * check, which on its own refuses every strength of the current mark on smooth pictures. Visibility is pinned separately
 * by tests/watermark/delivered-copy-stays-clean.test.ts; these tests only measure reading.
 */
process.env.DNA_VNEXT_WATERMARK_ON_DOWNLOAD = 'true';
process.env.CLARITY_VISIBLE_MAX_SHARE = '1';
export {};
