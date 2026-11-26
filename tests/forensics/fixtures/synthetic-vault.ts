/**
 * Synthetic stored indexes and probes for the local DNA search tests and measurements. Deterministic (seeded), no database,
 * no images. The shapes follow a real owner: many stored pictures with thousands of patches each, a probe of a few thousand
 * patches, most of which match nothing (so the "no bucket for this prefix" path is the common one), a minority that do.
 */
import { buildVaultPrefixMap, type MatchIndex, type VaultPatchRow } from '../../../src/services/forensics/local-dna-match-core';
import type { PatchFingerprint } from '../../../src/services/forensics/local-dna-patch-generator.service';

/** Small seeded generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = '0123456789abcdef';
export function randomHex(rand: () => number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += HEX[Math.floor(rand() * 16)];
  return s;
}

/** The hash with `bits` random bits flipped. */
export function flipBits(rand: () => number, hex: string, bits: number): string {
  const chars = hex.split('');
  for (let b = 0; b < bits; b++) {
    const at = Math.floor(rand() * chars.length);
    chars[at] = HEX[parseInt(chars[at]!, 16) ^ (1 << Math.floor(rand() * 4))]!;
  }
  return chars.join('');
}

function vaultPatch(rand: () => number, patchIndex: number, scales: number[]): VaultPatchRow {
  const scale = scales[patchIndex % scales.length]!;
  return {
    patchIndex,
    gridX: patchIndex % 40,
    gridY: Math.floor(patchIndex / 40),
    scale,
    pHash16: randomHex(rand, 16),
    dHash8: randomHex(rand, 8),
    aHash8: randomHex(rand, 8),
    edgeSignature: randomHex(rand, 4),
    colorVector: [Math.floor(rand() * 255), Math.floor(rand() * 255), Math.floor(rand() * 255)],
    frequencySig: randomHex(rand, 4),
    textureSig: randomHex(rand, 4),
  };
}

export interface SyntheticVault {
  indexes: MatchIndex[];
  probe: PatchFingerprint[];
  /** The index the probe was cut from. */
  sourceIndex: number;
}

export function buildSyntheticVault(opts: {
  seed?: number;
  indexes?: number;
  patchesPerIndex?: number;
  probePatches?: number;
  /** Share of the probe taken (with small damage) from one stored picture. */
  probeFromVault?: number;
}): SyntheticVault {
  const rand = rng(opts.seed ?? 1);
  const indexCount = opts.indexes ?? 69;
  const perIndex = opts.patchesPerIndex ?? 1500;
  const probeCount = opts.probePatches ?? 2931;
  const fromVault = opts.probeFromVault ?? 0.35;
  const scales = [16, 32, 64, 128];

  const indexes: MatchIndex[] = [];
  for (let i = 0; i < indexCount; i++) {
    const patches: VaultPatchRow[] = [];
    for (let p = 0; p < perIndex; p++) patches.push(vaultPatch(rand, p, scales));
    indexes.push({
      vaultId: `vault-${i}`,
      dnaRecordId: `dna-${i}`,
      ownerUserId: 'owner-1',
      dnaRecord: { imageFilename: `picture-${i}.jpg` },
      vaultPatches: patches,
      vaultByPrefix: buildVaultPrefixMap(patches),
    });
  }

  const sourceIndex = Math.floor(rand() * indexCount);
  const source = indexes[sourceIndex]!.vaultPatches;
  const probe: PatchFingerprint[] = [];
  for (let p = 0; p < probeCount; p++) {
    if (rand() < fromVault) {
      const from = source[Math.floor(rand() * source.length)]!;
      probe.push({
        patchIndex: p, gridX: from.gridX, gridY: from.gridY, scale: from.scale,
        pHash16: flipBits(rand, from.pHash16, Math.floor(rand() * 6)),
        dHash8: from.dHash8 ?? '', aHash8: from.aHash8 ?? '', edgeSignature: from.edgeSignature ?? '',
        colorVector: from.colorVector as [number, number, number],
        frequencySig: from.frequencySig ?? '', textureSig: from.textureSig ?? '',
      });
    } else {
      probe.push({
        patchIndex: p, gridX: p % 55, gridY: Math.floor(p / 55), scale: scales[p % scales.length]!,
        pHash16: randomHex(rand, 16), dHash8: randomHex(rand, 8), aHash8: randomHex(rand, 8),
        edgeSignature: randomHex(rand, 4),
        colorVector: [Math.floor(rand() * 255), Math.floor(rand() * 255), Math.floor(rand() * 255)],
        frequencySig: randomHex(rand, 4), textureSig: randomHex(rand, 4),
      });
    }
  }
  return { indexes, probe, sourceIndex };
}
