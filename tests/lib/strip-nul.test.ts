import { stripNul } from '../../src/lib/strip-nul';

describe('stripNul (Postgres rejects U+0000 in text/jsonb)', () => {
  it('removes NUL from strings, nested objects, arrays and keys', () => {
    const out = stripNul({
      ImageDescription: 'Travel is not a reward\u0000\u0000',
      UserComment: 'ASCII\u0000\u0000\u0000Travel',
      nested: { list: ['a\u0000', 2, null], 'XP\u0000Key': 'v' },
    });
    expect(out).toEqual({
      ImageDescription: 'Travel is not a reward',
      UserComment: 'ASCIITravel',
      nested: { list: ['a', 2, null], XPKey: 'v' },
    });
    expect(JSON.stringify(out)).not.toContain('\u0000');
  });

  it('leaves Buffers, Dates, numbers and clean strings untouched', () => {
    const buf = Buffer.from([0, 1, 2]);
    const date = new Date(0);
    const out = stripNul({ buf, date, n: 3, s: 'clean' });
    expect(out.buf).toBe(buf);
    expect(out.date).toBe(date);
    expect(out.n).toBe(3);
    expect(out.s).toBe('clean');
  });
});
