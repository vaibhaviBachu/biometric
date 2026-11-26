/**
 * The extra recall search looks only at pictures the Trace's first patch search did NOT score (excludeVaultIds), so no picture
 * is scored twice. The filter is applied where the indexes are loaded.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

type AnyAsync = (...args: unknown[]) => Promise<unknown>;

jest.mock('../../src/lib/prisma', () => ({ prisma: { localFeatureIndex: { findMany: jest.fn() } } }));
jest.mock('../../src/lib/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/services/vault/vault.service', () => ({ VaultService: class {} }));
jest.mock('../../src/services/ai/ai-embeddings.service', () => ({ aiService: {} }));

import { prisma } from '../../src/lib/prisma';
import { vaultLocalDnaSearchService } from '../../src/services/forensics/vault-local-dna-search.service';
import { localDnaPatchGenerator } from '../../src/services/forensics/local-dna-patch-generator.service';

const findMany = prisma.localFeatureIndex.findMany as unknown as jest.Mock<AnyAsync>;
let n = 0;

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  jest.spyOn(localDnaPatchGenerator, 'generateMultiScaleGrid').mockResolvedValue({ patches: [{ patchIndex: 0 }], scales: [32] } as never);
});

const whereOfFirstLoad = () => (findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
// A different probe each time, so no cached result is shared between tests.
const probe = () => Buffer.from(`probe-${++n}`);

describe('local patch search: excludeVaultIds', () => {
  test('without a shortlist: every picture except the excluded ones', async () => {
    await vaultLocalDnaSearchService.search(probe(), 'owner', 'image/jpeg', { excludeVaultIds: ['a', 'b'] });
    expect(whereOfFirstLoad()).toEqual({ ownerUserId: 'owner', status: 'COMPLETE', vaultId: { notIn: ['a', 'b'] } });
  });

  test('with a shortlist: the shortlist minus the excluded ones', async () => {
    await vaultLocalDnaSearchService.search(probe(), 'owner', 'image/jpeg', { candidateVaultIds: ['a', 'b', 'c'], excludeVaultIds: ['a'] });
    expect(whereOfFirstLoad()).toEqual({ ownerUserId: 'owner', status: 'COMPLETE', vaultId: { in: ['b', 'c'] } });
  });

  test('nothing excluded: unchanged (whole vault)', async () => {
    await vaultLocalDnaSearchService.search(probe(), 'owner', 'image/jpeg', {});
    expect(whereOfFirstLoad()).toEqual({ ownerUserId: 'owner', status: 'COMPLETE' });
  });
});
