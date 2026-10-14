// tools/patch-add-client.js
// Builds sp_server.mp.wasm: the original sp_server.wasm plus an export
// `add_client() -> i32` that creates one more client from the engine's client pool.
//
// In the single-player build, init ($u) creates exactly one client inside its
// run-once block (see research/NOTES.md, "Multi-client support inside the engine").
// This copies that block verbatim into a new function. The block only depends on
// $p0 (= 0 on entry) and $l7 (init's 208-byte stack frame), never branches outside
// itself, and leaves the new client's index in $p1 (-1 on entry).
//
//   npx wasm2wat --generate-names sp_server.wasm -o sp_named.wat
//   node tools/patch-add-client.js sp_named.wat sp_mp.wat
//   npx wat2wasm sp_mp.wat -o florr-local/static.florr.io/old/sp_server.mp.wasm

const fs = require('fs');

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error('Usage: node tools/patch-add-client.js <named.wat> <out.wat>'); process.exit(1); }

const lines = fs.readFileSync(inPath, 'utf8').split('\n');
const trim = (i) => (lines[i] || '').trim();

// Locate init.
const uStart = lines.findIndex((l) => /^  \(func \$u /.test(l));
const uEnd = lines.findIndex((l, i) => i > uStart && /^  \(func /.test(l));
if (uStart < 0) throw new Error('func $u not found (was the WAT made with --generate-names?)');

// The block starts right after `8545496 <- 0` with: i32.const 25116 / i32.load / local.tee $l2 / if
let start = -1;
for (let i = uStart; i < uEnd; i++) {
  if (trim(i) === 'i32.const 25116' && trim(i + 1) === 'i32.load' && trim(i + 2) === 'local.tee $l2' && /^if \$/.test(trim(i + 3)) &&
      trim(i - 3) === 'i32.const 8545496') { start = i; break; }
}
if (start < 0) throw new Error('client-creation block not found in $u');

let depth = 0, end = -1;
for (let i = start; i < uEnd; i++) {
  const t = trim(i);
  if (/^(block|loop|if)\b/.test(t)) depth++;
  if (/^end\b/.test(t) && --depth === 0) { end = i; break; }
}
if (end < 0) throw new Error('end of block not found');
if (!(trim(end + 1) === 'i32.const 8545776' && trim(end + 2) === 'i32.const 1')) throw new Error('unexpected code after block');

// Same locals as $u ($p0/$p1 become plain locals).
const localDecls = [];
for (let i = uStart + 1; /^    \(local /.test(lines[i]); i++) localDecls.push(lines[i]);

const fn = [
  '  (func $sp_add_client (result i32)',
  '    (local $p0 i32) (local $p1 i32)',
  ...localDecls,
  '    global.get $g0',
  '    i32.const 208',
  '    i32.sub',
  '    local.tee $l7',
  '    global.set $g0',
  '    i32.const 0',
  '    local.set $p0',
  '    i32.const -1',
  '    local.set $p1',
  ...lines.slice(start, end + 1),
  '    local.get $l7',
  '    i32.const 208',
  '    i32.add',
  '    global.set $g0',
  '    local.get $p1)',
];

const firstExport = lines.findIndex((l) => /^  \(export /.test(l));
const out = [
  ...lines.slice(0, firstExport),
  ...fn,
  '  (export "add_client" (func $sp_add_client))',
  ...lines.slice(firstExport),
];
fs.writeFileSync(outPath, out.join('\n'));
console.log(`copied init lines ${start + 1}..${end + 1} (${end - start + 1} lines) into $sp_add_client`);
