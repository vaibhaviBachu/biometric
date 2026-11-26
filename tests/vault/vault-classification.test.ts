import sharp from 'sharp';

const findUnique = jest.fn();
const updateMany = jest.fn();
jest.mock('../../src/lib/prisma', () => ({
  prisma: { vaultRecord: { findUnique: (...a: unknown[]) => findUnique(...a), updateMany: (...a: unknown[]) => updateMany(...a) } },
}));

import { readVaultContent, MAX_READ_BYTES, type ContentReaderDeps } from '../../src/services/vault/vault-content-reader';
import { classifyVaultRecord } from '../../src/services/vault/vault-classification.service';

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toBuffer();
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    originalFileName: 'IMG_1001.jpg',
    originalMimeType: 'image/jpeg',
    originalSizeBytes: 1000,
    encryptedFilePath: 'x',
    contentLabel: null,
    contentAnalysis: null,
    folder: null,
    folderSource: null,
    folderStatus: 'pending',
    dnaRecord: { ownerUserId: 'u1', ocrRecord: null, metadataLayer: null },
    ...overrides,
  };
}

function deps(over: Partial<ContentReaderDeps> = {}): ContentReaderDeps {
  return {
    loadBytes: jest.fn(async () => tinyPng()),
    ocrImage: jest.fn(async () => ''),
    rasterizePdf: jest.fn(async () => null),
    ...over,
  };
}

beforeEach(() => {
  findUnique.mockReset();
  updateMany.mockReset().mockResolvedValue({ count: 1 });
});

describe('readVaultContent (bounded, read-only)', () => {
  it('does not decrypt files above the size limit', async () => {
    const d = deps();
    const read = await readVaultContent({ fileName: 'big.pdf', mimeType: 'application/pdf', sizeBytes: MAX_READ_BYTES + 1 }, d);
    expect(read.contentRead).toBe(false);
    expect(read.method).toBe('skipped-too-large');
    expect(d.loadBytes).not.toHaveBeenCalled();
  });

  it('does not decrypt audio or video — the type is the content', async () => {
    const d = deps();
    const read = await readVaultContent({ fileName: 'a.m4a', mimeType: 'audio/mp4', sizeBytes: 5_000_000 }, d);
    expect(read.method).toBe('type-only');
    expect(d.loadBytes).not.toHaveBeenCalled();
  });

  it('reads images with OCR on a downscaled copy and never changes the original bytes', async () => {
    const original = await tinyPng();
    const snapshot = Buffer.from(original);
    const d = deps({ loadBytes: jest.fn(async () => original), ocrImage: jest.fn(async () => 'Unique Identification Authority of India') });
    const read = await readVaultContent({ fileName: 'x.png', mimeType: 'image/png', sizeBytes: original.length }, d);
    expect(read.method).toBe('image-ocr');
    expect(read.text).toContain('Unique Identification');
    expect(original.equals(snapshot)).toBe(true);
  });

  it('renders and reads a scanned PDF when it has no text layer', async () => {
    const page = await tinyPng();
    const d = deps({
      loadBytes: jest.fn(async () => Buffer.from('%PDF-1.4 not really a pdf')),
      rasterizePdf: jest.fn(async () => [page]),
      ocrImage: jest.fn(async () => 'Statement of Marks Semester VI SGPA 8.4'),
    });
    const read = await readVaultContent({ fileName: 'scan.pdf', mimeType: 'application/pdf', sizeBytes: 2000 }, d);
    expect(read.method).toBe('scan-ocr');
    expect(read.contentRead).toBe(true);
    expect(d.rasterizePdf).toHaveBeenCalledWith(expect.any(Buffer), 'scan.pdf', 2);
  });

  it('reports a scanned PDF as unreadable when pages cannot be rendered', async () => {
    const d = deps({ loadBytes: jest.fn(async () => Buffer.from('%PDF-1.4')), rasterizePdf: jest.fn(async () => null) });
    const read = await readVaultContent({ fileName: 'scan.pdf', mimeType: 'application/pdf', sizeBytes: 2000 }, d);
    expect(read.contentRead).toBe(false);
  });
});

describe('classifyVaultRecord', () => {
  it('auto-files an Aadhaar photo into Identity & IDs from its contents', async () => {
    findUnique.mockResolvedValue(row());
    const decision = await classifyVaultRecord('v1', {
      deps: deps({ ocrImage: jest.fn(async () => 'Government of India Unique Identification Authority of India Aadhaar') }),
    });
    expect(decision?.folder).toBe('ids');
    const data = updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ folder: 'ids', folderStatus: 'auto_filed', folderSource: 'auto' });
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain('Unique Identification');
  });

  it('only writes when the owner has not filed the file themselves', async () => {
    findUnique.mockResolvedValue(row());
    await classifyVaultRecord('v1', { deps: deps() });
    const where = updateMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('"folderSource":{"not":"user"}');
  });

  it('leaves a file the owner filed alone', async () => {
    findUnique.mockResolvedValue(row({ folder: 'education', folderSource: 'user', folderStatus: 'confirmed' }));
    const decision = await classifyVaultRecord('v1', { deps: deps() });
    expect(decision).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('a large file is filed from name and type only — a sensitive name keeps it private', async () => {
    findUnique.mockResolvedValue(row({ originalFileName: 'aadhaar_scan.pdf', originalMimeType: 'application/pdf', originalSizeBytes: MAX_READ_BYTES + 10 }));
    const d = deps();
    const decision = await classifyVaultRecord('v1', { deps: d });
    expect(d.loadBytes).not.toHaveBeenCalled();
    expect(decision?.folder).toBe('ids');
    expect(updateMany.mock.calls[0][0].data.folderStatus).toBe('auto_filed');
  });

  it('a large file with a plain name is never auto-filed when unsure', async () => {
    findUnique.mockResolvedValue(row({ originalFileName: 'scan_0031.pdf', originalMimeType: 'application/pdf', originalSizeBytes: MAX_READ_BYTES + 10 }));
    const d = deps();
    const decision = await classifyVaultRecord('v1', { deps: d });
    expect(d.loadBytes).not.toHaveBeenCalled();
    expect(decision?.folder).toBe('tosort');
    expect(updateMany.mock.calls[0][0].data.folderStatus).toBe('suggested');
  });

  it('a reading failure sends the file to To sort as failed, keeping a safe guess', async () => {
    findUnique.mockResolvedValue(row({ originalFileName: 'adhar.jpg' }));
    const decision = await classifyVaultRecord('v1', {
      deps: deps({ loadBytes: jest.fn(async () => { throw new Error('storage unavailable'); }) }),
    });
    expect(decision).toBeNull();
    const data = updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ folder: 'tosort', folderStatus: 'failed', folderSuggestion: 'ids' });
  });

  it('does nothing for a file that no longer exists', async () => {
    findUnique.mockResolvedValue(null);
    expect(await classifyVaultRecord('gone', { deps: deps() })).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
