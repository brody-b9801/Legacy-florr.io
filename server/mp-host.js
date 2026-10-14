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

const fs = require('fs');
const path = require('path');
const { SpServer } = require('./sp-host');

const MP_WASM = path.join(__dirname, '..', 'florr-local', 'static.florr.io', 'old', 'sp_server.mp.wasm');

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
const PENDING = { count: 25112, head: 25116, tail: 25120 };

class Connection {
  constructor(world, id, saved, send) {
    this.world = world;
    this.id = id;
    this.saved = saved;
    this.send = send; // (msg) => void, msg = {callbackId, finalResponse, data}
    this.closed = false;
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
    this.run(() => this.world.sp.post(msg));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.world.connections.delete(this);
    // TODO: despawn this connection's flower (it stays in the world for now).
  }
}

class World {
  static async create(opts = {}) {
    const w = new World();
    let thinkMs = 40;
    w.sp = await SpServer.create({
      quiet: opts.quiet,
      wasmBinary: opts.wasmBinary || fs.readFileSync(MP_WASM),
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
  }

  destroy() {
    clearInterval(this.timer);
    this.sp.destroy();
  }
}

module.exports = { World, CONN_REGIONS };
