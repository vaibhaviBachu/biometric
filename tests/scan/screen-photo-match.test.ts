/**
 * matchScreenPhoto with injected dependencies: every way the AI service, the index, the stored original or the clock can
 * fail must end in "no answer" or a weaker answer, never in "protected" without evidence.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { matchScreenPhoto, type ScreenPhotoDeps } from '../../src/services/scan/screen-photo-match';
import type { ClipRetrieval } from '../../src/services/scan/clip-retrieval';

jest.mock('../../src/lib/prisma', () => ({ prisma: {} }));
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const IMG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const REF = Buffer.from('reference-jpeg');

const found = (similarity: number, margin: number, ids = ['asset-1']): ClipRetrieval => ({
  top: { dnaRecordId: ids[0]!, vaultId: 'vault-1', ownerUserId: 'owner-1', similarity },
  samePicture: ids.map((id) => ({ dnaRecordId: id, vaultId: `vault-${id}`, ownerUserId: 'owner-1', similarity })),
  margin,
  assetsAvailable: 5,
});

function deps(over: Partial<ScreenPhotoDeps> = {}): ScreenPhotoDeps & { calls: Record<string, number> } {
  const calls: Record<string, number> = { embed: 0, retrieve: 0, loadReference: 0, verify: 0 };
  const base: ScreenPhotoDeps = {
    embed: async () => { calls.embed!++; return [0.1, 0.2, 0.3]; },
    retrieve: async () => { calls.retrieve!++; return found(0.82, 0.2); },
    loadReference: async () => { calls.loadReference!++; return REF; },
    verify: async () => { calls.verify!++; return { inliers: 300, probeCoverage: 0.6, referenceCoverage: 0.7 }; },
  };
  return Object.assign({ ...base, ...over }, { calls });
}

const run = (d: ScreenPhotoDeps, remaining = 30_000) => matchScreenPhoto(IMG, 'image/jpeg', remaining, d);

describe('a confirmed match', () => {
  test('a clear CLIP lead confirmed by SIFT against the stored original is protected', async () => {
    const d = deps();
    const r = await run(d);
    expect(r).toMatchObject({ verdict: 'protected', dnaRecordIds: ['asset-1'], inliers: 300, coverage: 0.7 });
    expect(d.calls.loadReference).toBe(1);
    expect(d.calls.verify).toBe(1);
  });

  test('every registration of the same picture is returned, for the caller to pick the earliest', async () => {
    const r = await run(deps({ retrieve: async () => found(0.85, 0.3, ['first', 'again']) }));
    expect(r?.dnaRecordIds).toEqual(['first', 'again']);
  });

  test('coverage is the larger of the scan side and the original side', async () => {
    const r = await run(deps({ verify: async () => ({ inliers: 200, probeCoverage: 0.1, referenceCoverage: 0.8 }) }));
    expect(r).toMatchObject({ verdict: 'protected', coverage: 0.8 });
  });
});

describe('not enough evidence', () => {
  test('some aligned points that are still too few to be protected: possible', async () => {
    const r = await run(deps({ verify: async () => ({ inliers: 80, probeCoverage: 0.5, referenceCoverage: 0.5 }) }));
    expect(r?.verdict).toBe('possible');
  });

  test('very few aligned points (a look-alike picture): nothing is claimed', async () => {
    const r = await run(deps({ verify: async () => ({ inliers: 20, probeCoverage: 0.5, referenceCoverage: 0.5 }) }));
    expect(r).toBeNull();
  });

  test('aligned points that cover too little of the picture: not protected', async () => {
    const r = await run(deps({ verify: async () => ({ inliers: 200, probeCoverage: 0.05, referenceCoverage: 0.08 }) }));
    expect(r?.verdict).not.toBe('protected');
  });

  test('a look-alike is nearly as close (small lead): no confirmation is attempted and nothing is protected', async () => {
    const d = deps({ retrieve: async () => found(0.74, 0.02) });
    expect(await run(d)).toBeNull();
    expect(d.calls.loadReference).toBe(0);
  });

  test('too far from everything registered: nothing is claimed and nothing is read from the Vault', async () => {
    const d = deps({ retrieve: async () => found(0.55, 0.3) });
    expect(await run(d)).toBeNull();
    expect(d.calls.loadReference).toBe(0);
  });

  test('a very strong CLIP lead alone, when it cannot be confirmed, claims nothing (CLIP only says "looks alike")', async () => {
    const r = await run(deps({ retrieve: async () => found(0.9, 0.4), loadReference: async () => null }));
    expect(r).toBeNull();
  });
});

describe('failures end in "no answer" or a weaker answer', () => {
  test('the AI service cannot embed the scan', async () => {
    const d = deps({ embed: async () => null });
    expect(await run(d)).toBeNull();
    expect(d.calls.retrieve).toBe(0);
  });

  test('the AI service throws', async () => {
    expect(await run(deps({ embed: async () => { throw new Error('connect ECONNREFUSED'); } }))).toBeNull();
  });

  test('no CLIP index yet (nothing backfilled): no answer', async () => {
    expect(await run(deps({ retrieve: async () => ({ top: null, samePicture: [], margin: 0, assetsAvailable: 0 }) }))).toBeNull();
  });

  test('the stored original cannot be read (for example vaulted under another key): never protected', async () => {
    const r = await run(deps({ retrieve: async () => found(0.8, 0.2), loadReference: async () => null }));
    expect(r?.verdict).not.toBe('protected');
  });

  test('the stored original read throws', async () => {
    const r = await run(deps({ loadReference: async () => { throw new Error('Vault decrypt failed'); } }));
    expect(r === null || r.verdict !== 'protected').toBe(true);
  });

  test('SIFT verification fails: never protected', async () => {
    const r = await run(deps({ verify: async () => null }));
    expect(r?.verdict).not.toBe('protected');
  });
});

describe('the clock', () => {
  test('too little time left: nothing is started', async () => {
    const d = deps();
    expect(await run(d, 1_000)).toBeNull();
    expect(d.calls.embed).toBe(0);
  });

  test('enough for the CLIP lead but not for confirmation: confirmation is skipped, never guessed', async () => {
    const d = deps({ retrieve: async () => found(0.8, 0.2) });
    const r = await run(d, 2_500);
    expect(r?.verdict).not.toBe('protected');
    expect(d.calls.loadReference).toBe(0);
  });

  test('an AI call that never answers is cut off by the time left', async () => {
    const t = Date.now();
    const r = await run(deps({ embed: () => new Promise(() => undefined) }), 1_800);
    expect(r).toBeNull();
    expect(Date.now() - t).toBeLessThan(3_500);
  });
});

beforeEach(() => jest.clearAllMocks());
