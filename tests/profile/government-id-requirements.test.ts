import {
  hasDetail, missingDetails, missingMessage, sideToRedo,
} from '../../src/services/profile/government-id-requirements';
import { buildVerifiedIdentityData } from '../../src/services/identity-verification/verified-details';
import type { VerificationResult } from '../../src/services/identity-verification/types';

const field = (value: string, status: 'READ' | 'VALIDATED' | 'NEEDS_REVIEW' | 'INVALID' = 'READ') => ({ value, confidence: 0.9, source: 'OCR' as const, status });

function run(fields: Record<string, unknown>, findings: unknown[] = [], status: VerificationResult['status'] = 'REVIEW_REQUIRED'): VerificationResult {
  return {
    status,
    documents: [{ detectedType: 'AADHAAR', origin: 'SUBMITTED', fields }],
    stages: [{ stage: 'FORMAT', status: 'PASS', summary: '', evidence: [], findings }],
  } as unknown as VerificationResult;
}

const aadhaarFront = {
  fullName: field('Test Person'),
  documentNumber: field('234567890124', 'VALIDATED'),
  dateOfBirth: field('2000-01-01', 'VALIDATED'),
  gender: field('FEMALE'),
};

describe('government ID required details', () => {
  it('accepts an Aadhaar only when front details and the address were read', () => {
    expect(missingDetails('AADHAAR', run(aadhaarFront), 'front')).toEqual([]);
    expect(missingDetails('AADHAAR', run(aadhaarFront), 'all')).toEqual(['address']);
    const full = run({ ...aadhaarFront, address: field('12 Main Road, Hyderabad, Telangana 500001') });
    expect(missingDetails('AADHAAR', full, 'all')).toEqual([]);
  });

  it('asks for the back side when only a back-side detail is missing', () => {
    expect(sideToRedo('AADHAAR', ['address'])).toBe('back');
    expect(sideToRedo('AADHAAR', ['fullName', 'address'])).toBe('front');
    expect(missingMessage('AADHAAR', ['address'])).toMatch(/address.*back side/);
  });

  it('treats a name flagged for review as not read', () => {
    const r = run({ ...aadhaarFront, fullName: field('Tcst Pcrson', 'NEEDS_REVIEW') });
    expect(hasDetail(r, 'fullName')).toBe(false);
    expect(missingDetails('AADHAAR', r, 'front')).toEqual(['fullName']);
  });

  it('treats a number that fails its checksum as not read', () => {
    const r = run(aadhaarFront, [{ code: 'CHECKSUM_INVALID', severity: 'HIGH', message: 'x', documentIndex: 0, field: 'documentNumber' }]);
    expect(hasDetail(r, 'documentNumber')).toBe(false);
    expect(missingMessage('AADHAAR', missingDetails('AADHAAR', r, 'front'))).toMatch(/Aadhaar number/);
  });

  it('accepts a year of birth where only the year is printed', () => {
    const r = run({ ...aadhaarFront, dateOfBirth: undefined, yearOfBirth: field('1990') });
    expect(hasDetail(r, 'dateOfBirth')).toBe(true);
  });

  it('does not ask a PAN card for an address', () => {
    const pan = run({ fullName: field('TEST PERSON'), documentNumber: field('ABCPE1234F'), dateOfBirth: field('1990-05-01') });
    expect(missingDetails('PAN', pan, 'all')).toEqual([]);
  });

  it('keeps the read details when a proof is saved, before the selfie', () => {
    const r = run({ ...aadhaarFront, address: field('12 Main Road, Hyderabad, Telangana 500001') });
    expect(buildVerifiedIdentityData(r, 'run-1', new Date())).toBeNull();
    const data = buildVerifiedIdentityData(r, 'run-1', new Date(), { requirePassed: false })!;
    expect(data.fullName).toBe('Test Person');
    expect(data.documentNumber).toBe('234567890124');
    expect(data.address).toContain('Hyderabad');
  });
});
