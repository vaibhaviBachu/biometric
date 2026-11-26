/**
 * A vault file that cannot be decrypted with this server's key fails identically every time, so it is skipped for a
 * while instead of being retrieved and waited on in every investigation. Only that failure is remembered.
 */
const mockRetrieve = jest.fn();

jest.mock('../../src/services/vault/vault.service', () => ({
  VaultService: class {
    retrieve = (...a: unknown[]) => mockRetrieve(...a);
  },
}));
jest.mock('../../src/lib/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// Only the failure handling in front of the comparison is under test; the comparison engines are not needed.
jest.mock('../../src/services/verification/dna-comparison.service', () => ({ DnaComparisonService: class {} }));
jest.mock('../../src/services/forensics/investigation-pipeline-audit.service', () => ({ logDeepCompareCandidate: jest.fn() }));
jest.mock('../../src/services/forensics/adaptive-scoring.service', () => ({ resolveMediaProfile: () => 'image' }));
jest.mock('../../src/services/forensics/video-forensic-compare.service', () => ({ compareVideoInvestigation: jest.fn() }));
jest.mock('../../src/services/forensics/investigation-stored-dna-source.service', () => ({ resolveInvestigationVaultDnaSource: jest.fn() }));

import { DeepVaultCompareService, clearUndecryptableVaults } from '../../src/services/forensics/deep-vault-compare.service';

const KEY_MISMATCH = new Error(
  'Vault decrypt failed for v1: Unsupported state or unable to authenticate data. Ensure VAULT_MASTER_SECRET on the server matches the key used when this file was vaulted.',
);
const candidate = (vaultId: string) => ({ vaultId, dnaRecordId: `dna-${vaultId}`, rank: 1 }) as never;
const run = (svc: DeepVaultCompareService, vaultId: string) =>
  svc.compareOneCandidate(Buffer.from([1]), 'image/png', 'probe.png', 1, candidate(vaultId), 'owner-1');

beforeEach(() => {
  jest.restoreAllMocks();
  mockRetrieve.mockReset();
  clearUndecryptableVaults();
});

describe('a vault file that cannot be decrypted with the server key', () => {
  test('is retrieved once, then skipped at once on the next investigations', async () => {
    mockRetrieve.mockRejectedValue(KEY_MISMATCH);
    const svc = new DeepVaultCompareService();
    expect(await run(svc, 'v1')).toBeNull();
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    expect(await run(svc, 'v1')).toBeNull();
    expect(await run(svc, 'v1')).toBeNull();
    expect(mockRetrieve).toHaveBeenCalledTimes(1); // not retried
  });

  test('does not affect any other vault file', async () => {
    mockRetrieve.mockRejectedValueOnce(KEY_MISMATCH).mockRejectedValueOnce(new Error('stop here'));
    const svc = new DeepVaultCompareService();
    await run(svc, 'v1');
    await run(svc, 'v2');
    expect(mockRetrieve).toHaveBeenCalledTimes(2);
    expect(mockRetrieve.mock.calls[1][0]).toBe('v2');
  });

  test('is tried again after the memory expires (the key may have been fixed)', async () => {
    mockRetrieve.mockRejectedValue(KEY_MISMATCH);
    const svc = new DeepVaultCompareService();
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    await run(svc, 'v1');
    now.mockReturnValue(start + 9 * 60_000);
    await run(svc, 'v1');
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
    now.mockReturnValue(start + 11 * 60_000);
    await run(svc, 'v1');
    expect(mockRetrieve).toHaveBeenCalledTimes(2);
  });
});

describe('other failures are transient and are retried as before', () => {
  test.each(['connect ECONNRESET', 'Storage download timed out', 'Request failed with status code 503'])('%s', async (message) => {
    mockRetrieve.mockRejectedValue(new Error(message));
    const svc = new DeepVaultCompareService();
    await run(svc, 'v1');
    await run(svc, 'v1');
    expect(mockRetrieve).toHaveBeenCalledTimes(2);
  });
});
