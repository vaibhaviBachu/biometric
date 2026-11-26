/**
 * Converts HEIC uploads to JPEG right after multer has written them to disk (see src/lib/heic.ts for why).
 *
 * It looks at the file's own header, never its name or declared type: a phone photo can be HEIC inside and still be called
 * ".jpg". The file on disk is replaced in place, and the multer file entry (name, type, size) is updated to match, so every
 * handler after this one sees a normal JPEG. A HEIC that cannot be read is refused up front with a clear message, instead of
 * being protected only in part.
 */

import fs from 'fs/promises';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from './error.middleware';
import { logger } from '../../lib/logger';
import { HeicConversionError, heicToJpeg, isHeicHeader, maxHeicMegapixels } from '../../lib/heic';

function uploadedFiles(req: Request): Express.Multer.File[] {
  const out: Express.Multer.File[] = [];
  if (req.file) out.push(req.file);
  const files = req.files as Express.Multer.File[] | Record<string, Express.Multer.File[]> | undefined;
  if (Array.isArray(files)) out.push(...files);
  else if (files) for (const list of Object.values(files)) out.push(...list);
  return out;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** "IMG_1.HEIC" and "IMG_1.jpg" both become "IMG_1.jpg"; a name with no extension gets one. */
export function jpegFileName(name: string): string {
  return /\.(heic|heif|hif|jpe?g)$/i.test(name) ? name.replace(/\.(heic|heif|hif|jpe?g)$/i, '.jpg') : `${name}.jpg`;
}

export async function convertHeicUploads(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    for (const file of uploadedFiles(req)) {
      if (!file.path || !isHeicHeader(await readHead(file.path, 64))) continue;
      const started = Date.now();
      try {
        const converted = await heicToJpeg(await fs.readFile(file.path));
        await fs.writeFile(file.path, converted.buffer);
        logger.info('HEIC upload converted to JPEG', {
          file: file.originalname,
          fromBytes: file.size,
          toBytes: converted.buffer.length,
          width: converted.width,
          height: converted.height,
          exifCopied: converted.exifCopied,
          iccCopied: converted.iccCopied,
          ms: Date.now() - started,
        });
        file.size = converted.buffer.length;
        file.mimetype = 'image/jpeg';
        file.originalname = jpegFileName(file.originalname);
      } catch (err) {
        await fs.unlink(file.path).catch(() => undefined);
        const reason = err instanceof HeicConversionError ? err.reason : 'unreadable';
        logger.warn('HEIC upload refused', { file: file.originalname, bytes: file.size, reason, error: err instanceof Error ? err.message : String(err) });
        for (const other of uploadedFiles(req)) if (other !== file && other.path) await fs.unlink(other.path).catch(() => undefined);
        return next(new AppError(
          422,
          reason === 'too_large'
            ? `This HEIC photo is too large to convert here (over ${maxHeicMegapixels()} megapixels). Export it as a JPEG and try again.`
            : 'This HEIC photo could not be read. It may be damaged or cut off. Export it as a JPEG, or share it again from your gallery, and try again.',
        ));
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Runs the given multer handler, then the HEIC conversion. Safe to call as a plain function, as some routes do. */
export function withHeicConversion(upload: RequestHandler): RequestHandler {
  return (req, res, next) => {
    upload(req, res, (err?: unknown) => {
      if (err) return next(err);
      void convertHeicUploads(req, res, next);
    });
  };
}
