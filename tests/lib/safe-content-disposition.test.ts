/**
 * ASH-L01 — Content-Disposition filename injection. These four sinks passed a user-controlled
 * upload filename straight into the header value with no sanitization:
 *   vault.controller.ts (the inline-view, protected-download, and investigation-download sinks)
 *   share-link.controller.ts (the public share file-serve sink)
 * A filename containing `"` could break out of the quoted value; a bare `\r`/`\n` could inject
 * an extra header line on a server that does not itself reject control characters in header
 * values. Two other sinks in this codebase (vault.controller.ts's video-stream and audio-preview
 * handlers, business.controller.ts) already sanitized with this exact pattern — this test covers
 * the shared helper the four previously-unsanitized sinks now use.
 */
import { describe, test, expect } from '@jest/globals';
import { safeContentDispositionFilename } from '../../src/lib/safe-html';

describe('safeContentDispositionFilename', () => {
  test('a quote cannot break out of the quoted filename value', () => {
    const malicious = 'evidence.pdf"; X-Injected: true; filename="x.pdf';
    const safe = safeContentDispositionFilename(malicious);
    expect(safe).not.toContain('"');
    // The resulting header value, built the same way the controllers build it, must still be one
    // well-formed quoted string with no embedded quote anywhere.
    const header = `attachment; filename="${safe}"`;
    expect(header.match(/"/g)).toHaveLength(2);
  });

  test('CR/LF cannot inject an extra header line', () => {
    const malicious = 'evidence.pdf\r\nSet-Cookie: session=stolen';
    const safe = safeContentDispositionFilename(malicious);
    expect(safe).not.toMatch(/[\r\n]/);
  });

  test('a backslash cannot escape the sanitization itself (e.g. \\" sequences)', () => {
    const malicious = 'evidence\\".pdf';
    const safe = safeContentDispositionFilename(malicious);
    expect(safe).not.toContain('\\');
    expect(safe).not.toContain('"');
  });

  test('a normal filename is left exactly as-is (legitimate behavior preserved)', () => {
    expect(safeContentDispositionFilename('Q3 Financial Report (final).pdf')).toBe('Q3 Financial Report (final).pdf');
    expect(safeContentDispositionFilename('résumé_2026.docx')).toBe('résumé_2026.docx');
  });
});
