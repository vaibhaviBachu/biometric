/**
 * The decision after the live selfie (owner decision, 2026-11-20): "Verified Identity" when every detail was read, the card
 * looks genuine and a live selfie passed liveness (the selfie is stored). The comparison with the ID photo is recorded but
 * never decides. Everything else is "Try Again". There is no "add a second ID" outcome.
 */
import { decideIdentity, idFaceMatchThreshold } from '../../src/services/identity-verification/identity-decision';
import type { VerificationResult } from '../../src/services/identity-verification/types';

const field = (value: string, status: 'READ' | 'VALIDATED' | 'NEEDS_REVIEW' | 'INVALID' = 'READ') => ({ value, confidence: 0.9, source: 'OCR' as const, status });

const ALL_DETAILS = {
  fullName: field('Test Person'),
  documentNumber: field('234567890124', 'VALIDATED'),
  dateOfBirth: field('2000-01-01', 'VALIDATED'),
  gender: field('FEMALE'),
  address: field('12 Main Road, Hyderabad, Telangana 500001'),
};

interface Opts {
  fields?: Record<string, unknown>;
  validated?: 'PASS' | 'FAIL';
  authenticity?: 'PASS' | 'FAIL' | 'UNKNOWN';
  pad?: 'LIVE' | 'SPOOF' | 'NOT_RUN';
  documentPhoto?: 'USABLE_FACE' | 'POOR_FACE' | 'NO_FACE' | 'NOT_PROVIDED';
  distance?: number;
}

function run(o: Opts = {}): VerificationResult {
  return {
    status: 'INSUFFICIENT_EVIDENCE',
    documents: [{ detectedType: 'AADHAAR', origin: 'SUBMITTED', fields: o.fields ?? ALL_DETAILS }],
    stages: [
      { stage: 'DOCUMENT_VALIDATED', status: o.validated ?? 'PASS', summary: '', evidence: [], findings: [] },
      { stage: 'DOCUMENT_AUTHENTICITY_SIGNALS', status: o.authenticity ?? 'PASS', summary: '', evidence: [], findings: [] },
    ],
    pad: { status: o.pad ?? 'LIVE', reasons: [] },
    face: {
      documentPhoto: o.documentPhoto ?? 'USABLE_FACE',
      documentPhotoVsLive: 'UNKNOWN',
      ...(o.distance === undefined && (o.documentPhoto === 'NO_FACE' || o.documentPhoto === 'NOT_PROVIDED') ? {} : { documentPhotoVsLiveDistance: o.distance ?? 0.42 }),
      liveVsEnrolled: 'NOT_RUN',
      embeddingSource: 'DEVICE_FACE_API_V1',
    },
  } as unknown as VerificationResult;
}

describe('identity decision after the live selfie', () => {
  test('every detail, genuine card, live person and matching face: Verified Identity', () => {
    const out = decideIdentity(run(), 'AADHAAR');
    expect(out.verified).toBe(true);
  });

  test('an older-looking ID photo still verifies: only clearly different faces are refused', () => {
    // 0.42 is past the sign-in threshold (0.38) but well within the same-person range for an ID photo.
    expect(decideIdentity(run({ distance: 0.55 }), 'AADHAAR').verified).toBe(true);
    expect(decideIdentity(run({ documentPhoto: 'POOR_FACE', distance: 0.5 }), 'AADHAAR').verified).toBe(true);
  });

  test('the face comparison is recorded but never decides: a distant match still verifies, with its distance kept', () => {
    const out = decideIdentity(run({ distance: idFaceMatchThreshold() + 0.15 }), 'AADHAAR');
    expect(out.verified).toBe(true);
    expect(out.faceDistance).toBeCloseTo(idFaceMatchThreshold() + 0.15);
  });

  test('a missing detail: Try Again, before anything else', () => {
    const { address: _address, ...noAddress } = ALL_DETAILS;
    const out = decideIdentity(run({ fields: noAddress, distance: 0.9 }), 'AADHAAR');
    expect(out).toMatchObject({ verified: false, reason: 'DETAILS_INCOMPLETE' });
  });

  test('no saved card type: Try Again', () => {
    expect(decideIdentity(run(), null)).toMatchObject({ verified: false, reason: 'DETAILS_INCOMPLETE' });
  });

  test('a number that does not validate, or failed authenticity signals (fake / edited / screen copy): Try Again', () => {
    expect(decideIdentity(run({ validated: 'FAIL' }), 'AADHAAR')).toMatchObject({ verified: false, reason: 'DOCUMENT_NOT_GENUINE' });
    expect(decideIdentity(run({ authenticity: 'FAIL' }), 'AADHAAR')).toMatchObject({ verified: false, reason: 'DOCUMENT_NOT_GENUINE' });
    // "could not tell" is not the same as fake
    expect(decideIdentity(run({ authenticity: 'UNKNOWN' }), 'AADHAAR').verified).toBe(true);
  });

  test('not a live person: Try Again', () => {
    expect(decideIdentity(run({ pad: 'SPOOF' }), 'AADHAAR')).toMatchObject({ verified: false, reason: 'LIVENESS_FAILED' });
    expect(decideIdentity(run({ pad: 'NOT_RUN' }), 'AADHAAR')).toMatchObject({ verified: false, reason: 'LIVENESS_FAILED' });
  });

  test('no face found on the card photo still verifies (the selfie is what is kept)', () => {
    expect(decideIdentity(run({ documentPhoto: 'NO_FACE' }), 'AADHAAR')).toMatchObject({ verified: true });
    expect(decideIdentity(run({ documentPhoto: 'NOT_PROVIDED' }), 'AADHAAR')).toMatchObject({ verified: true });
  });

  test('every Try Again carries a plain message, and none offers a second ID', () => {
    const cases = [
      decideIdentity(run({ pad: 'SPOOF' }), 'AADHAAR'),
      decideIdentity(run({ authenticity: 'FAIL' }), 'AADHAAR'),
      decideIdentity(run(), null),
    ];
    for (const out of cases) {
      expect(out.verified).toBe(false);
      if (!out.verified) {
        expect(out.message).toMatch(/Try again/i);
        expect(out.message).not.toMatch(/second/i);
      }
    }
  });


});
