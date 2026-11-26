/**
 * Import this FIRST in a test that needs the delivered-copy pixel mark switched on. It is off by default since
 * 2026-11-20 (src/config/dna-vnext.ts), and the setting is read when the config module loads, so it must be set before
 * anything imports the watermark code. The clarity gate stays fully on, visible check included.
 */
process.env.DNA_VNEXT_WATERMARK_ON_DOWNLOAD = 'true';
export {};
