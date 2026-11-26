/**
 * Phase 4b: a comparison fingerprint (Trace probe, regenerated vault file) is computed in memory and writes nothing to the
 * database. It used to create a DnaRecord, save layer rows, start background layers 11–15 / package / camera jobs, read the
 * rows back and archive the record, several times per Trace. Same layers: checked layer by layer on 48 pictures
 * (docs/TRACE-SLOWNESS-FIX-PLAN-2026-11-16.md, Phase 4b).
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import sharp from 'sharp';

const writes: string[] = [];
jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    dnaRecord: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => { writes.push('dnaRecord.create'); return {}; }),
      update: jest.fn(async () => { writes.push('dnaRecord.update'); return {}; }),
    },
    $transaction: jest.fn(async () => { writes.push('$transaction'); }),
  },
}));
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

// In the app's import order (importing the fingerprinter alone enters an existing import cycle).
import '../../src/services/universal-file-router';
import {
  EphemeralFingerprinter, imageLayerRowsFromComputed, mapImageLayers, resetEphemeralFingerprintMemo,
} from '../../src/services/verification/ephemeral-fingerprinter';
import { DnaOrchestrator } from '../../src/services/dna.orchestrator';

async function picture(): Promise<Buffer> {
  const raw = Buffer.alloc(320 * 240 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919) % 251;
  return sharp(raw, { raw: { width: 320, height: 240, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

beforeEach(() => { writes.length = 0; resetEphemeralFingerprintMemo(); delete process.env['EPHEMERAL_FINGERPRINT_IN_MEMORY']; });
afterEach(() => { jest.restoreAllMocks(); });

describe('comparison fingerprint in memory', () => {
  test('nothing is written: no record, no layer rows, no status update; the layers are there', async () => {
    const generate = jest.spyOn(DnaOrchestrator.prototype, 'generate');
    const buffer = await picture();
    const fp = await new EphemeralFingerprinter().fingerprint({ filePath: '', originalName: 'probe.jpg', declaredMimeType: 'image/jpeg', sizeBytes: buffer.length, buffer });
    expect(writes).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
    expect(fp.layers).toHaveLength(15);
    expect(fp.layers.slice(0, 4).every((l) => l.success && l.fingerprint)).toBe(true);
  }, 120_000);

  test('no carrier files are left behind (layers 2 and 6 write them outside production)', async () => {
    const fsSync = await import('fs');
    const { config } = await import('../../src/config');
    // The folder must exist, or the layers cannot write a carrier at all and there would be nothing to check.
    fsSync.mkdirSync(config.upload.tempDir, { recursive: true });
    const carriers = () => fsSync.readdirSync(config.upload.tempDir).filter((n) => /^carrier_l[26]_/.test(n));
    const before = new Set(carriers());
    const buffer = await picture();
    await new EphemeralFingerprinter().fingerprint({ filePath: '', originalName: 'carrier-probe.jpg', declaredMimeType: 'image/jpeg', sizeBytes: buffer.length, buffer });
    expect(carriers().filter((n) => !before.has(n))).toEqual([]);
  }, 120_000);

  test('EPHEMERAL_FINGERPRINT_IN_MEMORY=off: the old database round trip (generate) is used', async () => {
    process.env['EPHEMERAL_FINGERPRINT_IN_MEMORY'] = 'off';
    const generate = jest.spyOn(DnaOrchestrator.prototype, 'generate').mockResolvedValue({ dnaRecordId: 'x' } as never);
    const buffer = await picture();
    await new EphemeralFingerprinter().fingerprint({ filePath: '', originalName: 'probe.jpg', declaredMimeType: 'image/jpeg', sizeBytes: buffer.length, buffer }).catch(() => null);
    expect(generate).toHaveBeenCalledTimes(1);
  }, 120_000);
});

describe('the rows built from computed layers', () => {
  const ok = (data: object) => ({ success: true, data });
  const failed = { success: false, data: undefined };
  const core = {
    cryptoResult: ok({ sha256Hash: 'a', normalizedHash: 'b', blake3Hash: 'c' }),
    structuralResult: failed,
    perceptualResult: ok({ pHash64: 'p', pHash256: 'pp', aHash64: 'aa', dHash64: 'dd' }),
    semanticResult: ok({ colorFingerprint: 'col' }),
    metadataResult: ok({ deviceMake: 'Cam', deviceModel: undefined, capturedAt: '2026-01-02T03:04:05.678Z', gpsLatitude: 1.5, gpsLongitude: undefined }),
    stegoResult: ok({ payloadHmac: 'h', embedded: true, channel: 'blue' }),
    behavioralResult: ok({ behaviorHash: 'bh', uploadMs: 3 }),
    relationshipResult: ok({ graphHash: 'g', relatedIds: [] }),
    originResult: ok({ bundleHash: 'ob' }),
    evolutionResult: ok({ merkleRoot: 'mr', version: 1 }),
  };

  test('a layer that did not succeed has no row, as when nothing was saved for it', () => {
    expect(imageLayerRowsFromComputed(core).structuralLayer).toBeNull();
  });

  test('a timestamp becomes a Date and missing optional values become null, as the database returns them', () => {
    const rows = imageLayerRowsFromComputed(core);
    expect(rows.metadataLayer?.capturedAt).toBeInstanceOf(Date);
    expect(rows.metadataLayer?.capturedAt?.toISOString()).toBe('2026-01-02T03:04:05.678Z');
    expect(rows.metadataLayer?.deviceModel).toBeNull();
    expect(rows.metadataLayer?.gpsLongitude).toBeNull();
  });

  test('mapped by the same rules as the saved rows (missing layer 2 is padded, as before)', () => {
    const layers = mapImageLayers(imageLayerRowsFromComputed(core));
    expect(layers).toHaveLength(15);
    expect(layers[0]).toMatchObject({ layer: 1, fingerprint: 'a', success: true });
    expect(layers.find((l) => l.layer === 3)?.fingerprint).toBe('p');
    expect(layers.filter((l) => l.success)).toHaveLength(9);
  });
});
