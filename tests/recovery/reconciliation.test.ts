import { describe, test, expect } from '@jest/globals';
import { reconcileVaultStorage } from '../../src/lib/recovery/reconciliation';

describe('reconcileVaultStorage', () => {
  test('a matched reference is neither missing nor orphaned', () => {
    const result = reconcileVaultStorage(
      [{ vaultRecordId: 'v1', storagePath: 'owner-1/v1.enc' }],
      ['owner-1/v1.enc'],
    );
    expect(result.matchedCount).toBe(1);
    expect(result.missingObjects).toHaveLength(0);
    expect(result.orphanedObjectKeys).toHaveLength(0);
  });

  test('a DB reference with no matching storage object is reported missing', () => {
    const result = reconcileVaultStorage(
      [{ vaultRecordId: 'v1', storagePath: 'owner-1/v1.enc' }],
      [],
    );
    expect(result.missingObjects).toEqual([{ vaultRecordId: 'v1', storagePath: 'owner-1/v1.enc' }]);
    expect(result.matchedCount).toBe(0);
  });

  test('a storage object with no referencing DB record is reported orphaned', () => {
    const result = reconcileVaultStorage([], ['owner-1/orphan.enc']);
    expect(result.orphanedObjectKeys).toEqual(['owner-1/orphan.enc']);
  });

  test('two DB records referencing the same storage path are reported as a duplicate reference, not two matches', () => {
    const result = reconcileVaultStorage(
      [
        { vaultRecordId: 'v1', storagePath: 'owner-1/shared.enc' },
        { vaultRecordId: 'v2', storagePath: 'owner-1/shared.enc' },
      ],
      ['owner-1/shared.enc'],
    );
    expect(result.duplicateReferences).toEqual([{ storagePath: 'owner-1/shared.enc', vaultRecordIds: ['v1', 'v2'] }]);
    expect(result.matchedCount).toBe(1); // one distinct path matched, counted once
  });

  test('a mixed, realistic batch classifies every case independently', () => {
    const result = reconcileVaultStorage(
      [
        { vaultRecordId: 'v1', storagePath: 'owner-1/v1.enc' }, // matched
        { vaultRecordId: 'v2', storagePath: 'owner-1/v2.enc' }, // missing
      ],
      ['owner-1/v1.enc', 'owner-1/orphan.enc'],
    );
    expect(result.matchedCount).toBe(1);
    expect(result.missingObjects.map((m) => m.vaultRecordId)).toEqual(['v2']);
    expect(result.orphanedObjectKeys).toEqual(['owner-1/orphan.enc']);
    expect(result.totalDbReferences).toBe(2);
    expect(result.totalStorageObjects).toBe(2);
  });

  test('empty inputs produce an empty, non-throwing result', () => {
    const result = reconcileVaultStorage([], []);
    expect(result).toMatchObject({ missingObjects: [], orphanedObjectKeys: [], duplicateReferences: [], matchedCount: 0 });
  });
});
