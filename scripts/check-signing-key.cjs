#!/usr/bin/env node
/**
 * Checks a report-signing key offline, the way the server reads it (src/services/evidence/phase3-crypto.service.ts), and says
 * whether it can sign. It changes nothing, contacts nothing, and NEVER prints the key.
 *
 *   node scripts/check-signing-key.cjs --file path/to/key.pem
 *   PHASE3_ED25519_PRIVATE_KEY_PEM="$(cat key.pem)" node scripts/check-signing-key.cjs
 *
 * It prints one of:
 *   OK: a valid Ed25519 private key. Public key fingerprint: <16 hex>   (the same value the server puts in signed reports)
 *   NOT OK: <the kind of problem>
 *
 * The fingerprint identifies the key without revealing it. Compare it with the `publicKeyFingerprint` inside a signed report,
 * or with GET /api/v1/evidence/public-key on the live server, to see whether two keys are the same.
 */
const crypto = require('crypto');
const fs = require('fs');

function read() {
  const i = process.argv.indexOf('--file');
  if (i > 0) return fs.readFileSync(process.argv[i + 1], 'utf8');
  return process.env.PHASE3_ED25519_PRIVATE_KEY_PEM || '';
}

const raw = read().trim();
if (!raw) {
  console.log('NOT OK: no key given (use --file or set PHASE3_ED25519_PRIVATE_KEY_PEM).');
  process.exit(1);
}

// The same normalisation as the server: dashboards often store a pasted key on one line with a literal backslash-n for each break.
const pem = raw.includes('\\n') && !raw.includes('\n') ? raw.replace(/\\n/g, '\n') : raw;

const problems = [];
if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) problems.push('no "-----BEGIN PRIVATE KEY-----" line');
if (!/-----END [A-Z ]*PRIVATE KEY-----/.test(pem)) problems.push('no "-----END PRIVATE KEY-----" line');
if (/^["'].*["']$/s.test(pem)) problems.push('the value is wrapped in quotes');
if (pem.includes('BEGIN PUBLIC KEY')) problems.push('this is a PUBLIC key; a private key is needed');
if (/-----BEGIN [A-Z ]*PRIVATE KEY-----[^\n]/.test(pem)) problems.push('text follows the BEGIN line on the same line (line breaks were lost)');

try {
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    console.log(`NOT OK: this is a ${privateKey.asymmetricKeyType} key, not Ed25519.`);
    process.exit(1);
  }
  const publicPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
  // Prove it can sign and that the signature verifies.
  const probe = Buffer.from('pinit-signing-check');
  const signature = crypto.sign(null, probe, privateKey);
  const ok = crypto.verify(null, probe, crypto.createPublicKey(privateKey), signature);
  console.log(ok ? `OK: a valid Ed25519 private key. Public key fingerprint: ${fingerprint}` : 'NOT OK: the key parsed but a test signature did not verify.');
  process.exit(ok ? 0 : 1);
} catch (err) {
  const why = problems.length ? problems.join('; ') : 'the text is not a readable private key (it may be truncated, or the line breaks were damaged)';
  console.log(`NOT OK: ${why}.`);
  process.exit(1);
}
