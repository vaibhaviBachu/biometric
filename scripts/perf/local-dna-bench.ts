/**
 * Phase 0 measurement: how long the local DNA patch search holds the Node thread, and what the server can still do meanwhile.
 *
 * No database, no network, no production data: it builds a synthetic owner (see tests/forensics/fixtures/synthetic-vault.ts)
 * shaped like the one in the 6 Nov 2026 incident (69 stored pictures, a probe of about 2,900 patches), runs the search in one
 * of three ways, and measures from the outside, the way a request waiting on the server would experience it:
 *
 *   legacy   the original loop (copy of the code before the performance work)
 *   sync     the new core run to the end without stopping (algorithm change only)
 *   yield    the new core in short slices (in-process, FORENSIC_WORKERS=off)
 *   worker   the new core in worker threads (FORENSIC_WORKER_COUNT=1 or 2; what the server now does by default)
 *
 * While it runs, a 5 ms timer stands in for "any other request": its worst delay is how long every other user would have
 * waited. With --concurrent N it starts N searches at once (N investigations).
 *
 * Usage: npx ts-node --transpile-only scripts/perf/local-dna-bench.ts <legacy|sync|yield|worker> [--indexes 69] [--patches 1500]
 *        [--probes 2931] [--probe-variants 1] [--concurrent 1] [--slice 15] [--out file.json]
 */
import fs from 'fs';
import os from 'os';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { matchAllIndexesSync, matchAllIndexesYielding } from '../../src/services/forensics/local-dna-match-core';
import { forensicWorkerPool, matchOffThread, type OffThreadIndex } from '../../src/services/forensics/forensic-workers';
import { legacyMatchAllIndexes } from '../../tests/forensics/fixtures/legacy-local-dna-match';
import { buildSyntheticVault } from '../../tests/forensics/fixtures/synthetic-vault';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}
function argStr(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const mode = (process.argv[2] ?? 'yield') as 'legacy' | 'sync' | 'yield' | 'worker';
const indexes = arg('indexes', 69);
const patches = arg('patches', 1500);
const probes = arg('probes', 2931);
const variants = arg('probe-variants', 1);
const concurrent = arg('concurrent', 1);
const slice = arg('slice', 15);

const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;

async function main(): Promise<void> {
  console.error(`building synthetic owner: ${indexes} pictures x ${patches} patches, probe ${probes} patches...`);
  const vault = buildSyntheticVault({ seed: 21, indexes, patchesPerIndex: patches, probePatches: probes });
  // Different probe variants (like original / normalised / denoised ...) are different patch lists against the same vault.
  const probeSets = Array.from({ length: variants }, (_, v) =>
    v === 0 ? vault.probe : buildSyntheticVault({ seed: 100 + v, indexes: 1, patchesPerIndex: 10, probePatches: probes }).probe);

  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  const gaps: number[] = [];
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last - 5);
    last = now;
  }, 5);

  const cpu0 = process.cpuUsage();
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
  const started = performance.now();

  const offThread: OffThreadIndex[] = vault.indexes.map((i, n) => ({ ...i, id: `idx-${n}`, updatedAt: new Date(1_700_000_000_000), patchCount: i.vaultPatches.length }));
  if (mode === 'worker') await matchOffThread(probeSets[0]!.slice(0, 50), offThread); // start the worker(s) and send the indexes before timing

  const one = async (): Promise<number> => {
    let hits = 0;
    for (const probe of probeSets) {
      const found = mode === 'legacy'
        ? legacyMatchAllIndexes(probe, vault.indexes)
        : mode === 'sync'
          ? matchAllIndexesSync(probe, vault.indexes)
          : mode === 'worker'
            ? await matchOffThread(probe, offThread)
            : await matchAllIndexesYielding(probe, vault.indexes, { sliceMs: slice });
      hits += found.length;
      // Let the timer and other callbacks in between probe variants, as the awaits between stages do in the server.
      await new Promise((r) => setImmediate(r));
    }
    return hits;
  };

  const results = await Promise.all(Array.from({ length: concurrent }, one));
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpu0);
  clearInterval(ticker);
  clearInterval(sampler);
  histogram.disable();

  const sorted = [...gaps].sort((a, b) => a - b);
  const pct = (p: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! * 10) / 10 : 0);
  const summary = {
    mode, indexes, patchesPerIndex: patches, probePatches: probes, probeVariants: variants, concurrentSearches: concurrent,
    sliceMs: mode === 'yield' ? slice : null,
    workers: mode === 'worker' ? forensicWorkerPool.stats().workers : null,
    cpus: os.cpus().length,
    wallMs: Math.round(wallMs),
    cpuUserMs: Math.round(cpu.user / 1000),
    hitsPerSearch: results,
    otherRequestDelayMs: {
      samples: gaps.length,
      p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
      max: Math.round(Math.max(0, ...gaps) * 10) / 10,
      eventLoopMaxMs: Math.round(histogram.max / 1e6),
    },
    memoryMb: { rssPeak: mb(peakRss), heapUsed: mb(process.memoryUsage().heapUsed), external: mb(process.memoryUsage().external) },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (mode === 'worker') await forensicWorkerPool.close();
  const out = argStr('out');
  if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
}

void main().then(() => process.exit(0));
