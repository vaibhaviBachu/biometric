/**
 * Every DnaRecord column EXCEPT `fileAnalysis`, for reads that do not need it.
 *
 * `fileAnalysis` holds the block-DNA manifest (`pinitBlockDnaV1`) and a heatmap: 0.8 MB on average, up to 1.6 MB per row
 * (measured 2026-11-17). A read with `include:` (or no select) carries every column, so each one moved that blob across the
 * network for nothing: a Trace made ~57 such reads (several `findMany` over the whole vault), up to 3 s each with realistic
 * latency. Use it as `select: { ...DNA_RECORD_COLUMNS, someLayer: true }` in place of `include: { someLayer: true }`.
 *
 * tests/lib/dna-record-columns.test.ts fails if a column is added to the schema and not here.
 */
import type { Prisma } from '@prisma/client';

export const DNA_RECORD_COLUMNS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  imageFilename: true,
  imageMimeType: true,
  imageSizeBytes: true,
  imageWidthPx: true,
  imageHeightPx: true,
  fileType: true,
  engineVersion: true,
  universalFingerprints: true,
  sha256Hash: true,
  schemaVersion: true,
  status: true,
  ownerUserId: true,
  organizationId: true,
  workspaceId: true,
  departmentId: true,
  documentDnaRecordId: true,
  pageNumber: true,
  publicScanOptOut: true,
  publicScanShowTitle: true,
  publicScanShowRecipient: true,
  fileAnalysisLabel: true,
  videoDnaRecordId: true,
  frameIndex: true,
  frameTimestampMs: true,
  cameraForensics: true,
} as const satisfies Prisma.DnaRecordSelect;
