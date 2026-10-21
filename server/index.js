// server/index.js — self-hosted florr.io (old) server.
//
//   node server/index.js [port] [--sp] [--spawn-menu] [--no-mobs] [--all-drops]
//
// Serves the game (florr-local/static.florr.io/old/) and tunnels the client's
// sp_server worker calls over a WebSocket at /ws. Open http://<host>:<port>/?mp
// to play on this server (without ?mp the page runs its own local worker).
//
//   default       one shared world for everyone (server/mp-host.js)
//   --sp          one private world per connection
//   --spawn-menu  players may pick their spawn level and petals on the title screen
//                 (otherwise the menu is hidden and loadouts are ignored)
//   --no-mobs     no mobs ever spawn
//   --all-drops   every mob drops all of its possible drops (no effect with --no-mobs)
//
// Wire format (binary WebSocket frames):
//   client -> server  u8 func (0 init, 1 send, 2 flush, 3 think, 4 keepalive, 5 loadout) | i32 callbackId | payload
//                     (func 5: UTF-8 JSON spawn loadout from the title screen, or "null"; see loadout.js)
//   server -> client  i32 callbackId | u8 finalResponse | payload
//                     (callbackId -2: session token for /ws?session=<token> resume;
//                      callbackId -3: u8 1/0 when the player gains/loses its flower;
//                      callbackId -4: UTF-8 JSON room options {spawnMenu}, sent on connect)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SpServer } = require('./sp-host');
const { World, reportAlive, worldWasm } = require('./mp-host');
const Loadout = require('../florr-local/static.florr.io/old/loadout.js');

const args = process.argv.slice(2);
const PORT = parseInt(args.find((a) => /^\d+$/.test(a)), 10) || 3000;
const SP_MODE = args.includes('--sp');
const ALL_DROPS = args.includes('--all-drops');
const NO_MOBS = args.includes('--no-mobs');
const SPAWN_MENU = args.includes('--spawn-menu');
const KNOWN = ['--sp', '--all-drops', '--no-mobs', '--spawn-menu'];
for (const a of args) if (!/^\d+$/.test(a) && !KNOWN.includes(a)) { console.error(`Unknown option ${a} (options: ${KNOWN.join(' ')})`); process.exit(1); }
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

const PING_MS = 5000; // heartbeat interval
const DEAD_MS = +process.env.FLORR_DEAD_MS || 30000; // no frames (incl. pong / page keepalive) for this long = gone

// Calls onMessage(Buffer) for each complete binary/text message and
// onClose(clean) exactly once when the peer leaves (clean = it sent a close
// frame, i.e. the tab was closed or reloaded, as opposed to a dropped link): close frame, TCP end/close, error, or a
// missed heartbeat. Through a proxy (e.g. cloudflared) the TCP connection can
// outlive the WebSocket, so 'close' alone is not enough. The page also sends a
// keepalive every few seconds, since a proxy may answer or drop pings itself.
function wsReader(socket, onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  let lastSeen = Date.now();
  let done = false;
  const finish = (clean) => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    socket.destroy();
    onClose(clean === true);
  };
  const heartbeat = setInterval(() => {
    if (Date.now() - lastSeen > DEAD_MS) { finish(false); return; }
    if (!socket.destroyed) socket.write(wsFrame(0x9, Buffer.alloc(0)));
  }, PING_MS);

  socket.on('data', (chunk) => {
    lastSeen = Date.now();
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

      if (opcode === 0x8) { if (!socket.destroyed) socket.write(wsFrame(0x8, Buffer.alloc(0))); finish(true); return; }
      if (opcode === 0x9) { socket.write(wsFrame(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      fragments.push(payload);
      if (fin) { const msg = Buffer.concat(fragments); fragments = []; onMessage(msg); }
    }
  });
  socket.on('end', () => finish(false));
  socket.on('close', () => finish(false));
  socket.on('error', () => finish(false));
}

// ---- game tunnel ----------------------------------------------------------
//
// Sessions: each shared-world player gets a token (sent as callbackId -2). A tab
// that closes or reloads (close frame) leaves at once. If the socket just drops
// (network, proxy, missed heartbeat), the player is suspended rather than killed: the flower stays in
// the world and its updates stay queued (the client pulls them with flush, so
// almost nothing is lost). The page's tunnel shim reconnects with
// /ws?session=<token> and reattaches to the same player. Only if nobody comes
// back within GRACE_MS is the flower killed. Unknown/expired tokens are refused
// with close code 4000 so the page can reload and join fresh.

const GRACE_MS = +process.env.FLORR_GRACE_MS || 45000;
const SESSION_CB = -2; // S2C callbackId carrying the session token
const OPTIONS_CB = -4; // S2C callbackId carrying the room options (JSON)
const CLOSE_UNKNOWN_SESSION = 4000;

let world = null;
let nextId = 1;
const sessions = new Map(); // token -> { conn, socket, graceTimer }

function frameFor(m) {
  const data = m.data ? Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength) : Buffer.alloc(0);
  const head = Buffer.alloc(5);
  head.writeInt32LE(m.callbackId, 0);
  head[4] = m.finalResponse ? 1 : 0;
  return wsFrame(0x2, Buffer.concat([head, data]));
}

server.on('upgrade', async (req, socket) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !wsAccept(req, socket)) { socket.destroy(); return; }
  const id = nextId++;
  const token = url.searchParams.get('session');
  console.log(`[ws] #${id} connected from ${socket.remoteAddress}${token ? ' (resuming)' : ''}`);

  const send = (m) => { if (!socket.destroyed) socket.write(frameFor(m)); };
  send({ callbackId: OPTIONS_CB, finalResponse: false, data: new Uint8Array(Buffer.from(JSON.stringify({ spawnMenu: SPAWN_MENU }))) });

  // Messages that arrive before the backend is ready are queued.
  let backend = null;
  const pending = [];
  const deliver = (msg) => {
    if (msg.length < 5) return;
    if (msg[0] === 5) { // spawn loadout from the title screen (only with --spawn-menu)
      if (!SPAWN_MENU) return;
      let lo = null;
      try { lo = JSON.parse(msg.subarray(5).toString('utf8')); } catch (e) { return; }
      backend.setLoadout(lo);
      return;
    }
    const funcName = FUNCS[msg[0]];
    if (!funcName) return; // e.g. the page's keepalive (func 4): only refreshes the heartbeat
    const data = msg.length > 5 ? Uint8Array.from(msg.subarray(5)) : 0;
    backend.post({ funcName, callbackId: msg.readInt32LE(1), data });
  };

  let gone = false;
  let session = null;
  wsReader(socket, (msg) => (backend ? deliver(msg) : pending.push(msg)), (clean) => {
    gone = true;
    if (session) {
      // Only act if this socket is still the session's current one (a resumed
      // session may already have moved to a newer socket).
      if (session.socket !== socket) return;
      if (clean) { // tab closed or reloaded: leave now
        console.log(`[ws] #${id} left`);
        sessions.delete(session.token);
        session.conn.close();
        return;
      }
      console.log(`[ws] #${id} dropped; holding player for ${GRACE_MS / 1000}s`);
      session.conn.send = () => {};
      session.graceTimer = setTimeout(() => {
        console.log(`[ws] #${id} did not come back; removing player`);
        sessions.delete(session.token);
        session.conn.close();
      }, GRACE_MS);
      return;
    }
    console.log(`[ws] #${id} disconnected`);
    if (backend) backend.close();
  });

  if (SP_MODE) {
    const sp = await SpServer.create({ quiet: true, wasmBinary: worldWasm({ noMobs: NO_MOBS, allDrops: ALL_DROPS }) });
    if (gone) { sp.destroy(); return; } // left while the world was starting
    sp.onResponse = send;
    let loadout = null, alive = null;
    backend = {
      post: (m) => {
        if (loadout && m.funcName === 'sp_server_send') Loadout.during(() => sp.heap, loadout, () => sp.post(m));
        else sp.post(m);
        if (m.funcName === 'sp_server_flush') alive = reportAlive(sp.heap, alive, send);
      },
      setLoadout: (lo) => { loadout = Loadout.normalize(lo); },
      close: () => sp.destroy(),
    };
    pending.splice(0).forEach(deliver);
    return;
  }

  if (token) {
    session = sessions.get(token);
    if (!session) {
      console.log(`[ws] #${id} unknown or expired session; asking the page to rejoin`);
      socket.end(wsFrame(0x8, Buffer.concat([Buffer.from([CLOSE_UNKNOWN_SESSION >> 8, CLOSE_UNKNOWN_SESSION & 255]), Buffer.from('session expired')])));
      return;
    }
    clearTimeout(session.graceTimer);
    const old = session.socket;
    session.socket = socket;
    if (old && !old.destroyed) old.destroy(); // overlapping reconnect: drop the stale socket quietly
    session.conn.send = send;
    backend = session.conn;
    console.log(`[ws] #${id} resumed its player (${world.connections.size} connected)`);
  } else {
    backend = world.connect(send);
    session = { token: crypto.randomBytes(16).toString('hex'), conn: backend, socket, graceTimer: null };
    sessions.set(session.token, session);
    send({ callbackId: SESSION_CB, finalResponse: false, data: new Uint8Array(Buffer.from(session.token)) });
    console.log(`[ws] #${id} joined the shared world (${world.connections.size} connected)`);
  }
  pending.splice(0).forEach(deliver);
});

(async () => {
  if (!SP_MODE) world = await World.create({ quiet: true, allDrops: ALL_DROPS, noMobs: NO_MOBS });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`florr.io (old) server — ${SP_MODE ? 'private world per connection (--sp)' : 'shared world'}`);
    console.log(`  spawn menu: ${SPAWN_MENU ? 'on' : 'off'} · mobs: ${NO_MOBS ? 'off' : 'on'} · drops: ${NO_MOBS ? 'n/a' : ALL_DROPS ? 'all' : 'normal'}`);
    console.log(`  Local: http://localhost:${PORT}/?mp`);
    console.log(`  LAN:   http://<your-LAN-IP>:${PORT}/?mp  (see \`ipconfig\`)`);
  });
})();
