/**
 * PINIT-DNA — File Upload Middleware (Multer)
 *
 * Phase 0+: Accepts ALL supported file types, not just images.
 * The UniversalFileRouter (downstream) enforces which types have live engines.
 *
 * Two named exports:
 *   uploadSingle — legacy field name "image" (backward compatible with all
 *                  existing routes and the frontend)
 *   uploadFile   — universal alias using field name "file" (for new routes)
 *
 * Both share the same storage, filter, and size limits.
 *
 * Every export below also converts a HEIC phone photo to JPEG once it has landed on disk (heic-upload.middleware.ts).
 */

import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';
import { config } from '../../config';
import { mimeMatchesAllowed } from '../../lib/mime-normalize';
import { largeFileConfig } from '../../config/large-files';
import { withHeicConversion } from './heic-upload.middleware';

// Ensure temp directory exists at startup
if (!fs.existsSync(config.upload.tempDir)) {
  fs.mkdirSync(config.upload.tempDir, { recursive: true });
}

// ─── Shared disk storage ──────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.upload.tempDir),
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    // Include random suffix so two files in the same request (e.g. compare)
    // never collide on the same disk filename.
    const random = Math.random().toString(36).slice(2, 8);
    const ext = path.extname(file.originalname);
    cb(null, `dna_${timestamp}_${random}${ext}`);
  },
});

// ─── MIME filter — accepts all types known to the supported-file-types config ─

const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
): void => {
  if (mimeMatchesAllowed(file.mimetype, config.upload.allowedMimeTypes, file.originalname)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Unsupported file type: "${file.mimetype}" (${file.originalname}). ` +
        `Supported: IMAGE, PDF, DOCX, PPTX, TXT, HTML, CSV, JSON, ZIP, VIDEO, AUDIO. ` +
        `Check GET /api/v1/dna/supported-types for the full MIME list.`
      )
    );
  }
};

// ─── Multer instance (shared config) ─────────────────────────────────────────

const multerInstance = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.upload.maxFileSizeBytes },
});

/**
 * uploadSingle — field name "image"
 * Used by all existing routes.  Backward compatible with the frontend.
 */
export const uploadSingle = withHeicConversion(multerInstance.single('image'));

/**
 * uploadInvestigation — unified investigation uploads, streamed to disk.
 *
 * Memory storage held the whole probe in RAM, so a large probe could take the server down. Probes now land in the
 * OS temp directory (not the project's tmp/, which can sit under OneDrive and race with sync); the controller reads
 * small probes into memory as before and streams large ones (docs/LARGE_FILE_STREAMING_PROTECTION.md).
 */
fs.mkdirSync(largeFileConfig.investigationTempDir, { recursive: true });
const investigationMulter = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, largeFileConfig.investigationTempDir),
    filename: (_req, file, cb) => {
      const random = Math.random().toString(36).slice(2, 10);
      cb(null, `probe_${Date.now()}_${random}${path.extname(file.originalname).slice(0, 16)}`);
    },
  }),
  fileFilter,
  limits: { fileSize: largeFileConfig.maxUploadBytes },
});
export const uploadInvestigation = withHeicConversion(investigationMulter.single('image'));

/**
 * uploadFile — field name "file"
 * Use this for new Universal DNA routes that are not image-specific.
 */
export const uploadFile = withHeicConversion(multerInstance.single('file'));

/**
 * Asset protection uploads — no fixed per-file size limit.
 *
 * Product decision: an asset may be any size. What limits protection is the
 * owner's available Vault storage, which the protect handlers check against the
 * real file size before any work starts (entitlementService.assertStorageAvailable).
 * Files still stream to disk, so the parser holds no upload in memory.
 *
 * Every other upload route keeps uploadSingle / uploadFile and their existing limit.
 */
const assetMulterInstance = multer({ storage, fileFilter });

/** Asset protection upload — field name "image". */
export const uploadAsset = withHeicConversion(assetMulterInstance.single('image'));

/** Asset protection upload — field name "file". */
export const uploadAssetFile = withHeicConversion(assetMulterInstance.single('file'));

/**
 * uploadComparison — two fields: "fileA" and "fileB"
 * Used exclusively by POST /api/v1/dna/compare
 */
export const uploadComparison = withHeicConversion(multerInstance.fields([
  { name: 'fileA', maxCount: 1 },
  { name: 'fileB', maxCount: 1 },
]));
