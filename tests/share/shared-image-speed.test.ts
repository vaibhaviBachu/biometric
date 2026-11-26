/**
 * Opening a shared image must not redo the slow marking on every view, and a read that fails only because the database
 * connection dropped is tried once more.
 */
import '../watermark/helpers/pixel-mark-mechanics'; // first: switches the delivered-copy mark on for this test (off by default since 2026-11-20)
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const mockEmbed = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockLineage = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/services/dna-vnext/robust-watermark', () => ({ embedRobustProvenanceWatermark: (...a: unknown[]) => mockEmbed(...a) }));
jest.mock('../../src/services/layers/lineage-log', () => ({ appendExportLineage: (...a: unknown[]) => mockLineage(...a) }));

import { deliverSharedImage, resetSharedImageCache } from '../../src/services/share/shared-image-cache';
import { isTransientDbError, withReadRetry } from '../../src/lib/db-retry';

const link = (over: Record<string, unknown> = {}) => ({
  vaultId: 'v1', dnaRecordId: 'd1', ownerUserId: 'u1', shareRecipientId: null, recipientEmail: null, recipientLabel: 'Client A', ...over,
});
const original = Buffer.from('original-image-bytes');
const marked = Buffer.from('marked-image-bytes');

beforeEach(() => {
  resetSharedImageCache();
  mockEmbed.mockReset();
  mockLineage.mockReset();
  mockEmbed.mockResolvedValue({ embedded: true, buffer: marked });
});

describe('deliverSharedImage', () => {
  test('marks once, then serves the same recipient from memory', async () => {
    const first = await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    const second = await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    expect(first).toEqual({ buffer: marked, cacheHit: false });
    expect(second).toEqual({ buffer: marked, cacheHit: true });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockLineage).toHaveBeenCalledTimes(1);
  });

  test('a different recipient gets their own mark', async () => {
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link({ recipientLabel: 'Client B' }), original, mime: 'image/jpeg' });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  test('simultaneous views share one marking', async () => {
    let release!: () => void;
    mockEmbed.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ embedded: true, buffer: marked }); }));
    const a = deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    const b = deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.buffer).toBe(marked);
    expect(rb.buffer).toBe(marked);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  test('a copy that could not be marked is served but never kept', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original });
    const first = await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    expect(first.buffer).toBe(original);
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  test('a picture the clarity check rules out is not searched again on every view', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original, method: 'clarity-gate: no invisible strength' });
    const first = await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    const second = await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    const third = await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    expect(first).toEqual({ buffer: original, cacheHit: false });
    expect(second).toEqual({ buffer: original, cacheHit: true });
    expect(third.cacheHit).toBe(true);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  test('the ruling is per recipient and per picture, so another recipient is still tried', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original, method: 'clarity-gate: no invisible strength' });
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link({ recipientLabel: 'Client B' }), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link(), original: Buffer.from('a-different-picture'), mime: 'image/jpeg' });
    expect(mockEmbed).toHaveBeenCalledTimes(3);
  });

  test('a ruling that holds for every recipient covers forwarded hops and new recipients of the same picture', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original, method: 'clarity-gate: no invisible strength', forEveryRecipient: true });
    const first = await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    const hop = await deliverSharedImage({ link: link({ id: undefined, recipientLabel: 'Forwarded by Client A' }), original, mime: 'image/jpeg' });
    const byEmail = await deliverSharedImage({ link: link({ recipientLabel: null, recipientEmail: 'b@example.test' }), original, mime: 'image/jpeg' });
    const byRecipient = await deliverSharedImage({ link: link({ shareRecipientId: 'rec-9' }), original, mime: 'image/jpeg' });
    expect(first.cacheHit).toBe(false);
    expect([hop.cacheHit, byEmail.cacheHit, byRecipient.cacheHit]).toEqual([true, true, true]);
    expect(hop.buffer).toBe(original);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  test('a picture-wide ruling is still per picture: another file, record, type or replaced picture is searched', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original, method: 'clarity-gate: no invisible strength', forEveryRecipient: true });
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link({ vaultId: 'v2', recipientLabel: 'Z' }), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link({ dnaRecordId: 'd2', recipientLabel: 'Z' }), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link({ recipientLabel: 'Z' }), original, mime: 'image/png' });
    await deliverSharedImage({ link: link({ recipientLabel: 'Z' }), original: Buffer.from('X'.repeat(original.length)), mime: 'image/jpeg' });
    expect(mockEmbed).toHaveBeenCalledTimes(5);
  });

  test('a ruling that may depend on the recipient (a mark too faint to read, or near a limit) is kept for that recipient only', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original, method: 'clarity-gate: only a mark too faint to read was invisible', forEveryRecipient: false });
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link({ recipientLabel: 'Forwarded by Client A' }), original, mime: 'image/jpeg' });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  test('a recipient label with a "|" in it cannot mix up keys', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original, method: 'clarity-gate: no invisible strength', forEveryRecipient: true });
    await deliverSharedImage({ link: link({ recipientLabel: 'a|b|image/jpeg|zzz' }), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link({ recipientLabel: 'Client B' }), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link({ recipientLabel: 'Client C', dnaRecordId: 'd9' }), original, mime: 'image/jpeg' });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  test('simultaneous views by different recipients of one picture: one search, and its picture-wide ruling serves the rest', async () => {
    let release!: () => void;
    mockEmbed.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ embedded: false, buffer: original, method: 'clarity-gate: no invisible strength', forEveryRecipient: true });
    }));
    const views = ['A', 'B', 'C', 'D'].map((r) => deliverSharedImage({ link: link({ recipientLabel: `Hop ${r}` }), original, mime: 'image/jpeg' }));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const done = await Promise.all(views);
    expect(done.every((d) => d.buffer === original)).toBe(true);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  test('simultaneous views by different recipients of a picture that CAN be marked: each still gets their own mark', async () => {
    mockEmbed.mockImplementation(async (p: unknown) => ({ embedded: true, buffer: Buffer.from(`marked-for-${(p as { recipientKey: string }).recipientKey}`) }));
    const [a, b] = await Promise.all([
      deliverSharedImage({ link: link({ recipientLabel: 'A' }), original, mime: 'image/jpeg' }),
      deliverSharedImage({ link: link({ recipientLabel: 'B' }), original, mime: 'image/jpeg' }),
    ]);
    expect(a.buffer.toString()).toBe('marked-for-A');
    expect(b.buffer.toString()).toBe('marked-for-B');
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  test('a ruling is never reused for another vault file, another record, or a replaced picture', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original, method: 'clarity-gate: no invisible strength' });
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link({ vaultId: 'v2' }), original, mime: 'image/jpeg' });           // another file (another owner's)
    await deliverSharedImage({ link: link({ dnaRecordId: 'd2' }), original, mime: 'image/jpeg' });       // another record
    await deliverSharedImage({ link: link(), original: Buffer.from('X'.repeat(original.length)), mime: 'image/jpeg' }); // same size, new content
    await deliverSharedImage({ link: link(), original, mime: 'image/png' });                              // another type
    expect(mockEmbed).toHaveBeenCalledTimes(5);
  });

  test('a replaced picture with the same size and the same first 64 KB is told apart by its end', async () => {
    const head = Buffer.alloc(70 * 1024, 7);
    const a = Buffer.concat([head, Buffer.alloc(100 * 1024, 1)]);
    const b = Buffer.concat([head, Buffer.alloc(100 * 1024, 2)]); // same length, same start, different end
    mockEmbed.mockResolvedValue({ embedded: false, buffer: a, method: 'clarity-gate: no invisible strength' });
    await deliverSharedImage({ link: link(), original: a, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link(), original: b, mime: 'image/jpeg' });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  test('a remembered ruling only skips the search: the bytes served are always the ones just read for this viewer', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original, method: 'clarity-gate: no invisible strength' });
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    const sameContentNewBuffer = Buffer.from(original);
    const second = await deliverSharedImage({ link: link(), original: sameContentNewBuffer, mime: 'image/jpeg' });
    expect(second.cacheHit).toBe(true);
    expect(second.buffer).toBe(sameContentNewBuffer);
  });

  test('a ruling expires, so a changed marking setting or algorithm is picked up', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original, method: 'clarity-gate: no invisible strength' });
    const realNow = Date.now();
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(realNow);
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    now.mockReturnValue(realNow + 29 * 60 * 1000);
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    now.mockReturnValue(realNow + 31 * 60 * 1000);
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  test('a copy not marked for another reason (setting off, not an image) is tried again next time', async () => {
    mockEmbed.mockResolvedValue({ embedded: false, buffer: original, method: 'disabled' });
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  test('a failure in marking falls back to the original and tries again next time', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('out of memory')).mockResolvedValue({ embedded: true, buffer: marked });
    const first = await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    const second = await deliverSharedImage({ link: link(), original, mime: 'image/jpeg' });
    expect(first.buffer).toBe(original);
    expect(second.buffer).toBe(marked);
  });

  test('the cache is bounded: the least recently used entry is dropped', async () => {
    jest.resetModules();
    process.env['SHARE_IMAGE_CACHE_MB'] = '1';
    const big = Buffer.alloc(600 * 1024, 1);
    mockEmbed.mockImplementation(async () => ({ embedded: true, buffer: Buffer.from(big) }));
    const fresh = await import('../../src/services/share/shared-image-cache');
    await fresh.deliverSharedImage({ link: link({ recipientLabel: 'A' }), original, mime: 'image/jpeg' });
    await fresh.deliverSharedImage({ link: link({ recipientLabel: 'B' }), original, mime: 'image/jpeg' });
    const a = await fresh.deliverSharedImage({ link: link({ recipientLabel: 'A' }), original, mime: 'image/jpeg' });
    expect(a.cacheHit).toBe(false);
    delete process.env['SHARE_IMAGE_CACHE_MB'];
  });
});

describe('database read retry', () => {
  const noSleep = async () => undefined;

  test('recognises a dropped connection and nothing else', () => {
    expect(isTransientDbError({ code: 'P1001' })).toBe(true);
    expect(isTransientDbError(new Error("Can't reach database server at host:6543"))).toBe(true);
    expect(isTransientDbError(new Error('An existing connection was forcibly closed by the remote host'))).toBe(true);
    expect(isTransientDbError({ code: 'P2002' })).toBe(false);
    expect(isTransientDbError(new Error('Unique constraint failed'))).toBe(false);
  });

  test('a read is tried once more and then succeeds', async () => {
    const run = jest.fn<() => Promise<string>>().mockRejectedValueOnce({ code: 'P1001' }).mockResolvedValue('row');
    await expect(withReadRetry({ action: 'findFirst' }, run, noSleep)).resolves.toBe('row');
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('a second failure is raised, not hidden', async () => {
    const run = jest.fn<() => Promise<string>>().mockRejectedValue({ code: 'P1001' });
    await expect(withReadRetry({ action: 'findMany' }, run, noSleep)).rejects.toEqual({ code: 'P1001' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('a write is never sent twice', async () => {
    const run = jest.fn<() => Promise<string>>().mockRejectedValue({ code: 'P1001' });
    await expect(withReadRetry({ action: 'update' }, run, noSleep)).rejects.toBeDefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('nothing is retried inside a transaction, or for an error that is not a dropped connection', async () => {
    const inTx = jest.fn<() => Promise<string>>().mockRejectedValue({ code: 'P1001' });
    await expect(withReadRetry({ action: 'findFirst', runInTransaction: true }, inTx, noSleep)).rejects.toBeDefined();
    expect(inTx).toHaveBeenCalledTimes(1);
    const other = jest.fn<() => Promise<string>>().mockRejectedValue({ code: 'P2002' });
    await expect(withReadRetry({ action: 'findFirst' }, other, noSleep)).rejects.toBeDefined();
    expect(other).toHaveBeenCalledTimes(1);
  });
});
