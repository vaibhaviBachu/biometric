/**
 * Generates the full 13-section Digital Asset Forensic Investigation Report from a realistic investigation record
 * (a derivative whose bytes differ from the original) with a real image pair and a real difference map.
 * The record is test data and is labelled as such in the file name; nothing here ships.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { jsPDF } from 'jspdf';
import sharp from 'sharp';
import { buildEnterpriseInvestigationViewModel } from '../client/src/lib/enterprise-investigation-report-model';
import { buildForensicReport } from '../client/src/lib/forensic-report-data';
import { diffPixels, visuallyIdentical } from '../client/src/lib/image-difference';
import { drawEvidenceVerification, drawInvestigationEvidencePdf, type PdfImageAsset } from '../client/src/services/investigation-evidence-pdf';

const VAULT = 'eda0ac01-033e-4de7-98ba-026542651830';
const DNA = '35386213-0e48-4f2a-9240-ec44526d3ddb';
const SHA_A = '1c9e0a7d5b3f48a2c6e1904d7b2a5f83e6c0d1b9a4f7283e5c6d0b1a9f8e7d62';
const SHA_B = '6e051ebcad22ab9f0eebf824bf0a1d92853f4641a54937b9f72829a7813fd0a5';

const tamperNames = ['Compression', 'Crop', 'Resize', 'Rotation', 'Screenshot', 'Blur', 'Color Filters', 'Format Conversion', 'Sharpen', 'Spliced Fragment'];

const report = {
  investigationId: '50267c9f-3c3f-4839-a0f2-b92c34922586',
  investigatedAt: '2026-11-04T05:50:12.000Z',
  success: true,
  pipeline: [{ id: 'dna_compare', label: '15-layer DNA comparison', status: 'complete', detail: '100%' }],
  summary: {
    reportState: 'VERIFIED', acceptanceVerdict: 'VERIFIED_DERIVATIVE', acceptanceConfidence: 100, acceptancePolicyVersion: 'acceptance-policy-v1.2',
    decisionReason: 'Original identified with derivative/tamper signals — DNA 100%, visual 100%', dnaMatchPercent: 100, ownershipConfidence: 100,
    certificateStatus: 'ACTIVE', identityStatus: 'FOUND', tamperSeverity: 'LOW', riskLevel: 'MEDIUM', retrievalConfidence: 100,
  },
  owner: { originalFilename: 'Ramappa Temple.jpg', ownerName: 'Kavvam Ashwitha', ownerPinitId: 'PINIT-P8N5UUTZ', vaultId: VAULT, dnaRecordId: DNA, certificateId: 'CERT-DNA-1B71EDFF-82FE-482C-9AA2-F60DF7761392', createdAt: '2026-11-03T07:53:00.000Z' },
  identityRecoveryReport: { originalHash: SHA_A, currentHash: SHA_B, registrationTimestamp: '2026-11-03T07:53:00.000Z', originalDevice: 'Chrome on Windows (desktop)', recovered: true, message: 'ok' },
  layerAnalysis: [
    { layer: 1, name: 'Cryptographic', matchPercent: 0, status: 'failed', explanation: 'SHA-256 differs from vault original' },
    { layer: 2, name: 'Structural', matchPercent: 96, status: 'verified', explanation: 'edge layout' },
    { layer: 3, name: 'Perceptual', matchPercent: 100, status: 'verified', explanation: 'visual fingerprint' },
    { layer: 7, name: 'Local', matchPercent: 92, status: 'verified', explanation: 'local features' },
    ...[4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => ({ layer: n, name: `x${n}`, matchPercent: 0, status: 'not_measured', explanation: 'Not measured: the full comparison did not complete for this examination.' })),
  ],
  tamperAnalysis: {
    primaryVector: 'MINIMAL_DERIVATIVE', overallTamperScore: 15,
    description: 'Near-identical derivative of vault original (100% visual match, bytes differ).',
    vectors: tamperNames.map((label) => ({ label, detected: label === 'Format Conversion' })),
    changesVsOriginal: tamperNames.map((type) => ({ type, detected: type === 'Format Conversion', confidence: type === 'Format Conversion' ? 45 : 0, detail: type === 'Format Conversion' ? 'Visual match 100% with SHA-256 mismatch vs vault original' : 'No evidence', where: type === 'Format Conversion' ? 'File bytes / container vs vault SHA-256' : undefined })),
  },
  identityProof: { digitalSignatureValid: true, identityVerification: 'VERIFIED', vaultId: VAULT, dnaRecordId: DNA, watermark: { status: 'DETECTED', confidence: 95, reason: 'Forensic identity signature/manifest recovered — unique vault linkage' } },
  dnaComparison: { classification: 'SIMILAR', overallConfidenceScore: 100, fileA: { filename: 'Ramappa Temple.jpg', fileType: 'image', mimeType: 'image/jpeg', sizeBytes: 3_400_221 }, fileB: { filename: 'Ramappa Temple.jpg', fileType: 'image', mimeType: 'image/jpeg', sizeBytes: 3_398_870 }, layerComparisons: [] },
  currentFileHash: SHA_B,
  probeFile: { filename: 'Ramappa Temple.jpg', mimeType: 'image/jpeg', sizeBytes: 3_398_870, sha256: SHA_B },
  provenanceSummary: { creationLocation: 'Hyderabad, Telangana, India', shareCount: 2, downloadCount: 3, countriesSeen: ['India'], tamperCount: 0, investigationCount: 4 },
  evidenceTimeline: Array.from({ length: 90 }, (_, i) => ({
    id: `evt${String(i).padStart(5, '0')}-aaaa`,
    eventType: i === 0 ? 'DNA_GENERATED' : i % 9 === 0 ? 'FILE_DOWNLOADED' : i % 4 === 0 ? 'VAULT_RETRIEVED' : 'INTEGRITY_CHECK_RUN',
    summary: 'event', timestamp: new Date(Date.UTC(2026, 10, 3, 7, 53) + i * 14 * 60_000).toISOString(),
    locationLabel: i % 9 === 0 ? 'Hyderabad, India' : undefined, device: 'Chrome / Windows', actorLabel: i % 9 === 0 ? 'PINIT-P8N5UUTZ' : undefined, source: 'provenance',
  })),
  accessIntelligence: [{ timestamp: '2026-11-03T09:10:00.000Z', action: 'DOWNLOAD', ipAddress: '203.0.113.24', country: 'India', city: 'Hyderabad', region: 'Telangana' }],
  leakIntelligence: { hasPublicLeak: false, entries: [{ platform: 'Simulated', url: 'x', status: 'x', source: 'simulated' }], message: 'No public leak detected.' },
  candidateRanking: [{ rank: 1, vaultId: VAULT, dnaRecordId: DNA, compositeScore: 100, method: 'vector', signals: [], selected: true }],
  timeline: [], recipientAttribution: {},
};

async function makeImages() {
  const W = 640; const H = 420;
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    px[i] = 70 + (x * 120) / W; px[i + 1] = 110 + (y * 90) / H; px[i + 2] = 150 - ((x + y) * 60) / (W + H);
    if ((x - 320) ** 2 + (y - 210) ** 2 < 90 ** 2) { px[i] = 200; px[i + 1] = 170; px[i + 2] = 90; }
  }
  const modified = Buffer.from(px);
  for (let y = 40; y < 120; y++) for (let x = 440; x < 600; x++) { const i = (y * W + x) * 3; modified[i] = 20; modified[i + 1] = 20; modified[i + 2] = 30; }
  const toAsset = async (raw: Buffer): Promise<PdfImageAsset> => {
    const jpg = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
    return { dataUrl: `data:image/jpeg;base64,${jpg.toString('base64')}`, format: 'JPEG', width: W, height: H, naturalWidth: 4032, naturalHeight: 2640 };
  };
  const rgba = (raw: Buffer) => { const o = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { o[i * 4] = raw[i * 3]; o[i * 4 + 1] = raw[i * 3 + 1]; o[i * 4 + 2] = raw[i * 3 + 2]; o[i * 4 + 3] = 255; } return o; };
  const stats = diffPixels(rgba(px), rgba(modified), W, H);
  const mapJpg = await sharp(Buffer.from(stats.heatmap), { raw: { width: W, height: H, channels: 4 } }).jpeg({ quality: 85 }).toBuffer();
  const { heatmap: _h, ...rest } = stats; void _h;
  return {
    original: await toAsset(px), probe: await toAsset(modified),
    map: { dataUrl: `data:image/jpeg;base64,${mapJpg.toString('base64')}`, format: 'JPEG' as const, width: W, height: H },
    difference: { status: 'computed' as const, ...rest, visuallyIdentical: visuallyIdentical(stats) },
  };
}

function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const out: string[] = [];
  const re = /\((?:\\.|[^\\)]){2,}\)(?=\s*(?:Tj|TJ))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out.push(m[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
  return out.join('\n');
}

describe('full 13-section forensic report', () => {
  test('renders every section with real data, a real difference map and honest gaps', async () => {
    const img = await makeImages();
    const vm = buildEnterpriseInvestigationViewModel(report as never);
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const slot = drawInvestigationEvidencePdf(doc, {
      vm, report: report as never, assetName: 'Ramappa Temple',
      comparisonImages: { original: img.original, probe: img.probe }, difference: img.difference, differenceMap: img.map,
    });
    drawEvidenceVerification(doc, slot, null);
    mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
    const buf = Buffer.from(doc.output('arraybuffer'));
    writeFileSync(join(process.cwd(), 'tmp', 'Full report (test data) - Evidence Report.pdf'), buf);

    const t = pdfText(buf);
    for (const heading of ['EXECUTIVE INVESTIGATION SUMMARY', 'ORIGINAL ASSET INFORMATION', 'VISUAL COMPARISON', 'MODIFICATION AND TAMPERING ANALYSIS',
      'PINIT DNA FORENSIC VERIFICATION', 'ASSET DISTRIBUTION AND DISCOVERY TIMELINE', 'GEOGRAPHICAL INVESTIGATION', 'CHAIN OF CUSTODY AND EVIDENCE INTEGRITY',
      'DISCOVERY SOURCE AND PLATFORM INVESTIGATION', 'EVIDENCE GALLERY', 'INVESTIGATION FINDINGS AND RISK ASSESSMENT',
      'INVESTIGATION CONCLUSION AND RECOMMENDED ACTIONS', 'CONFIDENTIALITY, LEGAL DISCLAIMER AND REPORT CLASSIFICATION']) {
      expect(t).toContain(heading);
    }
    // honest gaps, real values, no leaked internals
    expect(t).toContain('Not Recorded');
    expect(t).toContain(SHA_A);
    expect(t).toContain(SHA_B);
    expect(t).toContain('Hyderabad, Telangana, India');
    expect(t).toContain('Digital Signature: Not Available');
    expect(t).not.toMatch(/sentinel/i);
    expect(t).not.toMatch(/15-layer/i);
    expect(t).not.toContain('Simulated');
    expect(doc.getNumberOfPages()).toBeGreaterThan(8);
  });

  test('the report data never invents a discovery source, collector or location', () => {
    const vm = buildEnterpriseInvestigationViewModel(report as never);
    const d = buildForensicReport(report as never, vm, { assetName: 'Ramappa Temple' });
    const flat = JSON.stringify(d.s9.records) + JSON.stringify(d.s3.discovery);
    expect(d.s9.records).toHaveLength(1); // the simulated leak entry is excluded
    expect(flat).not.toMatch(/https?:\/\//);
    expect(d.s8.gaps.join(' ')).toMatch(/Collector or investigator identity is not recorded/);
    expect(d.s1.rows.find((r) => r[0] === 'Case reference ID')?.[1]).toMatch(/^Not Recorded/);
    expect(d.s11.items.find((f) => f.title === 'Potential unauthorized distribution')?.state).toBe('Requires Further Investigation');
    expect(d.s6.total).toBe(90);
    expect(d.s6.omitted).toBeGreaterThan(0);
  });

  const withDiscovery = {
    ...report,
    discoveryInfo: {
      provenance: 'USER_PROVIDED', verified: false, providedAt: '2026-11-04T05:49:00.000Z',
      foundWhere: 'Photo gallery of a travel blog', platform: 'Instagram', sourceUrl: 'https://example.com/p/ramappa',
      firstObservedAt: '2026-11-01', notes: 'Sent to me by a colleague',
    },
  };

  test('discovery details are printed as user-provided and never as verified', async () => {
    const vm = buildEnterpriseInvestigationViewModel(withDiscovery as never);
    const d = buildForensicReport(withDiscovery as never, vm, { assetName: 'Ramappa Temple' });
    const rowsOf = (rows: Array<[string, string, boolean?]>) => Object.fromEntries(rows.map((r) => [r[0], r[1]]));
    const s3 = rowsOf(d.s3.discovery);
    expect(s3['Source platform or website']).toBe('Instagram  (user-provided, not verified)');
    expect(s3['Discovery URL']).toContain('https://example.com/p/ramappa');
    expect(s3['Discovery URL']).toContain('user-provided, not verified');
    expect(s3['First observed']).toContain('2026-11-01');
    // system-recorded entry time stays distinct from what the user said
    expect(s3['Discovery details entered']).toContain('(system-recorded)');
    const rec = rowsOf(d.s9.records[0].rows);
    expect(rec['Exact source URL']).toContain('user-provided, not verified');
    expect(rec['Investigator’s notes']).toContain('Sent to me by a colleague');
    // still not claimed as proof of distribution
    const dist = d.s11.items.find((f) => f.title === 'Potential unauthorized distribution')!;
    expect(dist.state).toBe('Requires Further Investigation');
    expect(dist.reason).toMatch(/not verified/);
    // reported first-observed date sits in the timeline, flagged
    const reported = d.s6.rows.find((r) => r.eventType === 'Copy first observed (reported)')!;
    expect(reported.verification).toBe('User-provided, not verified');
    const order = d.s6.rows.map((r) => r.eventType);
    expect(order.indexOf('Copy first observed (reported)')).toBeLessThan(order.indexOf('Investigation performed'));
    // the unverified source is a recorded gap, not custody
    expect(d.s8.gaps.join(' ')).toMatch(/have not been verified/);
    expect(d.s12.actions.join(' ')).toMatch(/Capture and preserve the reported source page/);
  });

  test('the PDF carries the discovery details with the not-verified label', async () => {
    const img = await makeImages();
    const vm = buildEnterpriseInvestigationViewModel(withDiscovery as never);
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const slot = drawInvestigationEvidencePdf(doc, {
      vm, report: withDiscovery as never, assetName: 'Ramappa Temple',
      comparisonImages: { original: img.original, probe: img.probe }, difference: img.difference, differenceMap: img.map,
    });
    drawEvidenceVerification(doc, slot, null);
    const buf = Buffer.from(doc.output('arraybuffer'));
    writeFileSync(join(process.cwd(), 'tmp', 'Full report with discovery (test data) - Evidence Report.pdf'), buf);
    const text = pdfText(buf);
    expect(text).toContain('https://example.com/p/ramappa');
    expect(text).toContain('user-provided, not verified');
    expect(text).toContain('Photo gallery of a travel blog');
  });

  test('without discovery details nothing is labelled user-provided', () => {
    const vm = buildEnterpriseInvestigationViewModel(report as never);
    const d = buildForensicReport(report as never, vm, { assetName: 'Ramappa Temple' });
    expect(JSON.stringify(d)).not.toMatch(/user-provided/i);
    expect(d.s6.rows.some((r) => r.eventType.includes('reported'))).toBe(false);
  });
});
