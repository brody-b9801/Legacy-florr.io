// server/index.js — self-hosted florr.io (old) server.
//
//   node server/index.js [port] [--sp]
//
// Serves the game (florr-local/static.florr.io/old/) and tunnels the client's
// sp_server worker calls over a WebSocket at /ws. Open http://<host>:<port>/?mp
// to play on this server (without ?mp the page runs its own local worker).
//
//   default  one shared world for everyone (server/mp-host.js)
//   --sp     one private world per connection (sp_server unmodified, for comparison)
//
// Wire format (binary WebSocket frames):
//   client -> server  u8 func (0 init, 1 send, 2 flush, 3 think) | i32 callbackId | payload
//   server -> client  i32 callbackId | u8 finalResponse | payload

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SpServer } = require('./sp-host');
const { World } = require('./mp-host');

const args = process.argv.slice(2);
const PORT = parseInt(args.find((a) => /^\d+$/.test(a)), 10) || 3000;
const SP_MODE = args.includes('--sp');
const ROOT = path.join(__dirname, '..', 'florr-local', 'static.florr.io', 'old');

const FUNCS = ['sp_server_init', 'sp_server_send', 'sp_server_flush', 'sp_server_think'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8',
};

// ---- static files (same rules as serve.js) --------------------------------

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found: ' + urlPath); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---- minimal RFC 6455 WebSocket --------------------------------------------

function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return false; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
               `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  return true;
}

function wsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

// Calls onMessage(Buffer) for each complete binary/text message; handles ping/close.
function wsReader(socket, onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, opcode = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskOff + (i & 3)];
      buf = buf.subarray(off + len);

      if (opcode === 0x8) { socket.end(wsFrame(0x8, Buffer.alloc(0))); return; }
      if (opcode === 0x9) { socket.write(wsFrame(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      fragments.push(payload);
      if (fin) { const msg = Buffer.concat(fragments); fragments = []; onMessage(msg); }
    }
  });
  socket.on('close', onClose);
  socket.on('error', () => socket.destroy());
}

// ---- game tunnel ----------------------------------------------------------

let world = null;
let nextId = 1;

server.on('upgrade', async (req, socket) => {
  if (req.url.split('?')[0] !== '/ws' || !wsAccept(req, socket)) { socket.destroy(); return; }
  const id = nextId++;
  const addr = socket.remoteAddress;
  console.log(`[ws] #${id} connected from ${addr}`);

  const send = (m) => {
    if (socket.destroyed) return;
    const data = m.data ? Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength) : Buffer.alloc(0);
    const head = Buffer.alloc(5);
    head.writeInt32LE(m.callbackId, 0);
    head[4] = m.finalResponse ? 1 : 0;
    socket.write(wsFrame(0x2, Buffer.concat([head, data])));
  };

  // Messages that arrive before the backend is ready are queued.
  let backend = null;
  const pending = [];
  const deliver = (msg) => {
    if (msg.length < 5) return;
    const funcName = FUNCS[msg[0]];
    if (!funcName) return;
    const data = msg.length > 5 ? Uint8Array.from(msg.subarray(5)) : 0;
    backend.post({ funcName, callbackId: msg.readInt32LE(1), data });
  };

  wsReader(socket, (msg) => (backend ? deliver(msg) : pending.push(msg)), () => {
    console.log(`[ws] #${id} disconnected`);
    if (backend) backend.close();
  });

  if (SP_MODE) {
    const sp = await SpServer.create({ quiet: true });
    sp.onResponse = send;
    backend = { post: (m) => sp.post(m), close: () => sp.destroy() };
  } else {
    backend = world.connect(send);
    if (!backend) {
      console.log(`[ws] #${id} rejected: server full`);
      socket.end(wsFrame(0x8, Buffer.from([0x03, 0xf0, ...Buffer.from('server full')]))); // close 1008
      return;
    }
    console.log(`[ws] #${id} joined the shared world (${world.connections.size} connected)`);
  }
  pending.splice(0).forEach(deliver);
});

(async () => {
  if (!SP_MODE) world = await World.create({ quiet: true });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`florr.io (old) server — ${SP_MODE ? 'private world per connection (--sp)' : 'shared world'}`);
    console.log(`  Local: http://localhost:${PORT}/?mp`);
    console.log(`  LAN:   http://<your-LAN-IP>:${PORT}/?mp  (see \`ipconfig\`)`);
  });
})();
