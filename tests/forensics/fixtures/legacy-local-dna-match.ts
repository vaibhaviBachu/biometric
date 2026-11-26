/**
 * A copy of the local DNA patch matching exactly as it was before the performance work (commit 364e27e), kept only for tests
 * and measurements: one synchronous loop, `parseInt` per hex digit, an array copy per fallback, the hash compared three times.
 * It is the reference the new generator-based core is checked against, and the "before" in the benchmark.
 * Do not use it in the application.
 */
import { localDnaConfig } from '../../../src/config/local-dna';
import type { PatchFingerprint } from '../../../src/services/forensics/local-dna-patch-generator.service';
import type { LocalDnaSearchHit, MatchIndex, PatchMatch, VaultPatchRow } from '../../../src/services/forensics/local-dna-match-core';

/** The original hamming distance (parseInt per digit). */
export function legacyHammingBits(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return dist;
}

function spatialConsistency(matches: PatchMatch[]): number {
  if (matches.length < 2) return matches.length ? 1 : 0;
  const offsetCounts = new Map<string, number>();
  for (const m of matches) {
    const scaleNorm = Math.max(m.probeScale, m.vaultScale, 1);
    const dx = (m.vaultGx * m.vaultScale - m.probeGx * m.probeScale) / scaleNorm;
    const dy = (m.vaultGy * m.vaultScale - m.probeGy * m.probeScale) / scaleNorm;
    const key = `${Math.round(dx)},${Math.round(dy)}`;
    offsetCounts.set(key, (offsetCounts.get(key) ?? 0) + 1);
  }
  const maxCount = Math.max(...offsetCounts.values());
  return maxCount / matches.length;
}

function geometricVerification(matches: PatchMatch[]): number {
  if (matches.length < 4) return spatialConsistency(matches);
  const hypotheses: Array<{ dx: number; dy: number; inliers: number }> = [];
  for (const m of matches) {
    const scaleNorm = Math.max(m.probeScale, m.vaultScale, 1);
    const dx = (m.vaultGx * m.vaultScale - m.probeGx * m.probeScale) / scaleNorm;
    const dy = (m.vaultGy * m.vaultScale - m.probeGy * m.probeScale) / scaleNorm;
    let inliers = 0;
    for (const o of matches) {
      const sn = Math.max(o.probeScale, o.vaultScale, 1);
      const odx = (o.vaultGx * o.vaultScale - o.probeGx * o.probeScale) / sn;
      const ody = (o.vaultGy * o.vaultScale - o.probeGy * o.probeScale) / sn;
      if (Math.abs(odx - dx) <= 1.5 && Math.abs(ody - dy) <= 1.5) inliers++;
    }
    hypotheses.push({ dx, dy, inliers });
  }
  hypotheses.sort((a, b) => b.inliers - a.inliers);
  return (hypotheses[0]?.inliers ?? 0) / matches.length;
}

function toVaultPatch(fp: VaultPatchRow) {
  return {
    pHash16: fp.pHash16,
    dHash8: fp.dHash8 ?? '',
    aHash8: fp.aHash8 ?? '',
    edgeSignature: fp.edgeSignature ?? '',
    colorVector: (fp.colorVector as [number, number, number]) ?? [0, 0, 0],
    frequencySig: fp.frequencySig ?? '',
    textureSig: fp.textureSig ?? '',
  };
}

function legacyFingerprintsMatch(a: string, b: string): boolean {
  return legacyHammingBits(a, b) <= localDnaConfig.patchHammingThreshold;
}

function legacyColorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

type DensePatch = Pick<PatchFingerprint, 'pHash16' | 'dHash8' | 'aHash8' | 'edgeSignature' | 'colorVector' | 'frequencySig' | 'textureSig'>;

/** The original dense match, using the original hamming distance. */
function legacyDenseMatch(probe: DensePatch, vault: DensePatch): boolean {
  if (legacyFingerprintsMatch(probe.pHash16, vault.pHash16)) return true;
  if (legacyHammingBits(probe.pHash16, vault.pHash16) > localDnaConfig.patchHammingThreshold + 4) return false;
  let votes = 0;
  if (probe.dHash8 && vault.dHash8 && legacyHammingBits(probe.dHash8, vault.dHash8) <= 6) votes++;
  if (probe.aHash8 && vault.aHash8 && legacyHammingBits(probe.aHash8, vault.aHash8) <= 6) votes++;
  if (probe.edgeSignature === vault.edgeSignature) votes++;
  if (legacyColorDistance(probe.colorVector, vault.colorVector) < 45) votes++;
  if (probe.frequencySig === vault.frequencySig) votes++;
  if (probe.textureSig === vault.textureSig) votes++;
  return votes >= 3;
}

export function legacyPatchesMatch(probe: PatchFingerprint, vault: VaultPatchRow): boolean {
  if (legacyFingerprintsMatch(probe.pHash16, vault.pHash16)) return true;
  return legacyDenseMatch(probe, toVaultPatch(vault));
}

/** The original loop of VaultLocalDnaSearchService.search(), without the database, ORB refinement or logging. */
export function legacyMatchAllIndexes(probePatches: PatchFingerprint[], indexes: MatchIndex[]): LocalDnaSearchHit[] {
  const hits: LocalDnaSearchHit[] = [];
  for (const idx of indexes) {
    if (!idx.vaultId) continue;
    const vaultPatches = idx.vaultPatches;
    if (!vaultPatches.length) continue;
    const vaultByPrefix = idx.vaultByPrefix;
    const patchMatches: PatchMatch[] = [];
    const matchedVaultPatches = new Set<number>();

    for (const probePatch of probePatches) {
      const prefix = probePatch.pHash16.slice(0, 4);
      const candidates = vaultByPrefix.get(prefix) ?? [];
      const nearCandidates = candidates.length ? candidates : vaultPatches.slice(0, 40);
      for (const vaultPatch of nearCandidates) {
        if (matchedVaultPatches.has(vaultPatch.patchIndex)) continue;
        if (legacyPatchesMatch(probePatch, vaultPatch)) {
          patchMatches.push({
            probeGx: probePatch.gridX,
            probeGy: probePatch.gridY,
            probeScale: probePatch.scale,
            vaultGx: vaultPatch.gridX,
            vaultGy: vaultPatch.gridY,
            vaultScale: vaultPatch.scale ?? localDnaConfig.patchSize,
          });
          matchedVaultPatches.add(vaultPatch.patchIndex);
          break;
        }
      }
    }

    const patchMatchCount = patchMatches.length;
    const matchRatio = patchMatchCount / probePatches.length;
    const coverageRatio = patchMatchCount / vaultPatches.length;
    const spatial = spatialConsistency(patchMatches);
    const geometric = geometricVerification(patchMatches);
    const minPatches = localDnaConfig.minPatchMatches;
    const minRatio = localDnaConfig.minMatchRatio;
    const minSpatial = localDnaConfig.minSpatialConsistency;
    if (patchMatchCount < minPatches && patchMatchCount < 8) continue;
    if (matchRatio < minRatio && patchMatchCount < 12) continue;
    if (spatial < minSpatial && geometric < 0.35 && matchRatio < 0.12) continue;

    let compositeScore = Math.round(
      matchRatio * 50 + spatial * 20 + geometric * 15 + Math.min(patchMatchCount, 120) * 0.2 + coverageRatio * 8,
    );
    if (patchMatchCount >= 200) compositeScore = Math.max(compositeScore, 78);
    else if (patchMatchCount >= 100) compositeScore = Math.max(compositeScore, 68);
    else if (patchMatchCount >= 60) compositeScore = Math.max(compositeScore, 58);
    compositeScore = Math.min(99, compositeScore);

    const signals = ['local_patch_dna', 'patch_voting', 'multi_scale'];
    if (matchRatio >= 0.10) signals.push('fragment_recovery');
    if (spatial >= 0.55) signals.push('spatial_consistent_crop');
    if (geometric >= 0.55) signals.push('geometric_verified');
    if (patchMatchCount >= 30) signals.push('high_patch_density');
    if (patchMatchCount >= 100) signals.push('dominant_vault_votes');

    hits.push({
      vaultId: idx.vaultId,
      dnaRecordId: idx.dnaRecordId,
      ownerUserId: idx.ownerUserId,
      filename: idx.dnaRecord.imageFilename,
      patchMatchCount,
      probePatchCount: probePatches.length,
      vaultPatchCount: vaultPatches.length,
      matchRatio: Math.round(matchRatio * 1000) / 1000,
      coverageRatio: Math.round(coverageRatio * 1000) / 1000,
      spatialConsistency: Math.round(spatial * 1000) / 1000,
      geometricScore: Math.round(geometric * 1000) / 1000,
      orbRefineScore: 0,
      compositeScore,
      signals,
    });
  }
  return hits;
}
