// server/mp-host.js
// One shared sp_server world, many connections.
//
// The single-player build serves exactly one client: client slot 0, bound to a
// static connection object ("local", 418876..419240) and a static outgoing
// packet queue. Updates are only serialized for slot 0.
//
// So every connection gets its OWN engine client, and takes turns being slot 0:
//  - sp_server.mp.wasm exports `add_client()` (copied out of init by
//    tools/patch-add-client.js), which turns the queued connection object into
//    a new engine client for the slot in its first word (always 0 here).
//  - Each connection keeps a saved copy of the memory that binds "the" client:
//    the connection object, the outgoing queue, the current slot, and the slot-0
//    globals (client pointer struct and per-slot bytes). It is swapped in around
//    every call made on the connection's behalf.
// Entities (flowers, petals, mobs) live in the shared world, so players see and
// fight alongside each other. See research/NOTES.md ("Multiplayer").
//
// Ticks: the world uses a variable timestep (dt = time since last think, capped
// at 100 ms, shared timestamps at 8545496/8545504). Each interval runs one think
// per connection: the first advances the world by real dt, the rest (dt ~ 0)
// serialize their own views into their own queues. With nobody connected the
// world pauses.
//
// Disconnect: the player's flower is killed through the game's damage function
// (exported as `damage` by the patch), and the closed context keeps ticking for a
// few seconds so the death completes and the flower and petals are removed.

const fs = require('fs');
const path = require('path');
const { SpServer } = require('./sp-host');
const Loadout = require('../florr-local/static.florr.io/old/loadout.js');

const OLD = path.join(__dirname, '..', 'florr-local', 'static.florr.io', 'old');
const MP_WASM = path.join(OLD, 'sp_server.mp.wasm');
// Same build with tools/patch-add-client.js --all-drops: every mob carries all its possible drops.
const MP_WASM_ALL_DROPS = path.join(OLD, 'sp_server.mp.alldrops.wasm');
// Same build with tools/patch-add-client.js --no-mobs: the world never spawns mobs.
const MP_WASM_NO_MOBS = path.join(OLD, 'sp_server.mp.nomobs.wasm');

// The server build for a room's options ({noMobs, allDrops}). Without mobs
// there is nothing to drop, so noMobs wins.
function worldWasm(opts) {
  return fs.readFileSync(opts.noMobs ? MP_WASM_NO_MOBS : opts.allDrops ? MP_WASM_ALL_DROPS : MP_WASM);
}

// [start, end) byte ranges swapped per connection.
const CONN_REGIONS = [
  [418876, 419240], // connection object ("local"); [0]=slot at 418880, counter at 418968
  [8545488, 8545492], // current slot (always 0)
  [8545512, 8545580], // outgoing queue: u8 count at 8545512, 16 packet ptrs at 8545516
  [24936, 24948], // slot 0: client pointer struct (24936 + 12*slot)
  [24476, 24477], // slot 0: per-slot byte
  [24837, 24838], // slot 0: per-slot byte
  [25066, 25067], // slot 0: per-slot byte
];
const CONN_ID = 418880; // first word of the connection object = client slot
const CONN_NODE = 419000; // the object's node in the pending-connection queue
const CONN_TOKEN = 418956; // std::string token (12-byte libc++ SSO layout)
const CONN_COUNTER = 418968; // last C2S message counter accepted
const CUR_SLOT = 8545488;
const SLOT0_CLIENT = 24936; // pointer to slot 0's client object
const PLAYER_HEALTH_PATH = [120, 100, 164]; // client -> ... -> flower health component (hp f32 at +8)
const DYING_TICKS = 60; // ~3 s of ticks after a disconnect to let the death play out
const PENDING = { count: 25112, head: 25116, tail: 25120 };

// Tell the page when the player gains or loses its flower (S2C callbackId -3,
// one byte); the page shows the spawn menu while there is none. Returns the new state.
const ALIVE_CB = -3;
function reportAlive(heap, was, send) {
  const now = Loadout.hasFlower(heap);
  if (now !== was) send({ callbackId: ALIVE_CB, finalResponse: false, data: Uint8Array.of(now ? 1 : 0) });
  return now;
}

class Connection {
  constructor(world, id, saved, send) {
    this.world = world;
    this.id = id;
    this.saved = saved;
    this.send = send; // (msg) => void, msg = {callbackId, finalResponse, data}
    this.closed = false;
    this.loadout = null; // custom spawn level/petals from the title screen (loadout.js), or null
    this.alive = null; // last "has a flower" state reported to the page
  }

  // Run fn with this connection's memory swapped in; route responses to it.
  run(fn) {
    const w = this.world;
    w.load(this.saved);
    w.current = this;
    try { return fn(); } finally {
      w.current = null;
      this.saved = w.save();
      w.load(w.idle);
    }
  }

  // A page->worker message ({funcName, callbackId, data}) from this client.
  post(msg) {
    if (this.closed) return;
    // Each client calls sp_server_init on startup; the world is already initialized.
    if (msg.funcName === 'sp_server_init') {
      this.send({ callbackId: msg.callbackId, finalResponse: true, data: 0 });
      return;
    }
    this.run(() => {
      // The spawn request arrives in a send; while the player has no flower, keep
      // the chosen loadout in its saved progress so the next spawn uses it.
      if (this.loadout && msg.funcName === 'sp_server_send') Loadout.apply(this.world.sp.heap, this.loadout);
      this.world.sp.post(msg);
      if (msg.funcName === 'sp_server_flush') this.alive = reportAlive(this.world.sp.heap, this.alive, this.send);
    });
  }

  setLoadout(lo) { this.loadout = Loadout.normalize(lo); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.send = () => {};
    const w = this.world;
    w.connections.delete(this);
    // Kill the flower, then keep ticking this context briefly (output discarded)
    // so the game finishes the death even if nobody else is connected.
    if (this.run(() => w.killFlower())) w.dying.set(this, DYING_TICKS);
  }
}

class World {
  static async create(opts = {}) {
    const w = new World();
    let thinkMs = 40;
    w.sp = await SpServer.create({
      quiet: opts.quiet,
      wasmBinary: opts.wasmBinary || worldWasm(opts),
      extraImports: opts.extraImports, // instrumented builds, for analysis tools
      onThinkInterval: (ms) => { thinkMs = ms; },
    });
    w.sp.onResponse = (m) => { if (w.current) w.current.send(m); };
    // Initialize once. Init creates a client (slot 0) for the built-in connection;
    // the first connection to arrive uses it.
    w.sp.post({ funcName: 'sp_server_init', callbackId: -1, data: 0 });
    w.template = w.save();
    w.idle = w.template;
    w.spare = w.template; // init's client, until someone takes it
    w.thinkMs = thinkMs;
    w.errors = 0;
    w.timer = setInterval(() => {
      try { w.tick(); } catch (e) {
        if (w.errors++ < 5) console.error('[world] tick error:', e && e.stack || e);
      }
    }, thinkMs);
    return w;
  }

  constructor() {
    this.connections = new Set();
    this.dying = new Map(); // closed Connection -> ticks left
    this.nextId = 1;
    this.current = null;
  }

  get view() { return new DataView(this.sp.asm.o.buffer); }
  save() { const heap = this.sp.heap; return CONN_REGIONS.map(([s, e]) => heap.slice(s, e)); }
  load(saved) { const heap = this.sp.heap; CONN_REGIONS.forEach(([s], i) => heap.set(saved[i], s)); }

  // A fresh engine client bound as slot 0, via the patched add_client export.
  createClient() {
    const v = this.view;
    this.load(this.template);
    this.sp.heap.fill(0, CONN_TOKEN, CONN_TOKEN + 12); // own (empty) token string, not a shared heap buffer
    v.setInt32(CONN_ID, 0, true);
    // Enqueue the connection object exactly like init does.
    const tail = v.getUint32(PENDING.tail, true);
    v.setUint32(CONN_NODE, PENDING.count, true);
    v.setUint32(CONN_NODE + 4, tail, true);
    v.setUint32(CONN_NODE + 8, 0, true);
    v.setUint32(PENDING.count, v.getUint32(PENDING.count, true) + 1, true);
    if (!v.getUint32(PENDING.head, true)) v.setUint32(PENDING.head, CONN_NODE, true);
    if (tail) v.setUint32(tail + 8, CONN_NODE, true);
    v.setUint32(PENDING.tail, CONN_NODE, true);
    this.sp.asm.add_client();
    v.setInt32(CUR_SLOT, 0, true);
    const saved = this.save();
    this.load(this.idle);
    return saved;
  }

  // Kill the current client's flower through the game's own damage path, the way
  // C2S opcode 3 does: damage(health, 0, health.hp, &info) with a zeroed 2-byte
  // info struct. Its petals and the leaderboard entry go away with it.
  // Must run inside a connection's context. Returns false if there's no flower.
  killFlower() {
    const v = this.view;
    let p = v.getUint32(SLOT0_CLIENT, true);
    for (const off of PLAYER_HEALTH_PATH) {
      if (!p) return false;
      p = v.getUint32(p + off, true);
    }
    if (!p) return false;
    if (!this.scratch) this.scratch = this.sp.asm.q(16); // malloc; reused
    v.setUint16(this.scratch, 0, true);
    this.sp.asm.damage(p, 0, v.getFloat32(p + 8, true), this.scratch);
    return true;
  }

  connect(send) {
    let saved;
    if (this.spare) { saved = this.spare; this.spare = null; } else saved = this.createClient();
    new DataView(saved[0].buffer).setUint32(CONN_COUNTER - CONN_REGIONS[0][0], 0, true);
    const c = new Connection(this, this.nextId++, saved, send);
    this.connections.add(c);
    return c;
  }

  tick() {
    const think = this.sp.asm.v;
    for (const c of this.connections) c.run(think);
    for (const [c, left] of this.dying) {
      c.run(() => { think(); this.sp.post({ funcName: 'sp_server_flush', callbackId: -1, data: 0 }); });
      if (left <= 1) this.dying.delete(c); else this.dying.set(c, left - 1);
    }
  }

  destroy() {
    clearInterval(this.timer);
    this.sp.destroy();
  }
}

module.exports = { World, CONN_REGIONS, reportAlive, worldWasm };
