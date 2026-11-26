/**
 * Load driver for the upload-session test server (scripts/uploads/test-server.ts).
 *
 *   node scripts/uploads/stress-upload.cjs --size-mb 1024 [--files 1] [--parallel 4] [--chaos] [--base http://127.0.0.1:4100]
 *
 * Generates the data on the fly (no source file on disk), uploads --files files at the same time, each as parts sent
 * --parallel at a time, then completes them. With --chaos it also drops connections mid-part, sends damaged parts and
 * repeats parts, and checks the server recovers. Samples the server's own memory the whole time and prints one JSON line.
 */
const crypto = require('crypto');
const http = require('http');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
};
const sizeMb = Number(arg('size-mb', 64));
const files = Number(arg('files', 1));
const parallel = Number(arg('parallel', 4));
const chaos = arg('chaos', false) === true;
const base = new URL(String(arg('base', 'http://127.0.0.1:4100')));
const partBytes = Number(arg('part-mb', 8)) * 1024 * 1024;
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

const seedBlock = crypto.randomBytes(partBytes);
/** Part i of file f: a shared random block made unique by its file and index. Cheap to produce, impossible to confuse. */
function partData(f, i, length) {
  const buf = Buffer.from(seedBlock.subarray(0, length));
  buf.writeUInt32BE(f, 0);
  buf.writeUInt32BE(i, 4);
  return buf;
}

function request(method, path, user, { headers = {}, body, abortAfter } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: base.hostname, port: base.port, path, method, agent, headers: { 'x-test-user': user, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', (err) => (abortAfter ? resolve({ status: 0, json: null, dropped: true }) : reject(err)));
    if (abortAfter) {
      req.write(body.subarray(0, abortAfter), () => setTimeout(() => req.destroy(), 20));
    } else {
      req.end(body);
    }
  });
}
const json = (method, path, user, payload) =>
  request(method, path, user, { headers: { 'content-type': 'application/json' }, body: payload === undefined ? undefined : Buffer.from(JSON.stringify(payload)) });

async function sampleServer(state) {
  for (;;) {
    try {
      const { json: s } = await request('GET', '/__stats', 'monitor');
      state.peakRss = Math.max(state.peakRss, s.rss);
      state.peakHeld = Math.max(state.peakHeld, s.heapUsed + s.arrayBuffers);
    } catch { /* server busy */ }
    await new Promise((r) => setTimeout(r, 200));
    if (state.stop) return;
  }
}

async function uploadFile(f, stats) {
  const user = `stress-user-${f}`;
  const size = sizeMb * 1024 * 1024;
  const total = Math.ceil(size / partBytes);
  const lengthOf = (i) => (i === total - 1 ? size - i * partBytes : partBytes);

  const whole = crypto.createHash('sha256');
  for (let i = 0; i < total; i++) whole.update(partData(f, i, lengthOf(i)));
  const fileHash = whole.digest('hex');

  const created = await json('POST', '/uploads', user, { filename: `stress-${f}.bin`, mimeType: 'application/octet-stream', sizeBytes: size, chunkSizeBytes: partBytes });
  if (created.status !== 201) throw new Error(`create failed ${created.status} ${JSON.stringify(created.json)}`);
  const { id } = created.json.upload;

  let next = 0;
  const worker = async () => {
    while (next < total) {
      const i = next++;
      const data = partData(f, i, lengthOf(i));
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      const put = (payload, h, abortAfter) =>
        request('PUT', `/uploads/${id}/parts/${i}`, user, { headers: { 'x-part-sha256': h, 'content-length': String(payload.length), 'content-type': 'application/octet-stream' }, body: payload, abortAfter });
      if (chaos && Math.random() < 0.05) { // connection drops mid-part
        stats.dropped += 1;
        await put(data, hash, Math.floor(data.length / 3));
      }
      if (chaos && Math.random() < 0.03) { // a damaged part
        const bad = Buffer.from(data);
        bad[bad.length >> 1] ^= 0xff;
        const r = await put(bad, hash);
        if (r.status !== 422) throw new Error(`damaged part was not refused (${r.status})`);
        stats.damagedRefused += 1;
      }
      let r = await put(data, hash);
      for (let tries = 0; r.status === 409 && r.json?.code === 'PART_IN_PROGRESS' && tries < 50; tries++) {
        await new Promise((res) => setTimeout(res, 100));
        r = await put(data, hash);
      }
      if (r.status !== 201 && r.status !== 200) throw new Error(`part ${i} failed ${r.status} ${JSON.stringify(r.json)}`);
      if (chaos && Math.random() < 0.05) { // the same part again
        const again = await put(data, hash);
        if (again.status !== 200 || !again.json.part.duplicate) throw new Error('a repeated part was not accepted as a duplicate');
        stats.repeats += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));

  const done = await json('POST', `/uploads/${id}/complete`, user, { sha256: fileHash });
  if (done.status !== 200 || done.json.upload.sha256 !== fileHash) throw new Error(`complete failed ${done.status} ${JSON.stringify(done.json)}`);
  return { id, user };
}

(async () => {
  const stats = { peakRss: 0, peakHeld: 0, stop: false, dropped: 0, damagedRefused: 0, repeats: 0 };
  const baseline = (await request('GET', '/__stats', 'monitor')).json;
  const sampler = sampleServer(stats);
  const t0 = Date.now();
  const results = await Promise.allSettled(Array.from({ length: files }, (_, f) => uploadFile(f, stats)));
  const seconds = (Date.now() - t0) / 1000;
  stats.stop = true;
  await sampler;
  const failed = results.filter((r) => r.status === 'rejected').map((r) => String(r.reason).slice(0, 200));
  const mb = (n) => Math.round(n / 1048576);
  console.log(JSON.stringify({
    files, sizeMbEach: sizeMb, parallelParts: parallel, chaos,
    ok: failed.length === 0, failed,
    seconds: Math.round(seconds * 10) / 10,
    throughputMBps: Math.round((files * sizeMb) / seconds),
    serverRssBaselineMb: mb(baseline.rss), serverRssPeakMb: mb(stats.peakRss),
    serverHeldPeakMb: mb(stats.peakHeld), serverHeldBaselineMb: mb(baseline.heapUsed + baseline.arrayBuffers),
    droppedConnections: stats.dropped, damagedPartsRefused: stats.damagedRefused, repeatedPartsAccepted: stats.repeats,
  }));
  agent.destroy();
  process.exit(failed.length ? 1 : 0);
})();
