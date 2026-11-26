/**
 * Media-container guards for known `music-metadata` / `file-type` parser bugs.
 *
 * Both `music-metadata` (<= 11.12.1, high) and `file-type` (13.0.0 - 21.3.0, moderate)
 * have an infinite loop in their ASF parsers, so a crafted file could hang the process.
 * Upgrading either is a breaking major bump (ESM-only) and this project compiles to
 * CommonJS, so instead callers skip those parsers for buffers that start with the ASF
 * header GUID and fall back to their non-parsing paths.
 *
 * `music-metadata` <= 11.12.3 additionally has two "uncontrolled memory allocation"
 * bugs (CWE-789 — a declared tag size is used to allocate a buffer without checking it
 * against the bytes actually available): the APEv2 tag parser (GHSA-53v6-4h7p-p4gj) and
 * the ID3v2 tag parser (GHSA-jjpr-9cvf-cq55). Both are mitigated the same way as ASF:
 * detect the dangerous shape before calling the library at all, and skip parsing for
 * that file. (A separate, non-reachable-by-shape MP4 `stsd` zero-size infinite loop and
 * two EBML/DSF issues in the same advisory group are not covered by a byte-level guard
 * here — see audio-dna-engine.ts's bounded timeout wrapper for defense-in-depth against
 * those.)
 */
const ASF_HEADER_GUID = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex');

export function looksLikeAsf(buf: Buffer): boolean {
  return buf.length >= ASF_HEADER_GUID.length && buf.subarray(0, ASF_HEADER_GUID.length).equals(ASF_HEADER_GUID);
}

// APEv2 tag footer/header signature ("APETAGEX"). Can appear as a footer trailing an MP3/WAV
// file, or at the start of a standalone .ape container — scanning the whole buffer for the
// 8-byte literal covers both without needing to compute an exact offset.
const APE_TAG_SIGNATURE = Buffer.from('APETAGEX', 'ascii');

export function looksLikeApeTag(buf: Buffer): boolean {
  return buf.includes(APE_TAG_SIGNATURE);
}

// ID3v2 header: bytes 0-2 "ID3", bytes 6-9 a 4-byte synchsafe (7 bits/byte) tag size. The
// vulnerable parser allocates a buffer of this DECLARED size without checking it against the
// buffer actually available — a tiny file can claim an enormous tag. A real, legitimately
// produced ID3v2 tag's declared size always fits inside the file it's written to, so this
// never false-positives on genuine content; it only catches a size claim that cannot be true.
export function hasOversizedId3v2Tag(buf: Buffer): boolean {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return false; // "ID3"
  const b6 = buf[6]!, b7 = buf[7]!, b8 = buf[8]!, b9 = buf[9]!;
  // Each size byte's high bit must be 0 (synchsafe); a set high bit means a malformed/non-standard
  // header this guard cannot interpret — treat as suspicious rather than assume it is safe.
  if ((b6 & 0x80) || (b7 & 0x80) || (b8 & 0x80) || (b9 & 0x80)) return true;
  const declaredSize = ((b6 & 0x7f) << 21) | ((b7 & 0x7f) << 14) | ((b8 & 0x7f) << 7) | (b9 & 0x7f);
  return 10 + declaredSize > buf.length;
}
