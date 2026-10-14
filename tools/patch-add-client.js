// tools/patch-add-client.js
// Builds sp_server.mp.wasm: the original sp_server.wasm plus exports
// `add_client() -> i32` (creates one more engine client) and `damage(...)` (below).
//
// In the single-player build, init ($u) creates exactly one client inside its
// run-once block (see research/NOTES.md, "Multi-client support inside the engine").
// This copies that block verbatim into a new function. The block only depends on
// $p0 (= 0 on entry) and $l7 (init's 208-byte stack frame), never branches outside
// itself, and leaves the new client's index in $p1 (-1 on entry).
//
//   npx wasm2wat --generate-names sp_server.wasm -o sp_named.wat
//   node tools/patch-add-client.js sp_named.wat sp_mp.wat [--all-drops | --no-mobs]
//   npx wat2wasm sp_mp.wat -o florr-local/static.florr.io/old/sp_server.mp.wasm

const fs = require('fs');

const [, , inPath, outPath] = process.argv.filter((a) => !a.startsWith('--'));
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

// Also export the damage function ($f43: health component, source, amount, info*)
// that C2S opcode 3 uses to kill the player's flower, so the host can despawn a
// disconnected player through the game's normal death path.
const DAMAGE_FN = '$f43';
if (!lines.some((l) => l.startsWith(`  (func ${DAMAGE_FN} (type $t41) (param $p0 i32) (param $p1 i32) (param $p2 f32) (param $p3 i32)`))) {
  throw new Error(`${DAMAGE_FN} signature changed; re-check the opcode 3 handler in $w`);
}

// --all-drops: every mob carries every drop it can roll. Mobs roll their drops
// once at spawn in $f144: for each potential drop (8-byte entries at def+36:
// u8 petal id, f32 chance at +4), `random() < t * chance` (t = 3 when world
// flag [873] == 1, else 1) appends the petal, up to 6 drops. The comparison is
// replaced with "always true"; the RNG still advances so other rolls are unchanged.
// The 6-drop cap and the death-time legendary uniqueness check are left as is.
if (process.argv.includes('--all-drops')) {
  const s = lines.findIndex((l) => l.startsWith('  (func $f144 '));
  const e = lines.findIndex((l, i) => i > s && /^  \(func /.test(l));
  let hit = -1;
  for (let i = s; i < e; i++) {
    if (trim(i) === 'f32.lt' && /^if \$/.test(trim(i + 1)) && trim(i - 1) === 'f32.mul' &&
        trim(i - 2) === 'f32.load offset=4' && trim(i - 6) === 'f32.const 0x1p-31 (;=4.65661e-10;)') { hit = i; break; }
  }
  if (hit < 0) throw new Error('drop roll comparison not found in $f144');
  lines.splice(hit, 1, '    f32.lt', '    drop', '    i32.const 1');
  console.log(`--all-drops: patched drop roll in $f144 at line ${hit + 1}`);
}

// --no-mobs: the world never spawns mobs. $f113 (dcmp f_jd) spawns one mob in
// zone $p0 and returns nonzero on success; the population loop ($f_ko) keeps
// calling it until each zone's count reaches its target, and stops as soon as it
// returns 0. Returning 0 up front leaves every zone empty. Entities spawned by
// petals (egg hatches, peas, etc.) use other paths and still work.
if (process.argv.includes('--no-mobs')) {
  const s = lines.findIndex((l) => l.startsWith('  (func $f113 (type $t1) (param $p0 i32) (result i32)'));
  if (s < 0 || !/^    \(local /.test(lines[s + 1]) || trim(s + 2) !== 'global.get $g0' || trim(s + 8) !== 'i32.const 4') {
    throw new Error('mob spawn function $f113 not found or changed');
  }
  lines.splice(s + 2, 0, '    i32.const 0', '    return');
  console.log(`--no-mobs: $f113 (zone mob spawn) now returns 0 at line ${s + 3}`);
}

const firstExport = lines.findIndex((l) => /^  \(export /.test(l));
const out = [
  ...lines.slice(0, firstExport),
  ...fn,
  '  (export "add_client" (func $sp_add_client))',
  `  (export "damage" (func ${DAMAGE_FN}))`,
  ...lines.slice(firstExport),
];
fs.writeFileSync(outPath, out.join('\n'));
console.log(`copied init lines ${start + 1}..${end + 1} (${end - start + 1} lines) into $sp_add_client`);
