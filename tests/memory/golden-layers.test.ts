/**
 * Before/after check for the memory work: the DNA fingerprints of Layers 1 to 4
 * must be byte-for-byte what they were before. The reference file
 * (golden/layers-1-4.json) was recorded from the code as it stood before the
 * memory gate and the shared decode. This test fails on any difference.
 *
 *   Record (only when the layer logic itself is meant to change):
 *     WRITE_GOLDEN=1 npx jest tests/memory/golden-layers
 *   Compare (the normal run):
 *     npx jest tests/memory/golden-layers
 */
import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CryptographicLayer } from '../../src/services/layers/layer1.cryptographic';
import { StructuralLayer } from '../../src/services/layers/layer2.structural';
import { PerceptualLayer } from '../../src/services/layers/layer3.perceptual';
import { SemanticLayer } from '../../src/services/layers/layer4.semantic';
import { withSharedDecode } from '../../src/lib/shared-decode';
import { buildCorpus, stable } from './corpus';

const GOLDEN = path.join(__dirname, 'golden', 'layers-1-4.json');
const SLOW = 600_000;

type Fingerprints = Record<string, string>;

async function fingerprintsOf(buffer: Buffer, mimeType: string, name: string, shared = false): Promise<Fingerprints> {
  const image = { buffer, mimeType, originalName: name, filePath: '', sizeBytes: buffer.length };
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const run = () => Promise.all([
    new CryptographicLayer().generate(image, sha),
    new StructuralLayer().generate(image),
    new PerceptualLayer().generate(image),
    new SemanticLayer().generate(image),
  ]);
  // shared = the way the orchestrator runs them: one decode of the photo for all layers.
  const [l1, l2, l3, l4] = shared ? await withSharedDecode(buffer, run) : await run();
  const digest = (v: unknown) => crypto.createHash('sha256').update(stable(v)).digest('hex');
  return {
    layer1: digest(l1),
    layer2: digest(l2),
    layer3: digest(l3),
    layer4: digest(l4),
    layer1Success: String((l1 as { success: boolean }).success),
    layer2Success: String((l2 as { success: boolean }).success),
    layer3Success: String((l3 as { success: boolean }).success),
    layer4Success: String((l4 as { success: boolean }).success),
  };
}

describe('DNA layers 1-4 give identical fingerprints', () => {
  test('on the fixed image set', async () => {
    const corpus = await buildCorpus();
    const got: Record<string, Fingerprints> = {};
    for (const img of corpus) got[img.name] = await fingerprintsOf(img.buffer, img.mimeType, img.name);

    if (process.env['WRITE_GOLDEN'] === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2));
      // eslint-disable-next-line no-console
      console.log('Recorded', Object.keys(got).length, 'images to', GOLDEN);
      return;
    }

    const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, Fingerprints>;
    const sharedGot: Record<string, Fingerprints> = {};
    for (const img of corpus) sharedGot[img.name] = await fingerprintsOf(img.buffer, img.mimeType, img.name, true);
    // Same fingerprints with the shared decode as with each layer decoding on its own.
    expect(sharedGot).toEqual(got);
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const name of Object.keys(want)) {
      expect({ name, ...got[name] }).toEqual({ name, ...want[name] });
    }
    // Every layer actually produced a result (a layer that failed the same way before and after would hide a problem).
    for (const name of Object.keys(got)) {
      expect({ name, ok: [got[name]!.layer1Success, got[name]!.layer2Success, got[name]!.layer3Success, got[name]!.layer4Success] })
        .toEqual({ name, ok: ['true', 'true', 'true', 'true'] });
    }
  }, SLOW);
});
