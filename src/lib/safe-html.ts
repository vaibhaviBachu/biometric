/**
 * Escaping and validation for untrusted values that are placed into HTML, XML/SVG, URLs and redirects.
 */

/** What a share token looks like (letters, digits, "-" and "_"); anything else is never put in HTML or a redirect. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/** Escapes a value for HTML text or a double- or single-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escapes a value for XML / SVG text (also removes characters that are not allowed in XML 1.0). */
export function escapeXml(value: string): string {
  return escapeHtml(value)
    // eslint-disable-next-line no-control-regex -- intentional: strips characters XML 1.0 forbids
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
}

/** A Host header value, only when it is a plain host name with an optional port; otherwise null. */
export function safeHostOrNull(host: string | undefined): string | null {
  const value = String(host ?? '');
  return /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(value) ? value : null;
}

/**
 * A filename for a `Content-Disposition` header value (ASH-L01). The filename usually comes
 * from the uploader (e.g. `req.file.originalname`), so it must never be placed in the header
 * unescaped: a `"` breaks out of the quoted value, and a bare `\r`/`\n` could inject an extra
 * header line on a server that does not itself reject control characters in header values.
 */
export function safeContentDispositionFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, '_');
}
