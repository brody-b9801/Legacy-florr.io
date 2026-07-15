// har-extract.js
// Reconstructs a site's file tree from a DevTools "Save all as HAR with content" capture.
//
// Usage:
//   node har-extract.js <input.har> [outputDir]
//
// Example (PowerShell, from "C:\Users\brody\Legacy florr.io"):
//   node har-extract.js florr.har ./florr-local
//
// Output layout:
//   <outputDir>/<hostname>/<path...>   e.g. florr-local/static.florr.io/client.wasm
// The folder containing index.html is the one you serve (npx serve / python -m http.server).

const fs = require('fs');
const path = require('path');

const [, , harPath, outDir = './out'] = process.argv;

if (!harPath) {
  console.error('Usage: node har-extract.js <input.har> [outputDir]');
  process.exit(1);
}
if (!fs.existsSync(harPath)) {
  console.error('HAR file not found: ' + harPath);
  process.exit(1);
}

let har;
try {
  har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
} catch (err) {
  console.error('Failed to parse HAR (is it valid JSON?): ' + err.message);
  process.exit(1);
}

const entries = (har.log && har.log.entries) || [];
if (!entries.length) {
  console.error('No entries found in HAR. Did you use "Save all as HAR with content"?');
  process.exit(1);
}

let written = 0;
let skipped = 0;
const seen = new Set();
const emptyBodies = [];

for (const e of entries) {
  const req = e.request || {};
  const res = e.response || {};
  const c = res.content;

  // Skip responses with no body (redirects, 304s, or bodies Chrome didn't retain).
  if (!c || typeof c.text !== 'string' || c.text.length === 0) {
    if (req.url) emptyBodies.push(req.url);
    skipped++;
    continue;
  }

  let u;
  try {
    u = new URL(req.url);
  } catch {
    skipped++;
    continue;
  }

  // Build a filesystem-safe relative path from the URL path (ignore query strings).
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  const dest = path.join(outDir, u.hostname, rel);

  // De-dupe: if the same URL appears twice, keep the first non-empty body.
  if (seen.has(dest)) {
    skipped++;
    continue;
  }
  seen.add(dest);

  const buf =
    c.encoding === 'base64'
      ? Buffer.from(c.text, 'base64') // binaries: wasm, images, fonts
      : Buffer.from(c.text, 'utf8');  // text: js, css, html, json

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  written++;

  const sizeKB = (buf.length / 1024).toFixed(1);
  console.log(`${u.hostname}/${rel}  (${sizeKB} KB)`);
}

console.log('\n--- done ---');
console.log(`wrote ${written} files, skipped ${skipped}`);

// Flag any responses that came through empty — you may need to grab these
// manually via right-click -> Save on that request in the Network tab.
if (emptyBodies.length) {
  console.log('\nResponses with no saved body (' + emptyBodies.length + ') — grab manually if needed:');
  for (const url of emptyBodies.slice(0, 40)) console.log('  ' + url);
  if (emptyBodies.length > 40) console.log('  ...and ' + (emptyBodies.length - 40) + ' more');
}

// Sanity check: warn if the important wasm files look missing or suspiciously small.
const wasmChecks = ['client.wasm', 'sp_server.wasm'];
for (const name of wasmChecks) {
  let found = null;
  for (const p of seen) {
    if (p.endsWith(name)) { found = p; break; }
  }
  if (!found) {
    console.log(`\n[warn] ${name} was not found in the capture. Reload with "Disable cache" checked, or Save it manually from Network.`);
  } else {
    const bytes = fs.statSync(found).size;
    if (bytes < 50 * 1024) {
      console.log(`\n[warn] ${found} is only ${(bytes / 1024).toFixed(1)} KB — that may be a truncated body. Verify it plays, or re-grab it manually.`);
    }
  }
}
