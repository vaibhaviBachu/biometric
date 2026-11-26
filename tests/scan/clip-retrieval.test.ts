/**
 * CLIP retrieval chooses the most likely protected picture for a scan. Registrations of the SAME picture must not count
 * as competing candidates (they would zero the lead), but a genuinely different, similar-looking picture must.
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import { ClipRetriever, type ClipIndexDb } from '../../src/services/scan/clip-retrieval';

jest.mock('../../src/lib/prisma', () => ({ prisma: { $queryRaw: jest.fn() } }));
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

/** A vector with its weight on one axis plus a little on others, so pictures can be made more or less alike. */
const vec = (...w: number[]) => w;
const row = (id: string, vector: number[]) => ({ dnaRecordId: id, vaultId: `vault-${id}`, ownerUserId: `owner-${id}`, vector });

function dbOf(rows: ReturnType<typeof row>[]): ClipIndexDb & { calls: number } {
  const db = { calls: 0, async list() { db.calls++; return rows; } };
  return db;
}

describe('retrieve', () => {
  test('finds the most similar asset and its lead over the best DIFFERENT picture', async () => {
    const retriever = new ClipRetriever(dbOf([
      row('a', vec(1, 0, 0)),
      row('b', vec(0, 1, 0)),
      row('c', vec(0.6, 0.8, 0)),
    ]));
    const r = await retriever.retrieve(vec(1, 0.05, 0));
    expect(r.top?.dnaRecordId).toBe('a');
    expect(r.top!.similarity).toBeGreaterThan(0.99);
    expect(r.margin).toBeGreaterThan(0.3); // 'c' is the best different picture (0.6)
    expect(r.assetsAvailable).toBe(3);
  });

  test('another registration of the SAME picture is not a competitor (and is returned with it)', async () => {
    const retriever = new ClipRetriever(dbOf([
      row('first', vec(1, 0, 0)),
      row('again', vec(0.999, 0.02, 0)), // the same picture registered a second time
      row('other', vec(0, 1, 0)),
    ]));
    const r = await retriever.retrieve(vec(1, 0.01, 0));
    expect(r.samePicture.map((c) => c.dnaRecordId).sort()).toEqual(['again', 'first']);
    expect(r.margin).toBeGreaterThan(0.9); // measured against 'other', not against the duplicate
  });

  test('a similar-looking but different picture DOES shrink the lead', async () => {
    const retriever = new ClipRetriever(dbOf([
      row('a', vec(1, 0, 0)),
      row('lookalike', vec(0.8, 0.6, 0)), // cosine 0.8 with 'a': below the duplicate threshold
    ]));
    const r = await retriever.retrieve(vec(1, 0, 0));
    expect(r.samePicture.map((c) => c.dnaRecordId)).toEqual(['a']);
    expect(r.margin).toBeLessThan(0.25);
  });

  test('with only one picture registered the lead is its whole similarity', async () => {
    const r = await new ClipRetriever(dbOf([row('only', vec(1, 0, 0))])).retrieve(vec(1, 0, 0));
    expect(r.margin).toBeCloseTo(1, 3);
  });

  test('the scan vector does not need to be unit length', async () => {
    const r = await new ClipRetriever(dbOf([row('a', vec(3, 0, 0))])).retrieve(vec(50, 0, 0));
    expect(r.top!.similarity).toBeCloseTo(1, 5);
  });

  test('nothing indexed, or an empty scan vector: no candidate', async () => {
    expect((await new ClipRetriever(dbOf([])).retrieve(vec(1, 0, 0))).top).toBeNull();
    expect((await new ClipRetriever(dbOf([row('a', vec(1, 0, 0))])).retrieve([])).top).toBeNull();
  });

  test('a vector of a different size never matches (no false similarity)', async () => {
    const r = await new ClipRetriever(dbOf([row('a', vec(1, 0))])).retrieve(vec(1, 0, 0));
    expect(r.top!.similarity).toBe(0);
  });

  test('the candidate carries what the server needs to confirm it, and nothing more', async () => {
    const r = await new ClipRetriever(dbOf([row('a', vec(1, 0, 0))])).retrieve(vec(1, 0, 0));
    expect(Object.keys(r.top!).sort()).toEqual(['dnaRecordId', 'ownerUserId', 'similarity', 'vaultId']);
  });
});

describe('the cached index', () => {
  let clock = 1_000;
  beforeEach(() => { clock = 1_000; });

  test('is read once, then reused until the time-to-live passes', async () => {
    const db = dbOf([row('a', vec(1, 0, 0))]);
    const retriever = new ClipRetriever(db, 60_000, () => clock);
    await retriever.retrieve(vec(1, 0, 0));
    await retriever.retrieve(vec(1, 0, 0));
    expect(db.calls).toBe(1);
    clock += 61_000;
    await retriever.retrieve(vec(1, 0, 0));
    expect(db.calls).toBe(2);
  });

  test('a failed refresh keeps serving the last good copy and does not throw', async () => {
    let fail = false;
    const db: ClipIndexDb = { async list() { if (fail) throw new Error('database busy'); return [row('a', vec(1, 0, 0))]; } };
    const retriever = new ClipRetriever(db, 60_000, () => clock);
    expect((await retriever.retrieve(vec(1, 0, 0))).top?.dnaRecordId).toBe('a');
    clock += 61_000;
    fail = true;
    expect((await retriever.retrieve(vec(1, 0, 0))).top?.dnaRecordId).toBe('a');
  });

  test('a first load that fails gives no candidate rather than an error', async () => {
    const db: ClipIndexDb = { async list() { throw new Error('database busy'); } };
    expect((await new ClipRetriever(db).retrieve(vec(1, 0, 0))).top).toBeNull();
  });

  test('simultaneous scans share one load', async () => {
    const db = dbOf([row('a', vec(1, 0, 0))]);
    const retriever = new ClipRetriever(db, 60_000, () => clock);
    await Promise.all([retriever.retrieve(vec(1, 0, 0)), retriever.retrieve(vec(1, 0, 0)), retriever.retrieve(vec(1, 0, 0))]);
    expect(db.calls).toBe(1);
  });
});
