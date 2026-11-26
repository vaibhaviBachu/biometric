const prismaMock = {
  dnaRecord: { findMany: jest.fn() },
  cryptoLayer: { findMany: jest.fn() },
  perceptualLayer: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};
const extractLoose = jest.fn();
const extractFromFile = jest.fn();
const generate = jest.fn();
const extractWatermarkMatch = jest.fn();

jest.mock('../../src/lib/prisma', () => ({ prisma: prismaMock }));
jest.mock('../../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/services/identity/identity-embedding.service', () => ({ identityEmbeddingService: { extractLoose } }));
jest.mock('../../src/services/tep/tep.service', () => ({ tepService: { extractFromFile } }));
jest.mock('../../src/services/layers/layer1.cryptographic', () => ({ CryptographicLayer: jest.fn().mockImplementation(() => ({ generate })) }));
jest.mock('../../src/services/dna-vnext/robust-watermark', () => ({ extractWatermarkMatch }));
jest.mock('../../src/services/dna-vnext/watermark-index', () => ({ findWatermarkCopy: jest.fn() }));

import '../watermark/helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { directVerdict, findDirectHit } from '../../src/services/scan/public-scan-direct';
import { scanPublicImage } from '../../src/services/scan/public-scan.service';
import { toPublicScanBody } from '../../src/services/scan/public-scan-decision';

const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const early = new Date('2026-08-12T05:12:00Z');
const late = new Date('2026-09-20T09:00:00Z');

function record(id: string, owner: string, createdAt: Date) {
  return { id, createdAt, imageFilename: `${id}.jpg`, ownerUser: { shortId: owner } };
}

beforeEach(() => {
  jest.resetAllMocks();
  extractWatermarkMatch.mockResolvedValue(null);
  extractLoose.mockResolvedValue({ found: false });
  extractFromFile.mockResolvedValue({ found: false });
  generate.mockResolvedValue({ success: false });
  prismaMock.dnaRecord.findMany.mockResolvedValue([]);
  prismaMock.cryptoLayer.findMany.mockResolvedValue([]);
  prismaMock.perceptualLayer.findMany.mockResolvedValue([]);
  prismaMock.$queryRaw.mockResolvedValue([]);
});

describe('direct checks for the public scanner', () => {
  test('a valid identity in the file is Protected and a damaged one is only Possible', async () => {
    extractLoose.mockResolvedValue({ found: true, dnaId: 'rec-1', valid: true });
    const ok = await findDirectHit(image, 'image/jpeg');
    expect(ok).toMatchObject({ method: 'EMBEDDED_IDENTITY', dnaRecordIds: ['rec-1'], verified: true, strength: 99 });
    expect(directVerdict(ok!)).toBe('protected');

    extractLoose.mockResolvedValue({ found: true, dnaId: 'rec-1', valid: false });
    const bad = await findDirectHit(image, 'image/jpeg');
    expect(directVerdict(bad!)).toBe('possible');
  });

  test('exact bytes are searched across every owner, not one vault', async () => {
    prismaMock.dnaRecord.findMany.mockResolvedValue([{ id: 'rec-a' }]);
    prismaMock.cryptoLayer.findMany.mockResolvedValue([{ dnaRecordId: 'rec-b' }]);
    const hit = await findDirectHit(image, 'image/jpeg');
    expect(hit?.method).toBe('EXACT_HASH');
    expect(hit?.dnaRecordIds.sort()).toEqual(['rec-a', 'rec-b']);
    const where = JSON.stringify(prismaMock.dnaRecord.findMany.mock.calls[0][0].where);
    expect(where).not.toContain('ownerUserId');
  });

  test('a tracked export marker and the same pixels are found when earlier checks miss', async () => {
    extractFromFile.mockResolvedValue({ found: true, dnaRecordId: 'rec-t', valid: true });
    expect((await findDirectHit(image, 'image/jpeg'))?.method).toBe('TEP_EXPORT');

    extractFromFile.mockResolvedValue({ found: false });
    generate.mockResolvedValue({ success: true, data: { normalizedHash: 'n'.repeat(64) } });
    prismaMock.cryptoLayer.findMany.mockImplementation(async (args: { where: { normalizedHash?: string } }) =>
      args.where.normalizedHash ? [{ dnaRecordId: 'rec-n' }] : []);
    const same = await findDirectHit(image, 'image/jpeg');
    expect(same).toMatchObject({ method: 'NORMALIZED_HASH', dnaRecordIds: ['rec-n'], verified: true });
  });

  test('a check that throws is skipped and the next one still runs', async () => {
    extractLoose.mockRejectedValue(new Error('boom'));
    extractFromFile.mockResolvedValue({ found: true, dnaRecordId: 'rec-t', valid: true });
    expect((await findDirectHit(image, 'image/jpeg'))?.method).toBe('TEP_EXPORT');
  });

  test('nothing found returns null', async () => {
    expect(await findDirectHit(image, 'image/jpeg')).toBeNull();
  });
});

describe('scanPublicImage with a file-level hit', () => {
  function optOutRows(optOutIds: string[]) {
    prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('"publicScanOptOut"')) {
        const id = String(values[0]);
        return [{ optOut: optOutIds.includes(id), showTitle: false, showRecipient: false }];
      }
      return [];
    });
  }

  test('names the earliest registration and flags that another exists', async () => {
    extractLoose.mockResolvedValue({ found: false });
    prismaMock.dnaRecord.findMany.mockImplementation(async (args: { where: { sha256Hash?: string; id?: unknown } }) => {
      if (args.where.sha256Hash) return [{ id: 'rec-late' }, { id: 'rec-early' }];
      return [record('rec-late', 'Second Owner', late), record('rec-early', 'PINIT-FIRST001', early)];
    });
    optOutRows([]);
    const draft = await scanPublicImage(image, 'image/jpeg');
    expect(draft).toMatchObject({ verdict: 'protected', ownerPinitId: 'PINIT-FIRST001', anotherRegistration: true });
    expect(draft.protectedAt).toBe(early.toISOString());
    const body = toPublicScanBody(draft);
    expect(Object.keys(body).sort()).toEqual(['anotherRegistration', 'matchStrength', 'message', 'ownerPinitId', 'protectedAt', 'success', 'verdict']);
  });

  test('an owner who opted out is not named', async () => {
    prismaMock.dnaRecord.findMany.mockImplementation(async (args: { where: { sha256Hash?: string } }) =>
      args.where.sha256Hash ? [{ id: 'rec-early' }] : [record('rec-early', 'PINIT-FIRST001', early)]);
    optOutRows(['rec-early']);
    const draft = await scanPublicImage(image, 'image/jpeg');
    expect(draft.verdict).toBe('not_found');
    expect(draft.ownerPinitId).toBeUndefined();
  });

  test('a non-image is still not scanned', async () => {
    expect((await scanPublicImage(Buffer.from('x'), 'application/pdf')).verdict).toBe('not_found');
  });
});
