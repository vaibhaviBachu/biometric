const prismaMock = {
  dnaRecord: { findUnique: jest.fn() },
  $queryRaw: jest.fn(),
};
const findWatermarkCopy = jest.fn();

jest.mock('../../src/lib/prisma', () => ({ prisma: prismaMock }));
jest.mock('../../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/services/dna-vnext/watermark-index', () => ({ findWatermarkCopy }));

import { scanByVerifyId } from '../../src/services/scan/public-scan.service';
import { toPublicScanBody, LINK_MESSAGE } from '../../src/services/scan/public-scan-decision';

const ID = 'a1b2c3d4e5f60718';
const PRIVATE = ['email', 'ownerEmail', 'address', 'ownerUserId', 'dnaRecordId', 'vaultId', 'recipientEmail'];

function prefs(optOut: boolean, showTitle = false, showRecipient = false) {
  prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('"publicScanOptOut"')) return [{ optOut, showTitle, showRecipient }];
    if (sql.includes('"recipientLabel"')) return [{ recipientLabel: 'Studio Client' }];
    return [];
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  findWatermarkCopy.mockResolvedValue({
    lookupId: ID, vaultId: 'v1', dnaRecordId: 'rec-1', ownerUserId: 'u1',
    ownerShortId: 'PINIT-SAMPLE01', filename: 'banner.png', recipientLabel: 'Studio Client',
  });
  prismaMock.dnaRecord.findUnique.mockResolvedValue({ createdAt: new Date('2026-08-12T05:12:00Z'), imageFilename: 'banner.png' });
  prefs(false);
});

describe('verify link lookup', () => {
  test('names the owner but is only ever a link-only result, never a confirmed match', async () => {
    const draft = await scanByVerifyId(ID);
    expect(draft).toMatchObject({ verdict: 'possible', viaLink: true, ownerPinitId: 'PINIT-SAMPLE01' });
    const body = toPublicScanBody(draft);
    expect(body.message).toBe(LINK_MESSAGE);
    expect(body.viaLink).toBe(true);
    expect(body.matchStrength).toBeUndefined();
    expect(body.title).toBeUndefined();
    expect(body.recipientLabel).toBeUndefined();
    for (const key of PRIVATE) expect(body).not.toHaveProperty(key);
  });

  test('owner-approved title and recipient appear only when allowed', async () => {
    prefs(false, true, true);
    const body = toPublicScanBody(await scanByVerifyId(ID));
    expect(body.title).toBe('banner.png');
    expect(body.recipientLabel).toBe('Studio Client');
  });

  test('an owner who opted out is not found', async () => {
    prefs(true);
    expect((await scanByVerifyId(ID)).verdict).toBe('not_found');
  });

  test('an unknown ID or a malformed one is not found, and malformed IDs never reach the database', async () => {
    findWatermarkCopy.mockResolvedValue(null);
    expect((await scanByVerifyId(ID)).verdict).toBe('not_found');
    findWatermarkCopy.mockClear();
    for (const bad of ['', 'xyz', ID.toUpperCase().replace(/[A-F]/g, 'G'), `${ID}00`, "a1b2c3d4e5f6071'"]) {
      expect((await scanByVerifyId(bad)).verdict).toBe('not_found');
    }
    expect(findWatermarkCopy).not.toHaveBeenCalled();
  });

  test('a database failure fails soft to not found', async () => {
    findWatermarkCopy.mockRejectedValue(new Error('db down'));
    expect((await scanByVerifyId(ID)).verdict).toBe('not_found');
  });
});
