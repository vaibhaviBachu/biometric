/**
 * Conditional requests for pictures that never change under the same id.
 *
 * A stored file does not change, so a preview of it can be named (an ETag) from its id and size alone, without reading it. When
 * the browser asks again and sends the name back, the answer is "304 not changed" and no file is downloaded, decrypted or
 * resized. (Express would also answer 304, but only after the whole response had been built.)
 */
export function etagMatches(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const header = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch;
  if (header.trim() === '*') return true;
  const strip = (v: string) => v.trim().replace(/^W\//, '');
  const wanted = strip(etag);
  return header.split(',').some((candidate) => strip(candidate) === wanted);
}

/** Name of a vault file's preview, from its id and stored size (a stored file never changes under the same id). */
export function vaultPreviewEtag(vaultId: string, storedBytes: number, thumbnail: boolean): string {
  return `W/"vp-${vaultId}-${storedBytes}-${thumbnail ? 't' : 'f'}"`;
}

/** Name of a public portfolio picture (the 960 px preview), from the vault id and stored size. */
export function portfolioMediaEtag(vaultId: string, storedBytes: string | number): string {
  return `W/"pm-${vaultId}-${storedBytes}-960"`;
}
