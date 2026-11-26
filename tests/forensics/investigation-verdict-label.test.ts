import { describe, test, expect } from '@jest/globals';
import { investigationVerdictLabel } from '../../src/services/forensics/investigation-verdict-label';

describe('investigationVerdictLabel', () => {
  test('names every verdict in words', () => {
    expect(investigationVerdictLabel({ acceptanceVerdict: 'VERIFIED_ORIGINAL' })).toBe('Ownership Verified');
    expect(investigationVerdictLabel({ acceptanceVerdict: 'VERIFIED_DERIVATIVE' })).toBe('Ownership Verified (Derivative)');
    expect(investigationVerdictLabel({ acceptanceVerdict: 'POSSIBLE_MATCH' })).toBe('Possible match');
    expect(investigationVerdictLabel({ acceptanceVerdict: 'NOT_PINIT' })).toBe('No match found');
    expect(investigationVerdictLabel({ acceptanceVerdict: 'INSUFFICIENT_EVIDENCE' })).toBe('Not enough evidence');
  });
  test('falls back to the report state, and to "No match found" when nothing says otherwise', () => {
    expect(investigationVerdictLabel({ reportState: 'VERIFIED' })).toBe('Ownership Verified');
    expect(investigationVerdictLabel({ reportState: 'POSSIBLE' })).toBe('Possible match');
    expect(investigationVerdictLabel({})).toBe('No match found');
    expect(investigationVerdictLabel(undefined)).toBe('No match found');
  });
});
