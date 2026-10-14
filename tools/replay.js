// tools/replay.js
// Replays a capture's page->worker calls (init/send/flush) into a headless
// sp_server (server/sp-host.js) with the original timing, and compares the
// worker's responses with the ones recorded in the browser.
//
//   node tools/replay.js scratchpad_capture1.json [--seconds 20]

const fs = require('fs');
const { SpServer } = require('../server/sp-host');

async function main() {
  const [, , file, ...opts] = process.argv;
  if (!file) { console.error('Usage: node tools/replay.js <capture.json> [--seconds N]'); process.exit(1); }
  const si = opts.indexOf('--seconds');
  const seconds = si >= 0 ? parseFloat(opts[si + 1]) : 20;

  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  const calls = log.filter((r) => r.dir === 'C2S');
  if (!calls.length || calls[0].name !== 'sp_server_init') {
    console.error('Capture must start with sp_server_init (record from page load).');
    process.exit(1);
  }
  const t0 = calls[0].t;
  const until = t0 + seconds * 1000;
  const recorded = log.filter((r) => r.dir === 'S2C' && r.t <= until);

  const sp = await SpServer.create({ quiet: true });
  const got = [];
  sp.onResponse = (m) => got.push({ t: performance.now(), len: m.data ? m.data.length : 0, fin: m.finalResponse });

  const start = performance.now();
  let cb = 0;
  for (const c of calls) {
    if (c.t > until) break;
    const wait = (c.t - t0) - (performance.now() - start);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const data = c.len ? Uint8Array.from(Buffer.from(c.hex, 'hex')) : 0;
    // Fresh callback ids like the client; sends use -1 (fire and forget).
    sp.post({ funcName: c.name, callbackId: c.name === 'sp_server_send' ? -1 : cb++, data });
  }
  await new Promise((r) => setTimeout(r, 200));
  sp.destroy();

  const sum = (a) => a.reduce((s, x) => s + x.len, 0);
  const sized = (a) => a.filter((x) => x.len);
  console.log(`replayed ${seconds}s: ${calls.filter((c) => c.t <= until).length} calls`);
  console.log(`browser:  ${sized(recorded).length} non-empty responses, ${sum(recorded)} bytes`);
  console.log(`headless: ${sized(got).length} non-empty responses, ${sum(got)} bytes`);
  const hist = (a) => { const h = {}; for (const x of sized(a)) { const b = x.len < 50 ? '<50' : x.len < 200 ? '50-199' : x.len < 1000 ? '200-999' : '1000+'; h[b] = (h[b] || 0) + 1; } return h; };
  console.log('browser  size histogram:', hist(recorded));
  console.log('headless size histogram:', hist(got));
}

main();
