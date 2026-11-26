/**
 * Phase 5 — worker correlation-ID propagation.
 *
 * Previously the worker emitted no correlation ID at all: concurrently
 * in-flight jobs' log lines (and a job's own multi-step log lines — queue
 * receive, handler, deleteMessage/failure) were indistinguishable from each
 * other and from any other job, breaking the "trace one job end-to-end
 * through logs" requirement. This proves pollOnce() now runs each message
 * inside a request context whose requestId is scoped to that exact message
 * (type + id + attempt), and that two different jobs in the same poll
 * cycle get two different IDs.
 */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { getRequestId } from '../src/lib/request-context';

process.env['JOB_QUEUE_BACKEND'] = 'local';

const seenRequestIdsByDnaRecordId: Record<string, string | undefined> = {};

jest.mock('../src/services/vault/vault.service', () => ({
  VaultService: jest.fn().mockImplementation(() => ({
    retrieve: jest.fn(async () => ({ originalBuffer: Buffer.from('x') })),
  })),
}));
jest.mock('../src/services/layers/layers-11-15.service', () => ({
  processAdvancedLayers: jest.fn(async (dnaRecordId: string) => {
    // Captured from inside the handler, deep in the call stack — proves the
    // AsyncLocalStorage context survives through dispatch() -> handler ->
    // this mocked service call, not just at pollOnce()'s own top level.
    seenRequestIdsByDnaRecordId[dnaRecordId] = getRequestId();
    return { successful: 5, failed: 0, completedLayers: [11, 12, 13, 14, 15] };
  }),
}));
jest.mock('../src/lib/prisma', () => ({ prisma: { $disconnect: jest.fn() } }));

import { pollOnce } from '../src/worker';
import { getJobQueue } from '../src/lib/job-queue';

beforeEach(() => {
  for (const k of Object.keys(seenRequestIdsByDnaRecordId)) delete seenRequestIdsByDnaRecordId[k];
});

describe('worker — per-job correlation ID (requestId) propagation', () => {
  test('a dispatched job runs inside a request context whose requestId reaches deep into the handler', async () => {
    expect(getRequestId()).toBeUndefined(); // sanity: no ambient context outside any job

    const queue = getJobQueue();
    await queue.publish('advanced_layers', {
      dnaRecordId: 'dna-A', vaultId: 'vault-A', ownerUserId: 'owner-A', mimeType: 'image/jpeg', filename: 'a.jpg',
    });

    await pollOnce();

    const id = seenRequestIdsByDnaRecordId['dna-A'];
    expect(id).toBeDefined();
    expect(id).toMatch(/^job:advanced_layers:[\w-]+:attempt1:[\w-]+$/);
    expect(getRequestId()).toBeUndefined(); // context does not leak past the job that owned it
  });

  test('two jobs in the same poll cycle get two distinct requestIds', async () => {
    const queue = getJobQueue();
    await queue.publish('advanced_layers', {
      dnaRecordId: 'dna-B1', vaultId: 'v', ownerUserId: 'o', mimeType: 'image/jpeg', filename: 'b1.jpg',
    });
    await queue.publish('advanced_layers', {
      dnaRecordId: 'dna-B2', vaultId: 'v', ownerUserId: 'o', mimeType: 'image/jpeg', filename: 'b2.jpg',
    });

    await pollOnce();

    const idOne = seenRequestIdsByDnaRecordId['dna-B1'];
    const idTwo = seenRequestIdsByDnaRecordId['dna-B2'];
    expect(idOne).toBeDefined();
    expect(idTwo).toBeDefined();
    expect(idOne).not.toBe(idTwo);
  });
});
