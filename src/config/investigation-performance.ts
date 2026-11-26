/**
 * Unified Investigation performance tuning — two-stage retrieval + parallelism.
 */
function intEnv(key: string, fallback: number): number {
  const n = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Same as intEnv, but clamps below `floor`. A misconfigured/legacy env var
 * (e.g. an old, too-tight timeout) can otherwise silently starve a stage —
 * this makes that class of bug impossible instead of just documented.
 */
function minIntEnv(key: string, fallback: number, floor: number): number {
  return Math.max(floor, intEnv(key, fallback));
}

function flag(key: string, defaultValue = true): boolean {
  const v = (process.env[key] ?? '').trim().toLowerCase();
  if (!v) return defaultValue;
  return v === '1' || v === 'true' || v === 'yes';
}

function scalesFromEnv(key: string, fallback: number[]): number[] {
  const raw = (process.env[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n >= 8 && n <= 256);
  return parsed.length ? parsed : fallback;
}

export const investigationPerformanceConfig = {
  /** Stage-1 fast filter: max vault candidates passed to heavy retrieval */
  candidatePoolSize: intEnv('PINIT_INVESTIGATION_CANDIDATE_POOL', 25),
  /** When watermark/token already found vault — cap stage-2 pool */
  candidatePoolWithIdentity: intEnv('PINIT_INVESTIGATION_IDENTITY_POOL', 8),
  candidatePoolMin: 10,
  candidatePoolMax: 50,
  /** ORB refine on top-K of filtered pool only */
  orbRefineTopK: intEnv('PINIT_INVESTIGATION_ORB_TOP_K', 5),
  /** 15-layer deep compare cap */
  deepCompareTopN: intEnv('PINIT_INVESTIGATION_DEEP_COMPARE_TOP_N', 6),
  /** Max forensic variants for investigation local-DNA probes */
  maxInvestigationProbes: intEnv('PINIT_INVESTIGATION_MAX_PROBES', 3),
  /** ORB refinement improves crop/screenshot matching accuracy */
  skipOrbInInvestigation: flag('PINIT_INVESTIGATION_SKIP_ORB', false),
  /**
   * Skip local patch search only for hard identity anchors (watermark/token/SHA/manifest).
   * Never skip for vector-only leads — crops need patch DNA to avoid lookalike vaults.
   */
  skipLocalDnaWhenWatermark: flag('PINIT_INVESTIGATION_SKIP_LOCAL_DNA_WATERMARK', true),
  /** Skip second-pass vector ORB when identity anchor present */
  skipVectorOrbWhenWatermark: flag('PINIT_INVESTIGATION_SKIP_VECTOR_ORB_WATERMARK', true),
  /** OCR on tampered screenshots is slow — vault patch DNA handles identification */
  skipInvestigationOcr: flag('PINIT_INVESTIGATION_SKIP_OCR', true),
  /** Per-signal caps during parallel identity recovery */
  watermarkTimeoutMs: intEnv('PINIT_INVESTIGATION_WATERMARK_TIMEOUT_MS', 5_000),
  embeddingTimeoutMs: intEnv('PINIT_INVESTIGATION_EMBEDDING_TIMEOUT_MS', 5_000),
  /** Local patch search time budget (tampered / compressed probes) */
  localDnaTimeoutMs: intEnv('PINIT_INVESTIGATION_LOCAL_DNA_TIMEOUT_MS', 90_000),
  /**
   * The candidate-recall step reuses the Trace's patch search. When that search could not answer (timed out, skipped) or
   * looked only at the shortlist, recall gets ONE extra patch search (of the pictures not yet scored) and stops waiting for it
   * after this long. Before 2026-11-16 it ran a second, unlimited whole-vault search (68–347 s).
   */
  recallPatchSearchBudgetMs: intEnv('PINIT_INVESTIGATION_RECALL_PATCH_BUDGET_MS', 30_000),
  /**
   * Candidate recall runs its providers side by side and waits for all of them, so one slow provider held the whole step
   * (347 s on 2026-11-16). Each provider is now stopped (its signal aborted) after this long and counts as "no candidates".
   */
  recallProviderBudgetMs: intEnv('PINIT_INVESTIGATION_RECALL_PROVIDER_BUDGET_MS', 60_000),
  /** Per-candidate 15-layer DNA — must exceed real compare time on Render + AI cold start */
  deepCompareTimeoutMs: intEnv('PINIT_INVESTIGATION_DEEP_COMPARE_TIMEOUT_MS', 45_000),
  /**
   * Image enterprise recovery — local DNA + deep DNA + ORB (Render needs headroom).
   * Floored at 120s: the AI sidecar alone has a measured ~51.5s cold start, so anything
   * tighter reliably times this stage out before real comparison work even starts.
   */
  imageRecoveryTimeoutMs: minIntEnv('PINIT_INVESTIGATION_IMAGE_RECOVERY_MS', 150_000, 120_000),
  /** Video partial recovery — enterprise stage budget (same cold-start floor applies) */
  videoRecoveryTimeoutMs: minIntEnv('PINIT_INVESTIGATION_VIDEO_RECOVERY_MS', 180_000, 120_000),
  /**
   * Minimum pixel-match coverage (from the fast vault-vs-probe pixel comparison, not the
   * slow deep-DNA pipeline) required to report "this image matches your vault" on its own,
   * even if the deep ownership/certificate pipeline hasn't finished or timed out.
   */
  pixelMatchFoundThresholdPercent: intEnv('PINIT_INVESTIGATION_PIXEL_MATCH_THRESHOLD_PCT', 20),
  /**
   * Minimum pixel-match coverage required to skip the slow deep-DNA/ORB/AI-ensemble
   * pipeline entirely and answer immediately from the fast vault lead alone. Higher
   * than pixelMatchFoundThresholdPercent on purpose — this decides whether to trust
   * a fast answer as the FINAL answer, not just whether to show a percentage alongside
   * an otherwise-incomplete result. Ambiguous cases below this bar still go through
   * the full pipeline unchanged.
   */
  pixelMatchFastPathThresholdPercent: intEnv('PINIT_INVESTIGATION_PIXEL_FAST_PATH_THRESHOLD_PCT', 35),
  /** Post-retrieval report enrichment (timeline, crawler) — Render/Supabase needs headroom */
  orchestratorEnrichmentTimeoutMs: intEnv('PINIT_INVESTIGATION_ENRICHMENT_TIMEOUT_MS', 20_000),
  /** Skip crawler monitor scan during unified investigation (major latency win) */
  skipCrawlerOnInvestigation: flag('PINIT_INVESTIGATION_SKIP_CRAWLER', true),
  /** Never re-run 15-layer compare when enterprise pipeline already compared this vault */
  skipOrchestratorRecompare: flag('PINIT_INVESTIGATION_SKIP_RECOMPARE', true),
  orchestratorCompareTimeoutMs: intEnv('PINIT_INVESTIGATION_ORCHESTRATOR_COMPARE_MS', 20_000),
  vaultRetrieveTimeoutMs: intEnv('PINIT_INVESTIGATION_VAULT_RETRIEVE_MS', 12_000),
  /** Multi-scale patch retrieval for crop/screenshot recovery */
  investigationPatchScales: scalesFromEnv('PINIT_INVESTIGATION_PATCH_SCALES', [32, 64, 128]),
  cacheTtlMs: intEnv('PINIT_INVESTIGATION_CACHE_TTL_MS', 900_000),
} as const;

export function clampCandidatePool(size?: number): number {
  const n = size ?? investigationPerformanceConfig.candidatePoolSize;
  return Math.max(
    investigationPerformanceConfig.candidatePoolMin,
    Math.min(investigationPerformanceConfig.candidatePoolMax, n),
  );
}
