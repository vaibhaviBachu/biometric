/**
 * PGAP-35 regression: extractPinitCode's fallback branch used to read
 * `CODE_RE.test(last) ? last : last` — both ternary arms returned the same
 * value, so an unrecognized or malformed id (wrong prefix, too short/long,
 * stray characters) returned that raw fragment as if it were a validated
 * code instead of '' (the "could not resolve an identity" contract every
 * caller elsewhere in the codebase already depends on).
 */
import { describe, test, expect } from '@jest/globals';
import {
  extractPinitCode,
  toRootPinitId,
  toUserPinitId,
  toOrgPinitId,
  toExchangePinitId,
} from '../../src/lib/pinit-identity';

describe('extractPinitCode — valid identity formats', () => {
  test('PINIT-USER-{code}', () => {
    expect(extractPinitCode('PINIT-USER-ABC12345')).toBe('ABC12345');
  });
  test('PINIT-ORG-{code}', () => {
    expect(extractPinitCode('PINIT-ORG-ABC12345')).toBe('ABC12345');
  });
  test('PINIT-EX-{code}', () => {
    expect(extractPinitCode('PINIT-EX-ABC12345')).toBe('ABC12345');
  });
  test('PINIT-WS-{code}', () => {
    expect(extractPinitCode('PINIT-WS-ABC123')).toBe('ABC123');
  });
  test('root PINIT-{code}', () => {
    expect(extractPinitCode('PINIT-ABC12345')).toBe('ABC12345');
  });
  test('lower-case input is normalized', () => {
    expect(extractPinitCode('pinit-user-abc12345')).toBe('ABC12345');
  });
  test('leading/trailing whitespace is trimmed', () => {
    expect(extractPinitCode('  PINIT-USER-ABC12345  ')).toBe('ABC12345');
  });
  test('minimum-length (6-char) code is accepted', () => {
    expect(extractPinitCode('PINIT-ABCDEF')).toBe('ABCDEF');
  });
  test('maximum-length (12-char) code is accepted', () => {
    expect(extractPinitCode('PINIT-ABCDEFGHIJKL')).toBe('ABCDEFGHIJKL');
  });
});

describe('extractPinitCode — invalid identity formats (must return empty, not a garbage fragment)', () => {
  test('null returns empty', () => {
    expect(extractPinitCode(null)).toBe('');
  });
  test('undefined returns empty', () => {
    expect(extractPinitCode(undefined)).toBe('');
  });
  test('empty string returns empty', () => {
    expect(extractPinitCode('')).toBe('');
  });
  test('whitespace-only string returns empty', () => {
    expect(extractPinitCode('   ')).toBe('');
  });
  test('a code shorter than 6 chars is rejected, not returned raw — PGAP-35 core regression case', () => {
    expect(extractPinitCode('PINIT-XY')).toBe('');
  });
  test('a code longer than 12 chars is rejected, not returned raw', () => {
    expect(extractPinitCode('PINIT-THISCODEISFARTOOLONG')).toBe('');
  });
  test('an unrecognized prefix with no dashes is rejected, not returned raw — PGAP-35 core regression case', () => {
    expect(extractPinitCode('RANDOMGARBAGEINPUT')).toBe('');
  });
  test('an unrecognized multi-segment string is rejected, not returned raw', () => {
    expect(extractPinitCode('not-a-real-xy')).toBe('');
  });
  test('a too-short trailing segment behind an unknown prefix is rejected', () => {
    expect(extractPinitCode('FAKE-PREFIX-XY')).toBe('');
  });
  test('a secondary-prefixed id with a too-short code falls through the prefixed branch and is still rejected by the fallback', () => {
    expect(extractPinitCode('PINIT-USER-XY')).toBe('');
  });
  test('lowercase-with-symbols trailing segment is rejected (contains characters outside A-Z0-9)', () => {
    expect(extractPinitCode('PINIT-abc_123')).toBe('');
  });
});

describe('extractPinitCode — identity collision checks', () => {
  test('two different valid codes never normalize to the same value', () => {
    expect(extractPinitCode('PINIT-USER-ABC12345')).not.toBe(extractPinitCode('PINIT-USER-XYZ98765'));
  });
  test('an invalid/garbage identity never collides with a real valid identity', () => {
    const real = extractPinitCode('PINIT-USER-ABC12345');
    const garbage = extractPinitCode('totally-different-xy');
    expect(garbage).toBe('');
    expect(garbage).not.toBe(real);
  });
  test('prefix variants of the SAME code correctly reconcile to one identity', () => {
    const code = 'ABC12345';
    expect(extractPinitCode(`PINIT-${code}`)).toBe(code);
    expect(extractPinitCode(`PINIT-USER-${code}`)).toBe(code);
    expect(extractPinitCode(`PINIT-ORG-${code}`)).toBe(code);
    expect(extractPinitCode(`PINIT-EX-${code}`)).toBe(code);
  });
});

describe('toRootPinitId / toUserPinitId / toOrgPinitId / toExchangePinitId — downstream of the fix', () => {
  test('a malformed input now correctly yields an empty id instead of a bogus PINIT-<garbage> string', () => {
    expect(toRootPinitId('not-a-real-xy')).toBe('');
    expect(toUserPinitId('not-a-real-xy')).toBe('');
    expect(toOrgPinitId('not-a-real-xy')).toBe('');
    expect(toExchangePinitId('not-a-real-xy')).toBe('');
  });
  test('a valid code still round-trips correctly through every wrapper', () => {
    expect(toRootPinitId('PINIT-ABC12345')).toBe('PINIT-ABC12345');
    expect(toUserPinitId('PINIT-ABC12345')).toBe('PINIT-USER-ABC12345');
    expect(toOrgPinitId('PINIT-ABC12345')).toBe('PINIT-ORG-ABC12345');
    expect(toExchangePinitId('PINIT-ABC12345')).toBe('PINIT-EX-ABC12345');
  });
});
