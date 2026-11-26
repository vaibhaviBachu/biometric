import { tidyAddress, wordsAfterOnLine } from '../../src/services/identity-verification/adapters/adapter';
import { voterIdAdapter } from '../../src/services/identity-verification/adapters/voter-id';
import { panAdapter } from '../../src/services/identity-verification/adapters/pan';

const ctx = { now: new Date('2026-11-19T00:00:00Z'), documentIndex: 0 };
const lines = (...l: string[]) => l.join('\n');

describe('each value is read only from the area next to its own label', () => {
  it('ignores the other-script line under a bilingual voter ID name', () => {
    // An English-only read turns the Telugu line under the name into stray letters.
    const text = lines(
      'ELECTION COMMISSION OF INDIA',
      'ABC1234567',
      'Name: Test Person',
      'Ny wv',
      "Father's Name: Parent Person",
      'Gender: Female',
      'Date of Birth / Age: 01-01-2000',
    );
    const f = voterIdAdapter.extract(text, ctx);
    expect(f.fullName?.value).toBe('Test Person');
    expect(f.fatherOrGuardianName?.value).toBe('Parent Person');
  });

  it("never takes the father's name as the holder's name", () => {
    // The holder's "Name:" line was unreadable; only the father's line has a name label.
    const text = lines('ELECTION COMMISSION OF INDIA', 'ABC1234567', 'Nme Tcst', "Father's Name: Parent Person", 'Gender: Female');
    const f = voterIdAdapter.extract(text, ctx);
    expect(f.fullName).toBeUndefined();
    expect(f.fatherOrGuardianName?.value).toBe('Parent Person');
  });

  it('reads a PAN name printed on the line under its label', () => {
    const text = lines('INCOME TAX DEPARTMENT GOVT. OF INDIA', 'Permanent Account Number Card', 'ABCPE1234F', 'Name', 'TEST PERSON', "Father's Name", 'PARENT PERSON');
    expect(panAdapter.extract(text, ctx).fullName?.value).toBe('TEST PERSON');
  });

  it('still works on text without line breaks, and still skips a relative', () => {
    expect(wordsAfterOnLine('Name: Test Person Gender: Female', /\bname\s*[:/]/i)).toBe('Test Person');
    expect(wordsAfterOnLine("Father's Name: Parent Person Gender: Female", /\bname\s*[:/]/i, 4, { skip: /father/i })).toBeNull();
  });

  it('reads the address only from its own block', () => {
    const text = lines(
      'Address: H No 12-3, Main Road,',
      'Ameerpet, Hyderabad,',
      'Telangana 500016',
      'Date: 01/02/2020',
      'Electoral Registration Officer',
    );
    expect(voterIdAdapter.extract(text, ctx).address?.value).toBe('H No 12-3, Main Road, Ameerpet, Hyderabad, Telangana 500016');
    const noPin = lines('Address: H No 12-3, Main Road', 'Ameerpet Hyderabad', 'Date: 01/02/2020', 'Assembly Constituency No 60');
    expect(voterIdAdapter.extract(noPin, ctx).address?.value).toBe('H No 12-3, Main Road, Ameerpet Hyderabad');
  });

  it('drops hologram and pattern scraps from an address', () => {
    const noisy = 'H NO 4-30, NARSAIPALLY, | -&f [u] hE [=] NARSAIPALLE, NARSAIPALLE, MADDUR, { LI) Fi i ok re SIDDIPET, TELANGANA- 506223';
    expect(tidyAddress(noisy)).toBe('H NO 4-30, NARSAIPALLY, NARSAIPALLE, NARSAIPALLE, MADDUR, SIDDIPET, TELANGANA- 506223');
    expect(tidyAddress('Flat 4B, Sai Residency, Near SBI, Kukatpally (Hyd), Telangana 500072')).toBe('Flat 4B, Sai Residency, Near SBI, Kukatpally (Hyd), Telangana 500072');
    expect(tidyAddress('D/O: Test Parent, 12-3 Main Road, Hyderabad, Telangana - 500016')).toBe('D/O: Test Parent, 12-3 Main Road, Hyderabad, Telangana 500016');
  });
});
