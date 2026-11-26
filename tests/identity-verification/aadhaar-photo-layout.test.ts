import { aadhaarAdapter } from '../../src/services/identity-verification/adapters/aadhaar';
import type { OcrToken } from '../../src/services/identity-verification/types';

const tok = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 95): OcrToken =>
  ({ text, x0, y0, x1, y1, confidence }) as OcrToken;

describe('Aadhaar read from a phone photo', () => {
  // Layout taken from a real card photo (values replaced): slightly tilted, with
  // stray marks from the photo edge on their own lines between the name and the date.
  const tokens: OcrToken[] = [
    tok('Government', 520, 280, 700, 310), tok('of', 710, 280, 740, 310), tok('India', 750, 280, 840, 310),
    tok('3', 283, 405, 300, 448, 90), tok('4', 438, 408, 470, 472, 53),
    tok('Test', 627, 414, 747, 439, 80), tok('Person', 761, 417, 897, 443, 91),
    tok('i', 201, 437, 206, 448, 71),
    tok('9', 230, 455, 238, 467, 40),
    tok('i', 199, 462, 206, 468, 78),
    tok('d4/DOB:', 708, 453, 832, 481, 13), tok('01/01/2000', 857, 458, 1024, 484),
    tok('FEMALE', 686, 495, 796, 520, 96),
    tok('Aadhaar', 640, 690, 760, 715), tok('is', 770, 690, 790, 715), tok('proof', 800, 690, 880, 715),
    // The last group sits a little higher than the first in a tilted photo.
    tok('AY', 198, 892, 232, 934, 82),
    tok('2345', 605, 890, 734, 933, 96), tok('6789', 754, 890, 882, 933, 96), tok('0124', 902, 889, 1026, 933, 96),
  ];
  const text = 'Government of India\n3 4 Test Person\nd4/DOB: 01/01/2000\nFEMALE\nAadhaar is proof\nAY 2345 6789 0124';
  const fields = aadhaarAdapter.extract(text, { now: new Date('2026-11-19T00:00:00Z'), documentIndex: 0, tokens });

  it('reads the number left to right even when the photo is tilted', () => {
    expect(fields.documentNumber?.value).toBe('234567890124');
    expect(fields.documentNumber?.status).toBe('VALIDATED');
  });

  it('finds the name above the date past stray marks from the photo edge', () => {
    expect(fields.fullName?.value).toBe('Test Person');
    expect(fields.fullName?.status).toBe('READ');
  });
});
