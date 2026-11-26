/** In-memory stand-ins for the large-file database tables. */
import crypto from 'crypto';
import type { LargeFileManifest, LargeFileManifestRepository, ManifestStorage } from '../../src/services/large-files/large-file-manifest.repository';
import type { FileDigest } from '../../src/services/large-files/stream-digest';
import type { AnalysisMode, SampledSegment } from '../../src/services/large-files/analysis-input';

export class FakeManifests {
  readonly manifests = new Map<string, LargeFileManifest>();
  readonly chunks = new Map<string, string[]>();

  async create(input: {
    dnaRecordId: string; ownerUserId: string; filename: string; mimeType: string;
    digest: FileDigest; analysisMode: AnalysisMode; segments: SampledSegment[];
  }): Promise<string> {
    const id = crypto.randomUUID();
    this.manifests.set(id, {
      id,
      dnaRecordId: input.dnaRecordId,
      vaultId: null,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.digest.sizeBytes,
      sha256: input.digest.sha256,
      chunkSizeBytes: input.digest.chunkSizeBytes,
      chunkCount: input.digest.chunkDigests.length,
      merkleRoot: input.digest.merkleRoot,
      analysisMode: input.analysisMode,
      sampling: { segments: input.segments },
      storage: null,
      createdAt: new Date(),
    });
    this.chunks.set(id, [...input.digest.chunkDigests]);
    return id;
  }

  async attachVault(manifestId: string, vaultId: string, storage: ManifestStorage): Promise<void> {
    const m = this.manifests.get(manifestId)!;
    m.vaultId = vaultId;
    m.storage = storage;
  }

  async findByVaultId(vaultId: string): Promise<LargeFileManifest | null> {
    return Array.from(this.manifests.values()).find((m) => m.vaultId === vaultId) ?? null;
  }

  async chunkDigests(manifestId: string): Promise<string[]> {
    return this.chunks.get(manifestId) ?? [];
  }

  async matchChunks(ownerUserId: string, digests: string[]) {
    const wanted = new Set(digests);
    const out: Array<{ manifestId: string; chunkIndex: number; sha256: string }> = [];
    for (const [id, list] of this.chunks) {
      if (this.manifests.get(id)!.ownerUserId !== ownerUserId) continue;
      list.forEach((sha256, chunkIndex) => { if (wanted.has(sha256)) out.push({ manifestId: id, chunkIndex, sha256 }); });
    }
    return out;
  }

  async findManyByIds(ownerUserId: string, ids: string[]) {
    return ids.map((id) => this.manifests.get(id)).filter((m): m is LargeFileManifest => Boolean(m && m.ownerUserId === ownerUserId));
  }

  asRepository(): LargeFileManifestRepository {
    return this as unknown as LargeFileManifestRepository;
  }
}
