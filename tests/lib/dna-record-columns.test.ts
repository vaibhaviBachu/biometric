/**
 * DNA_RECORD_COLUMNS must be every DnaRecord column except the large `fileAnalysis` blob, so reads that use it lose nothing
 * else. A new column in the schema that is not added here fails this test (it would silently be missing from those reads).
 */
import { describe, test, expect } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { DNA_RECORD_COLUMNS } from '../../src/lib/dna-record-columns';

describe('DNA_RECORD_COLUMNS', () => {
  test('is exactly every DnaRecord column except fileAnalysis', () => {
    const all = Object.values(Prisma.DnaRecordScalarFieldEnum).sort();
    expect(Object.keys(DNA_RECORD_COLUMNS).sort()).toEqual(all.filter((c) => c !== 'fileAnalysis'));
  });
});
