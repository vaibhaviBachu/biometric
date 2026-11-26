/**
 * Verification-accuracy fixes (2026-10-16):
 *  1. The Hub sends AI endpoints a ≤ 2048 px copy (they shrink anyway); big photos crashed the AI server (502).
 *  2. Downloaded images are no longer re-encoded with the DCT/DWT pixel marks (measured unreadable); the identity
 *     tail stays and is still read back.
 *  3. The vault-stored event records what the vault step wrote, so the evidence report stops reading Layer 6's flag.
 * Prisma is mocked: nothing here touches a database.
 */
import sharp from 'sharp';

jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));
jest.mock('../../src/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));
const emit = jest.fn();
jest.mock('../../src/services/platform-events/platform-event.engine', () => ({ platformEvents: { emit } }));

import { sizedForAi } from '../../src/services/ai/ai-embeddings.service';
import { vaultWatermarkEngine } from '../../src/services/watermark/vault-watermark-engine.service';
import { phase3WatermarkRecovery } from '../../src/services/watermark/phase3-watermark-recovery.service';
import { emitVaultStored } from '../../src/services/platform-events/module-events';

async function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#4477aa' } }).jpeg({ quality: 90 }).toBuffer();
}

describe('AI endpoints get a copy no larger than 2048 px', () => {
  it('shrinks a large photo to a 2048 px longest side, keeping the aspect ratio', async () => {
    const big = await jpeg(3000, 2000);
    const out = await sizedForAi(big, 'image/jpeg');
    const meta = await sharp(out.buffer).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(2048);
    expect(meta.width! / meta.height!).toBeCloseTo(1.5, 1);
    expect(out.mimeType).toBe('image/jpeg');
  });

  it('sends a photo that is already small unchanged (same bytes)', async () => {
    const small = await jpeg(800, 600);
    const out = await sizedForAi(small, 'image/jpeg');
    expect(out.buffer).toBe(small);
  });

  it('sends something that is not an image unchanged', async () => {
    const notImage = Buffer.from('not an image at all');
    const out = await sizedForAi(notImage, 'application/octet-stream');
    expect(out.buffer).toBe(notImage);
  });
});

describe('download marking for images', () => {
  const ctx = { vaultId: 'vault-1234-5678', dnaRecordId: 'dna-1234-5678', ownerUserId: 'owner-1', certificateId: null, recoveryToken: 'RT-abc' };

  it('keeps the original image bytes untouched and appends the identity tail', async () => {
    const original = await jpeg(640, 480);
    const result = await vaultWatermarkEngine.embed(original, 'image/jpeg', 'photo.jpg', ctx as never);
    expect(result.method).toBe('image-tail');
    expect(result.embedded).toBe(true);
    expect(result.buffer.subarray(0, original.length).equals(original)).toBe(true); // pixels not re-encoded
    expect(result.buffer.toString('utf8')).toContain('PINIT-VAULT-IMG|');
    // still a valid image
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(640);
  });

  it('the identity in the tail is still read back by the recovery service', async () => {
    const original = await jpeg(320, 240);
    const result = await vaultWatermarkEngine.embed(original, 'image/jpeg', 'photo.jpg', ctx as never);
    const payload = await (phase3WatermarkRecovery as unknown as {
      extractPhase3Payload: (b: Buffer, m: string) => Promise<string | null>;
    }).extractPhase3Payload(result.buffer, 'image/jpeg');
    expect(payload).toContain('PINIT-VAULT|');
  });
});

describe('vault-stored event records what was written into the stored copy', () => {
  it('stores the identity result in the event payload', () => {
    emitVaultStored({
      ownerUserId: 'owner-1', vaultId: 'v1', dnaRecordId: 'd1', filename: 'a.jpg',
      identity: { signatureEmbedded: true, manifestEmbedded: true, methods: ['image-lsb+tail', 'integrity-manifest'] },
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'vault.stored',
      payload: { identity: { signatureEmbedded: true, manifestEmbedded: true, methods: ['image-lsb+tail', 'integrity-manifest'] } },
    }));
  });
});
