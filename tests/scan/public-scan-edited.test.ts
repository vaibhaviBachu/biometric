/**
 * The scan, end to end with its dependencies mocked: an edited copy that fails the picture fingerprint is found by
 * feature points and reported "Protected" when the alignment is strong, "Possible" when it is weaker.
 */
const mockQueryRaw = jest.fn();
const mockPerceptualFindMany = jest.fn();
const mockDnaFindMany = jest.fn();
const mockDnaFindUnique = jest.fn();
const mockDnaFindFirst = jest.fn();
const mockFeatureFindMany = jest.fn();
const mockFeatureFindUnique = jest.fn();
const mockVerify = jest.fn();
const mockRetrieve = jest.fn();
const mockExtract = jest.fn();
const mockMatch = jest.fn();
const mockExtractMark = jest.fn();
const mockMatchScreen = jest.fn();

jest.mock('../../src/lib/prisma', () => ({
  prisma: {
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
    perceptualLayer: { findMany: (...a: unknown[]) => mockPerceptualFindMany(...a) },
    dnaRecord: {
      findMany: (...a: unknown[]) => mockDnaFindMany(...a),
      findUnique: (...a: unknown[]) => mockDnaFindUnique(...a),
      findFirst: (...a: unknown[]) => mockDnaFindFirst(...a),
    },
    localFeatureIndex: {
      findMany: (...a: unknown[]) => mockFeatureFindMany(...a),
      findUnique: (...a: unknown[]) => mockFeatureFindUnique(...a),
    },
  },
}));
jest.mock('../../src/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/services/layers/layer3.perceptual', () => ({
  PerceptualLayer: class {
    computeFingerprints = async () => ({ pHash64: '0123456789abcdef', aHash64: '0123456789abcdef', dHash64: '0123456789abcdef' });
    verify = (...a: unknown[]) => mockVerify(...a);
  },
}));
jest.mock('../../src/services/dna-vnext/robust-watermark', () => ({ extractWatermarkMatch: (...a: unknown[]) => mockExtractMark(...a) }));
jest.mock('../../src/services/scan/screen-photo-match', () => ({ matchScreenPhoto: (...a: unknown[]) => mockMatchScreen(...a) }));
jest.mock('../../src/services/dna-vnext/watermark-index', () => ({ findWatermarkCopy: async () => null }));
jest.mock('../../src/services/scan/public-scan-direct', () => ({
  findDirectHit: async () => null,
  directVerdict: () => 'protected',
}));
jest.mock('../../src/services/scan/feature-retrieval', () => ({
  featureRetriever: { retrieve: (...a: unknown[]) => mockRetrieve(...a) },
}));
jest.mock('../../src/services/ai/ai-embeddings.service', () => ({
  aiService: {
    extractLocalDnaIndex: (...a: unknown[]) => mockExtract(...a),
    matchDescriptorSets: (...a: unknown[]) => mockMatch(...a),
  },
}));

import { scanPublicImage } from '../../src/services/scan/public-scan.service';

const D = { keypoints: [{ x: 0.1, y: 0.1, descriptor: 'AA==' }], method: 'opencv_orb' };
const record = (id: string, day: number, shortId = 'AB12CD34') => ({
  id,
  createdAt: new Date(Date.UTC(2026, 9, day)),
  imageFilename: `${id}.jpg`,
  ownerUser: { shortId },
});

/** $queryRaw is used for three different lookups; tell them apart by their SQL. */
function sqlRouter(opts: { optOut?: boolean } = {}) {
  mockQueryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('publicScanOptOut')) return [{ optOut: Boolean(opts.optOut), showTitle: false, showRecipient: false }];
    if (sql.includes('bit_count')) return [];
    return [];
  });
}

function featureWorld(matchFor: (id: string) => unknown, ids = ['asset-1'], records = ids.map((id, i) => record(id, 1 + i))) {
  mockRetrieve.mockResolvedValue({ candidates: ids.map((id) => ({ dnaRecordId: id, votes: 100 })), assetsAvailable: ids.length, assetsChecked: ids.length, cutShort: false });
  mockFeatureFindMany.mockResolvedValue(ids.map((id) => ({ dnaRecordId: id, orbDescriptors: { ...D, id } })));
  mockDnaFindMany.mockImplementation(async (args?: { where?: { id?: { in?: string[] } } }) => {
    const wanted = args?.where?.id?.in;
    return wanted ? records.filter((r) => wanted.includes(r.id)) : records; // like the database: only the ids asked for
  });
  mockDnaFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => records.find((r) => r.id === where.id) ?? null);
  mockDnaFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => records.find((r) => r.id === where.id) ?? null);
  mockMatch.mockImplementation(async (_probe: unknown, cand: { id: string }) => matchFor(cand.id));
}

const IMG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
/** What the AI service reports for a real edit: the aligned points span nearly everything either picture has to match. */
const COV = { probeCoverage: 0.95, referenceCoverage: 0.95 };

beforeEach(() => {
  jest.clearAllMocks();
  sqlRouter();
  mockPerceptualFindMany.mockResolvedValue([]); // the picture fingerprint finds nothing close (an edited copy)
  mockVerify.mockReturnValue(0.5);
  mockExtract.mockResolvedValue({ orbDescriptors: D });
  mockExtractMark.mockResolvedValue(null);
  mockMatchScreen.mockResolvedValue(null);
});

describe('an edited copy that the picture fingerprint cannot find', () => {
  test('a strong, consistent alignment is "Protected" and names the owner', async () => {
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('protected');
    expect(draft.ownerPinitId).toMatch(/AB12CD34/);
    expect(draft.dnaRecordId).toBe('asset-1');
    expect(draft.matchStrength).toBeGreaterThanOrEqual(80);
    expect(draft.anotherRegistration).toBe(false);
  });

  test('a weaker alignment is only "Possible" and names no owner', async () => {
    featureWorld(() => ({ similarity: 0.9, matches: 120, inliers: 90, ratioMatches: 130 }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('possible');
    expect(draft.ownerPinitId).toBeUndefined();
  });

  test('a different picture with many raw matches but no consistent alignment is not found', async () => {
    featureWorld(() => ({ similarity: 0.533, matches: 80, inliers: 20, ratioMatches: 45 }));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('not_found');
  });

  test('an AI service that does not report alignment (older deployment) gives at most "Possible"', async () => {
    featureWorld(() => ({ similarity: 1, matches: 900 }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('possible');
    expect(draft.ownerPinitId).toBeUndefined();
  });

  test('when two registrations of the same picture match, the earliest is shown and the card says another exists', async () => {
    featureWorld(
      () => ({ similarity: 1, matches: 700, inliers: 400, ratioMatches: 450, ...COV }),
      ['late', 'early'],
      [record('late', 20, 'ZZ99ZZ99'), record('early', 3, 'AB12CD34')],
    );
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('protected');
    expect(draft.dnaRecordId).toBe('early');
    expect(draft.ownerPinitId).toMatch(/AB12CD34/);
    expect(draft.anotherRegistration).toBe(true);
  });

  test('an owner who opted out of public scans is never shown', async () => {
    sqlRouter({ optOut: true });
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('not_found');
  });

  test('the AI service being down gives "not found", not an error', async () => {
    mockExtract.mockResolvedValue(null);
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('not_found');
  });
});

describe('a phone photo of a screen (CLIP picks the candidate, SIFT confirms it against the stored original)', () => {
  const screen = (verdict: 'protected' | 'possible', ids = ['asset-1'], over: Record<string, unknown> = {}) => ({
    verdict, dnaRecordIds: ids, clip: 0.82, margin: 0.2, inliers: 120, coverage: 0.6, ...over,
  });
  /** The fingerprint and the feature points find nothing: the picture is a photo of a screen. */
  const nothingElseFinds = () => featureWorld(() => ({ similarity: 0.1, matches: 5, inliers: 0, ratioMatches: 3, ...COV }), ['asset-1']);

  test('a confirmed screen photo is Protected and names the owner, after the same server-side checks', async () => {
    nothingElseFinds();
    mockMatchScreen.mockResolvedValue(screen('protected'));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('protected');
    expect(draft.ownerPinitId).toMatch(/AB12CD34/);
    expect(draft.dnaRecordId).toBe('asset-1');
    expect(draft.matchStrength).toBeLessThanOrEqual(95);
    const where = mockDnaFindMany.mock.calls.at(-1)![0].where;
    expect(where.ownerUserId).toEqual({ not: null });
    expect(where.status).toEqual({ in: ['COMPLETE', 'PARTIAL', 'PROCESSING'] });
  });

  test('a weaker screen result is Possible and names no owner', async () => {
    nothingElseFinds();
    mockMatchScreen.mockResolvedValue(screen('possible', ['asset-1'], { inliers: undefined, coverage: undefined }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('possible');
    expect(draft.ownerPinitId).toBeUndefined();
  });

  test('an inactive registration is never shown, even with strong screen evidence', async () => {
    nothingElseFinds();
    mockMatchScreen.mockResolvedValue(screen('protected'));
    mockDnaFindMany.mockResolvedValue([]);
    mockDnaFindFirst.mockResolvedValue(null);
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('not_found');
  });

  test('an owner with no PINIT identity is not named: the result drops to Possible', async () => {
    featureWorld(() => ({ similarity: 0.1, matches: 5, inliers: 0, ratioMatches: 3 }), ['asset-1'], [{ ...record('asset-1', 1), ownerUser: { shortId: null } } as never]);
    mockMatchScreen.mockResolvedValue(screen('protected'));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('possible');
    expect(draft.ownerPinitId).toBeUndefined();
  });

  test('an owner who opted out of public scans is never shown', async () => {
    sqlRouter({ optOut: true });
    nothingElseFinds();
    mockMatchScreen.mockResolvedValue(screen('protected'));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('not_found');
  });

  test('two registrations of the same picture: the earliest is named and the card says another exists', async () => {
    featureWorld(() => ({ similarity: 0.1, matches: 5, inliers: 0, ratioMatches: 3 }), ['later', 'early'], [record('later', 20, 'ZZ99ZZ99'), record('early', 3, 'AB12CD34')]);
    mockMatchScreen.mockResolvedValue(screen('protected', ['later', 'early']));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('protected');
    expect(draft.dnaRecordId).toBe('early');
    expect(draft.anotherRegistration).toBe(true);
  });

  test('it is only tried when nothing earlier already confirmed the picture', async () => {
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('protected');
    expect(mockMatchScreen).not.toHaveBeenCalled();
  });

  test('it gets only the time the scan has left', async () => {
    nothingElseFinds();
    await scanPublicImage(IMG, 'image/jpeg', 'scan.jpg', { budgetMs: 20_000 });
    const remaining = mockMatchScreen.mock.calls[0]![2] as number;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(20_000);
  });

  test('the step failing cannot fail the scan: the earlier "possible" result is still returned', async () => {
    featureWorld(() => ({ similarity: 0.9, matches: 120, inliers: 90, ratioMatches: 130 }));
    mockMatchScreen.mockRejectedValue(new Error('CLIP model not loaded'));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('possible');
  });

  test('no answer from it leaves the earlier result untouched', async () => {
    featureWorld(() => ({ similarity: 0.9, matches: 120, inliers: 90, ratioMatches: 130 }));
    mockMatchScreen.mockResolvedValue(null);
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('possible');
  });

  test('the screen result never shows an owner unless it is Protected', async () => {
    nothingElseFinds();
    mockMatchScreen.mockResolvedValue(screen('possible', ['asset-1']));
    const { toPublicScanBody } = await import('../../src/services/scan/public-scan-decision');
    const body = toPublicScanBody(await scanPublicImage(IMG, 'image/jpeg'));
    expect(body.verdict).toBe('possible');
    expect(JSON.stringify(body)).not.toMatch(/AB12CD34|ownerPinitId|asset-1|inliers|clip/);
  });
});

describe('a slow server still answers in time, with the best result so far', () => {
  test('a hidden-mark search that never finishes is cut off and the other checks still find the asset', async () => {
    mockExtractMark.mockReturnValue(new Promise(() => undefined)); // never settles
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    const t = Date.now();
    const draft = await scanPublicImage(IMG, 'image/jpeg', 'scan.jpg', { markBudgetMs: 60, budgetMs: 20_000 });
    expect(draft.verdict).toBe('protected');
    expect(Date.now() - t).toBeLessThan(3000);
  });

  test('a hidden-mark search that fails outright is also survived', async () => {
    mockExtractMark.mockRejectedValue(new Error('decode failed'));
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('protected');
  });

  test('when the whole budget is spent on the hidden-mark search, the scan answers at once and skips the feature search', async () => {
    mockExtractMark.mockReturnValue(new Promise(() => undefined));
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    const t = Date.now();
    const draft = await scanPublicImage(IMG, 'image/jpeg', 'scan.jpg', { markBudgetMs: 5000, budgetMs: 120 });
    // Nothing was ruled out, so this is "could not finish", never "not found".
    expect(draft.verdict).toBe('inconclusive');
    expect(draft.inconclusiveReason).toBe('TIMEOUT');
    expect(Date.now() - t).toBeLessThan(1500);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('with INCONCLUSIVE_OUTCOMES=off the same out-of-time scan answers not_found, as it did before', async () => {
    process.env['INCONCLUSIVE_OUTCOMES'] = 'off';
    try {
      mockExtractMark.mockReturnValue(new Promise(() => undefined));
      featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
      const draft = await scanPublicImage(IMG, 'image/jpeg', 'scan.jpg', { markBudgetMs: 5000, budgetMs: 120 });
      expect(draft.verdict).toBe('not_found');
    } finally {
      delete process.env['INCONCLUSIVE_OUTCOMES'];
    }
  });

  test('an AI service call that hangs cannot hold the scan past its budget', async () => {
    mockExtract.mockReturnValue(new Promise(() => undefined)); // the AI service never answers
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    const t = Date.now();
    const draft = await scanPublicImage(IMG, 'image/jpeg', 'scan.jpg', { budgetMs: 3600 });
    expect(draft.verdict).toBe('inconclusive');
    expect(Date.now() - t).toBeLessThan(6000);
  }, 15_000);

  test('the default budget leaves room under the page\'s 45 second limit', async () => {
    const { SCAN_BUDGET_MS_FOR_TESTS } = await import('../../src/services/scan/public-scan.service');
    expect(SCAN_BUDGET_MS_FOR_TESTS).toBeLessThan(45_000 - 5_000);
  });
});

describe('the picture fingerprint failing does not stop feature matching', () => {
  test('a fingerprint search that throws still lets the feature search find the asset', async () => {
    mockPerceptualFindMany.mockRejectedValue(new Error('database busy'));
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('protected');
    expect(mockRetrieve).toHaveBeenCalled();
  });

  test('fingerprint candidates that are too far away do not stop the feature search either', async () => {
    mockPerceptualFindMany.mockResolvedValue([{
      dnaRecordId: 'other', pHash64: 'a', aHash64: 'a', dHash64: 'a',
      dnaRecord: { createdAt: new Date(Date.UTC(2026, 9, 1)), imageFilename: 'other.jpg', ownerUser: { shortId: 'ZZ99ZZ99' } },
    }]);
    mockVerify.mockReturnValue(0.6);
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('protected');
    expect(draft.dnaRecordId).toBe('asset-1');
    expect(mockRetrieve).toHaveBeenCalled();
  });
});

describe('the server confirms the matched asset before an owner is shown', () => {
  test('only active, owned registrations are considered for "Protected"', async () => {
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    await scanPublicImage(IMG, 'image/jpeg');
    const where = mockDnaFindMany.mock.calls[0][0].where;
    expect(where.ownerUserId).toEqual({ not: null });
    expect(where.status).toEqual({ in: ['COMPLETE', 'PARTIAL', 'PROCESSING'] });
  });

  test('a registration that is not active (pending or failed) is never shown, as a match or as an owner', async () => {
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    mockDnaFindMany.mockResolvedValue([]); // the status filter excludes it
    mockDnaFindFirst.mockResolvedValue(null);
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('not_found');
    expect(draft.ownerPinitId).toBeUndefined();
  });

  test('an owner with no PINIT identity to show is not named: the result drops to "Possible"', async () => {
    featureWorld(
      () => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }),
      ['asset-1'],
      [{ ...record('asset-1', 1), ownerUser: { shortId: null } } as never],
    );
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('possible');
    expect(draft.ownerPinitId).toBeUndefined();
  });

  test('the public card for a feature-confirmed result carries the owner ID and nothing internal', async () => {
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    const { toPublicScanBody } = await import('../../src/services/scan/public-scan-decision');
    const body = toPublicScanBody(await scanPublicImage(IMG, 'image/jpeg'));
    expect(body.verdict).toBe('protected');
    expect(body.ownerPinitId).toMatch(/AB12CD34/);
    const text = JSON.stringify(body);
    for (const forbidden of ['asset-1', 'dnaRecordId', 'vaultId', 'ownerUserId', 'email', 'inliers']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('missing or failing dependencies, and too little evidence', () => {
  test('no feature index for any asset: not found, no error', async () => {
    mockRetrieve.mockResolvedValue({ candidates: [], assetsAvailable: 0, assetsChecked: 0, cutShort: false });
    mockFeatureFindMany.mockResolvedValue([]);
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('not_found');
  });

  test('the AI service going down while candidates are compared: not found, no error', async () => {
    featureWorld(() => null);
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('not_found');
  });

  test('similarity near 1.0 and over 150 raw matches is NOT enough without an alignment', async () => {
    featureWorld(() => ({ similarity: 1, matches: 1500, inliers: 10, ratioMatches: 400 }));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('not_found');
    featureWorld(() => ({ similarity: 1, matches: 1500, inliers: 140, ratioMatches: 200 }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('possible');
    expect(draft.ownerPinitId).toBeUndefined();
  });

  test('a template look-alike (many aligned points, but only part of the picture) names no owner', async () => {
    featureWorld(() => ({ similarity: 1, matches: 600, inliers: 300, ratioMatches: 340, probeCoverage: 0.41, referenceCoverage: 0.41 }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('possible');
    expect(draft.ownerPinitId).toBeUndefined();
  });

  test('an AI service that reports alignment but not coverage can never produce "Protected"', async () => {
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460 }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('possible');
    expect(draft.ownerPinitId).toBeUndefined();
  });

  test('no matching points at all: not found', async () => {
    featureWorld(() => ({ similarity: 0, matches: 0, inliers: 0, ratioMatches: 0 }));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('not_found');
  });
});

describe('several candidates', () => {
  test('one strong and one weak candidate: the strong one is shown, and no other registration is claimed', async () => {
    featureWorld(
      (id) => (id === 'strong' ? { similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV } : { similarity: 0.9, matches: 120, inliers: 60, ratioMatches: 120 }),
      ['weak', 'strong'],
      [record('weak', 1, 'ZZ99ZZ99'), record('strong', 5, 'AB12CD34')],
    );
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('protected');
    expect(draft.dnaRecordId).toBe('strong');
    expect(draft.anotherRegistration).toBe(false);
  });

  test('two owners both strongly match: only the earliest registration is named, and the card says another exists', async () => {
    featureWorld(
      () => ({ similarity: 1, matches: 700, inliers: 400, ratioMatches: 450, ...COV }),
      ['later-owner', 'first-owner'],
      [record('later-owner', 20, 'ZZ99ZZ99'), record('first-owner', 2, 'AB12CD34')],
    );
    const { toPublicScanBody } = await import('../../src/services/scan/public-scan-decision');
    const body = toPublicScanBody(await scanPublicImage(IMG, 'image/jpeg'));
    expect(body.verdict).toBe('protected');
    expect(body.ownerPinitId).toMatch(/AB12CD34/);
    expect(JSON.stringify(body)).not.toMatch(/ZZ99ZZ99/);
    expect(body.anotherRegistration).toBe(true);
  });

  test('two near-threshold candidates (149 and 140 aligned points) are ambiguous: neither is "Protected"', async () => {
    featureWorld(
      (id) => ({ similarity: 1, matches: 400, inliers: id === 'a' ? 149 : 140, ratioMatches: 200 }),
      ['a', 'b'],
      [record('a', 1, 'AB12CD34'), record('b', 2, 'ZZ99ZZ99')],
    );
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('possible');
    expect(draft.ownerPinitId).toBeUndefined();
  });
});

describe('when the picture fingerprint already finds something', () => {
  const fingerprintRow = {
    dnaRecordId: 'asset-1', pHash64: 'a', aHash64: 'a', dHash64: 'a',
    dnaRecord: { createdAt: new Date(Date.UTC(2026, 9, 1)), imageFilename: 'asset-1.jpg', ownerUser: { shortId: 'AB12CD34' } },
  };

  test('a confirmed fingerprint match returns at once, without the feature search', async () => {
    mockPerceptualFindMany.mockResolvedValue([fingerprintRow]);
    mockVerify.mockReturnValue(0.99);
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('protected');
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  test('a look-alike ("Possible") is upgraded to "Protected" when features show a strong alignment', async () => {
    mockPerceptualFindMany.mockResolvedValue([fingerprintRow]);
    mockVerify.mockReturnValue(0.93);
    mockFeatureFindUnique.mockResolvedValue({ orbDescriptors: { ...D, id: 'asset-1' }, status: 'COMPLETE' });
    featureWorld(() => ({ similarity: 1, matches: 600, inliers: 380, ratioMatches: 420, ...COV }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('protected');
  });

  test('a look-alike stays "Possible" when the features do not confirm it', async () => {
    mockPerceptualFindMany.mockResolvedValue([fingerprintRow]);
    mockVerify.mockReturnValue(0.93);
    mockFeatureFindUnique.mockResolvedValue({ orbDescriptors: { ...D, id: 'asset-1' }, status: 'COMPLETE' });
    featureWorld(() => ({ similarity: 0.4, matches: 60, inliers: 10, ratioMatches: 30 }));
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('possible');
  });
});

describe('a hidden-mark search that a worker could not finish is never "not found"', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const workers = require('../../src/services/forensics/forensic-workers') as typeof import('../../src/services/forensics/forensic-workers');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WorkerWorkFailedError } = require('../../src/lib/worker-failure') as typeof import('../../src/lib/worker-failure');
  afterEach(() => jest.restoreAllMocks());

  test('a worker crash with nothing else found: the scan says "could not finish", and the file is not read again on the server thread', async () => {
    const spy = jest.spyOn(workers, 'readMark').mockRejectedValue(new WorkerWorkFailedError('crash', 'worker exited'));
    featureWorld(() => ({ similarity: 0.533, matches: 80, inliers: 20, ratioMatches: 45 })); // the other checks find nothing
    const draft = await scanPublicImage(IMG, 'image/jpeg');
    expect(draft.verdict).toBe('inconclusive');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mockExtractMark).not.toHaveBeenCalled();
  });

  test('a file refused after earlier failures is also "could not finish"', async () => {
    jest.spyOn(workers, 'readMark').mockRejectedValue(new WorkerWorkFailedError('crash', 'refused', true));
    featureWorld(() => ({ similarity: 0.533, matches: 80, inliers: 20, ratioMatches: 45 }));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('inconclusive');
  });

  test('the other checks can still find the asset when the mark search could not finish', async () => {
    jest.spyOn(workers, 'readMark').mockRejectedValue(new WorkerWorkFailedError('oom', 'out of memory'));
    featureWorld(() => ({ similarity: 1, matches: 700, inliers: 420, ratioMatches: 460, ...COV }));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('protected');
  });

  test('an ordinary mark-search error (not a worker failure) still leaves the old "not found" behaviour', async () => {
    jest.spyOn(workers, 'readMark').mockRejectedValue(new Error('decode failed'));
    featureWorld(() => ({ similarity: 0.533, matches: 80, inliers: 20, ratioMatches: 45 }));
    expect((await scanPublicImage(IMG, 'image/jpeg')).verdict).toBe('not_found');
  });
});
