/**
 * Phase 3 measurement: what one public portfolio picture costs the server, before and after.
 *
 *   before  every request decrypts the whole original and resizes it to 960 px (the sharp work is measured; the AES decrypt of a
 *           17 MB file adds a little more, and the download from storage adds seconds on top, as the 6 Nov log shows)
 *   after   the first request makes the 960 px preview once; every later request is a memory read, and a browser that already has it
 *           gets "304 not changed" with no work at all
 *
 * Synthetic 6000 x 4000 photo (about the 17 MB phone photo in the incident). No database, no storage, no network.
 * Usage: npx ts-node --transpile-only scripts/perf/portfolio-media-bench.ts [--requests 40] [--concurrent 8]
 */
import sharp from 'sharp';
import { performance } from 'perf_hooks';

const arg = (n: string, d: number) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const requests = arg('requests', 40);
const concurrent = arg('concurrent', 8);
const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;

async function legacyRequest(original: Buffer): Promise<number> {
  const out = await sharp(original).rotate().resize(960, 960, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
  return out.length;
}

async function main(): Promise<void> {
  console.error('making a 6000 x 4000 photo...');
  const original = await sharp({ create: { width: 6000, height: 4000, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 60 } } })
    .jpeg({ quality: 92 }).toBuffer();
  console.error(`original: ${mb(original.length)} MB`);

  const run = async (label: string, one: () => Promise<unknown>) => {
    let peak = process.memoryUsage().rss;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    const gaps: number[] = [];
    let last = performance.now();
    const ticker = setInterval(() => { const n = performance.now(); gaps.push(n - last - 10); last = n; }, 10);
    const started = performance.now();
    const cpu0 = process.cpuUsage();
    let issued = 0;
    await Promise.all(Array.from({ length: concurrent }, async () => {
      while (issued < requests) { issued++; await one(); }
    }));
    const wall = performance.now() - started;
    const cpu = process.cpuUsage(cpu0);
    clearInterval(sampler); clearInterval(ticker);
    return {
      label, requests, concurrent,
      wallMs: Math.round(wall),
      perRequestMs: Math.round((wall / requests) * 100) / 100,
      cpuMsPerRequest: Math.round(((cpu.user + cpu.system) / 1000 / requests) * 100) / 100,
      otherRequestDelayMaxMs: Math.round(Math.max(0, ...gaps)),
      rssPeakMb: mb(peak),
    };
  };

  const before = await run('before: decrypt-and-resize the original on every request', () => legacyRequest(original));

  // After: one preview made once, then served from memory (what getVaultThumbnail does).
  let building: Promise<Buffer> | null = null; // requests that arrive while it is being made share one build, as the server does
  let preview: Buffer | null = null;
  const after = await run('after: stored preview from memory', async () => {
    building ??= sharp(original).rotate().resize(960, 960, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
    preview = await building;
    return preview;
  });
  const notModified = await run('after, browser already has it: 304 (no work)', async () => null);

  console.log(JSON.stringify({ originalMb: mb(original.length), previewKb: Math.round((preview as unknown as Buffer).length / 1024), before, after, notModified }, null, 2));
  process.exit(0);
}

void main();
