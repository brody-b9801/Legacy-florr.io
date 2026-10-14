// tools/analyze-capture.js
// Decodes client->server packets from a capture written by the index.html harness
// (__proto.save(label) -> captures/<label>.json).
//
//   node tools/analyze-capture.js captures/kbd-session.json [--raw]
//
// C2S obfuscation (see research/NOTES.md): every send buffer is XORed with a fixed
// 256-byte table indexed by byte position within the buffer. The table is a literal
// in the data section of both sp_server.wasm and client.wasm. Layout after de-XOR:
//   varint  counter   (increments by 1 per message)
//   u8      opcode    (0x0c = input, 0x04 = spawn/nickname)
//   ...payload
// Input (0x0c) payload: u8 flags (bit0 attack, bit1 defend), f32 angle (rad), f32 magnitude.

const fs = require('fs');
const path = require('path');

// Located by searching for key bytes recovered from known plaintexts
// (angle 0, magnitude 0, nickname); same table at client.wasm offset 1762197.
const SP_WASM = path.join(__dirname, '..', 'florr-local', 'static.florr.io', 'old', 'sp_server.wasm');
const KEY_OFFSET = 463085;
const KEY = fs.readFileSync(SP_WASM).subarray(KEY_OFFSET, KEY_OFFSET + 256);

const OP = { 0x0c: 'input', 0x04: 'spawn' };

function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function unxor(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ KEY[i & 0xff];
  return out;
}

function readVarint(b, p) {
  let v = 0, shift = 0;
  for (;;) {
    const c = b[p++];
    v |= (c & 0x7f) << shift;
    if (!(c & 0x80)) return [v, p];
    shift += 7;
  }
}

function f32(b, p) {
  return new DataView(b.buffer, b.byteOffset + p, 4).getFloat32(0, true);
}

// Decode one message starting at offset `start` of de-XORed buffer `b`.
function decodeMessage(b, start) {
  let [ctr, p] = readVarint(b, start);
  const op = b[p++];
  if (op === 0x0c && p + 9 <= b.length) {
    return { len: p + 9 - start, ctr, op: 'input', flags: b[p], angle: f32(b, p + 1), mag: f32(b, p + 5) };
  }
  if (op === 0x04) {
    const end = b.indexOf(0, p + 2);
    const nameEnd = end < 0 ? b.length : end;
    return { len: nameEnd + 1 - start, ctr, op: 'spawn', hdr: [b[p], b[p + 1]],
             name: Buffer.from(b.subarray(p + 2, nameEnd)).toString('utf8') };
  }
  return { len: b.length - start, ctr, op: '0x' + op.toString(16), body: Buffer.from(b.subarray(p)).toString('hex') };
}

// Split a send into messages. Sends are sometimes batched (e.g. 24 = 12 + 12).
function decodeSend(bytes) {
  const b = unxor(bytes);
  const msgs = [];
  let off = 0;
  while (off < b.length) {
    const m = decodeMessage(b, off);
    msgs.push(m);
    if (!m.len) break;
    off += m.len;
  }
  return msgs;
}

// Counter continuity across all decoded input messages (a repeat = resent message).
function checkCounters(msgs) {
  let step = 0, repeat = 0, other = 0, prev = null;
  for (const m of msgs) {
    if (prev != null) (m.ctr === prev + 1 ? step++ : m.ctr === prev ? repeat++ : other++);
    prev = m.ctr;
  }
  return { step, repeat, other };
}

function fmtFlags(f) {
  const s = [];
  if (f & 1) s.push('ATK');
  if (f & 2) s.push('DEF');
  if (f & ~3) s.push('0x' + (f & ~3).toString(16));
  return s.join('+') || '-';
}

function main() {
  const [, , file, ...opts] = process.argv;
  if (!file) { console.error('Usage: node tools/analyze-capture.js <capture.json> [--raw]'); process.exit(1); }
  const raw = opts.includes('--raw');
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));

  const sends = log.filter((r) => r.dir === 'C2S' && r.name === 'sp_server_send' && r.len).map((r) => hexToBytes(r.hex));
  const all = sends.flatMap((s) => decodeSend(s));
  const c = checkCounters(all);
  console.log(`# ${file}: ${sends.length} sends, ${all.length} messages, counter +1=${c.step} repeat=${c.repeat} other=${c.other}`);

  const byMark = new Map();
  let mark = '(start)';
  for (const r of log) {
    if (r.dir === 'MARK') { mark = r.name; continue; }
    if (r.dir !== 'C2S' || r.name !== 'sp_server_send' || !r.len) continue;
    for (const m of decodeSend(hexToBytes(r.hex))) {
      if (!byMark.has(mark)) byMark.set(mark, []);
      byMark.get(mark).push(m);
      if (raw) console.log(`  ${Math.round(r.t)} ${mark} ${JSON.stringify(m)}`);
    }
  }

  // Per-label summary: distinct (op, flags, angle°, magnitude) tuples.
  for (const [label, msgs] of byMark) {
    const seen = new Map();
    for (const m of msgs) {
      const key = m.op === 'input'
        ? `input flags=${fmtFlags(m.flags)} angle=${(m.angle * 180 / Math.PI).toFixed(0)}° mag=${m.mag.toFixed(0)}`
        : m.op === 'spawn' ? `spawn name=${JSON.stringify(m.name)} hdr=${m.hdr}` : `${m.op} ${m.body}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    console.log(`## ${label}`);
    for (const [k, n] of seen) console.log(`   ${n}x ${k}`);
  }
}

main();
