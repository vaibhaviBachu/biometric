/**
 * Voter ID reading on real phone photos (production, 2026-11-20): the card was recognised as a Voter ID, but no detail was
 * read. The number only matched an exact "ABC1234567" (phone photos read O as 0, I as 1, S as 5), and the name only matched
 * "Name :" with the colon on the same line.
 */
import { voterIdAdapter, epicFromText } from '../../src/services/identity-verification/adapters/voter-id';
import { genderIn } from '../../src/services/identity-verification/adapters/adapter';

describe('Voter ID number (EPIC) from a phone photo', () => {
  test('exact number', () => expect(epicFromText('EPIC No. ABC1234567')).toBe('ABC1234567'));
  test('digits misread in the letters, letters misread in the digits', () => {
    expect(epicFromText('Identity Card 4BC12345O7')).toBe('ABC1234507');
    expect(epicFromText('XYZ 98765S3')).toBe('XYZ9876553');
    expect(epicFromText('UIS0123456')).toBe('UIS0123456');
    expect(epicFromText('U1S0I23456')).toBe('UIS0123456');
  });
  test('a space or dash after the letters', () => {
    expect(epicFromText('ABC 1234567')).toBe('ABC1234567');
    expect(epicFromText('ABC-1234567')).toBe('ABC1234567');
  });
  test('ordinary words and dates are never turned into a number', () => {
    expect(epicFromText('ELECTION COMMISSION OF INDIA IDENTITY CARD')).toBeNull();
    expect(epicFromText('Date of Birth 01/01/2000 Gender Female')).toBeNull();
    expect(epicFromText('Hyderabad Telangana 500032')).toBeNull();
  });
});

describe('Voter ID details from typical text', () => {
  const card = (text: string) => voterIdAdapter.extract(text, { now: new Date('2026-11-20') } as never);

  test('new card: name without a colon, father on the next line, misread number', () => {
    const f = card([
      'ELECTION COMMISSION OF INDIA',
      'IDENTITY CARD',
      'UIS0I23456',
      'Name SHAILAJA REDDY',
      "Father's Name RAMESH REDDY",
      'Gender Female',
      'Date of Birth 05/03/1998',
    ].join('\n'));
    expect(f.documentNumber?.value).toBe('UIS0123456');
    expect(f.fullName?.value).toMatch(/SHAILAJA REDDY/i);
    expect(f.fullName?.value).not.toMatch(/RAMESH/i);
    expect(f.gender?.value).toBe('FEMALE');
  });

  test("old card: Elector's Name with the name on the next line", () => {
    const f = card([
      'ELECTION COMMISSION OF INDIA',
      "ELECTOR'S PHOTO IDENTITY CARD",
      'ABC1234567',
      "Elector's Name :",
      'KAVYA SRI',
      "Husband's Name : RAVI KUMAR",
      'Sex : F',
    ].join('\n'));
    expect(f.documentNumber?.value).toBe('ABC1234567');
    expect(f.fullName?.value).toMatch(/KAVYA SRI/i);
    expect(f.fullName?.value).not.toMatch(/RAVI/i);
  });

  test('the constituency name is never taken as the holder name', () => {
    const f = card([
      'ELECTION COMMISSION OF INDIA',
      'Assembly Constituency No. & Name : 45 - Kukatpally',
      'Name : MEERA DEVI',
      'XYZ9876543',
    ].join('\n'));
    expect(f.fullName?.value).toMatch(/MEERA DEVI/i);
  });
});

describe("gender: a woman's card is never read as male", () => {
  test.each([
    ['Gender : Female', 'FEMALE'],
    ['Sex : FE MALE', 'FEMALE'],
    ['Gender / FERNALE', 'FEMALE'],
    ['लिंग / Gender : महिला / Female', 'FEMALE'],
    ['లింగం : స్త్రీ', 'FEMALE'],
    ['Sex : F', 'F'], // a bare letter stays as printed, as before
    ['Gender : Male', 'MALE'],
    ['लिंग : पुरुष / MALE', 'MALE'],
    ['Sex : M', 'M'],
  ])('%s -> %s', (text, want) => expect(genderIn(text)).toBe(want));
});
