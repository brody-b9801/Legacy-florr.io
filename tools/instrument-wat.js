// tools/instrument-wat.js
// Adds a call to an imported `t.trace(funcIndex)` at the entry of every defined
// function in a WAT file produced by `wasm2wat --generate-names` (names must be
// symbolic so the extra import doesn't shift any references).
//
//   npx wasm2wat --generate-names sp_server.wasm -o sp_named.wat
//   node tools/instrument-wat.js sp_named.wat sp_traced.wat
//   npx wat2wasm sp_traced.wat -o sp_traced.wasm
//
// funcIndex is the ORIGINAL function index (imports first), matching wasm-objdump
// and the `;N;` comments of a plain wasm2wat dump.

const fs = require('fs');

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error('Usage: node tools/instrument-wat.js <in.wat> <out.wat>'); process.exit(1); }

const lines = fs.readFileSync(inPath, 'utf8').split('\n');
const out = [];
let imports = 0;
let funcIndex = -1;
let pending = false;
let insertedImport = false;

for (const line of lines) {
  if (/^  \(import "[^"]*" "[^"]*" \(func /.test(line)) imports++;

  if (pending && !/^    \(local /.test(line)) {
    out.push(`    i32.const ${funcIndex}`, '    call $__trace');
    pending = false;
  }

  if (/^  \(func /.test(line)) {
    if (!insertedImport) {
      // All imports precede the first defined func; add ours right before it.
      out.push('  (import "t" "trace" (func $__trace (param i32)))');
      insertedImport = true;
      funcIndex = imports - 1;
    }
    funcIndex++;
    pending = true;
    out.push(line);
    // One-line bodies like `(func $x (type $t) nop)` are not produced by wasm2wat
    // for this module; if the header closes on the same line, skip instrumenting.
    if (/\)\s*$/.test(line) && (line.match(/\(/g) || []).length === (line.match(/\)/g) || []).length) pending = false;
    continue;
  }
  out.push(line);
}

fs.writeFileSync(outPath, out.join('\n'));
console.log(`instrumented ${funcIndex - imports + 1} functions (imports: ${imports})`);
