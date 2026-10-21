// loadout.js: custom spawn level and petals (the title screen's spawn menu).
// Used by server/mp-host.js (Node), sp_worker.js (offline worker) and index.html.
//
// The engine keeps a player's progress on its client object and reads it only
// when the player spawns (C2S spawn handler in sp_server's send):
//   client+8   u8  level: the flower gets XP up to this level, and the spawn zone
//                  comes from it (x within the map: <=12 first 30%, <=27 30-60%,
//                  <=42 60-90%, else the last 10%)
//   client+28  u8[16] petal ids: primary slots first, then secondary; missing
//                  primary slots are filled with Basic (id 1)
//   client+96  u8  number of petal ids at client+28
// client = *(*(24936) + 120); client+100 is the flower entity (0 while dead).
// See research/NOTES.md ("Spawn level and loadout").
(function (root) {
  var CLIENT_PTR = 24936, CLIENT_OFF = 120, FLOWER = 100;
  var LEVEL = 8, PETALS = 28, COUNT = 96;
  var MAX_LEVEL = 99, MAX_PETALS = 16, PETAL_IDS = 38, SECONDARY = 8;

  // Primary petal slots at a level (secondary slots are always 8, for 13..16 in all).
  function slotCount(level) { return level < 15 ? 5 : level < 30 ? 6 : level < 45 ? 7 : 8; }

  // Spawn zones by level, as in the spawn handler; x as a fraction of map width.
  var ZONES = [
    { maxLevel: 12, from: 0, to: 0.3 },
    { maxLevel: 27, from: 0.3, to: 0.6 },
    { maxLevel: 42, from: 0.6, to: 0.9 },
    { maxLevel: Infinity, from: 0.9, to: 1 },
  ];
  function zoneOf(level) { for (var i = 0; i < ZONES.length; i++) if (level <= ZONES[i].maxLevel) return i; return ZONES.length - 1; }

  // {level, primary: [ids], secondary: [ids]} (0 = empty) -> normalized form, or null.
  function normalize(lo) {
    if (!lo || typeof lo !== 'object') return null;
    var level = Math.max(1, Math.min(MAX_LEVEL, Math.floor(+lo.level) || 1));
    var id = function (x) { x = Math.floor(+x) || 0; return x >= 1 && x <= PETAL_IDS ? x : 0; };
    var k = slotCount(level);
    var primary = [], secondary = [];
    for (var i = 0; i < k; i++) primary.push(id((lo.primary || [])[i]));
    for (i = 0; i < SECONDARY; i++) secondary.push(id((lo.secondary || [])[i]));
    return { level: level, primary: primary, secondary: secondary };
  }

  // Petal bytes for client+28: empty primary slots become Basic (like the
  // engine's own fill), trailing empty secondary slots are dropped.
  function petalBytes(lo) {
    var out = lo.primary.map(function (p) { return p || 1; });
    var sec = lo.secondary.slice();
    while (sec.length && !sec[sec.length - 1]) sec.pop();
    return out.concat(sec);
  }

  // Write the loadout into the current (slot 0) client if it has no flower, so
  // a spawn request handled right after uses it. heap: Uint8Array over wasm
  // memory. Returns what restore() needs to undo the write, or null.
  function apply(heap, lo) {
    if (!lo) return null;
    var v = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
    var p = v.getUint32(CLIENT_PTR, true);
    if (!p) return null;
    var client = v.getUint32(p + CLIENT_OFF, true);
    if (!client || v.getUint32(client + FLOWER, true)) return null;
    var undo = { client: client, before: heap.slice(client, client + COUNT + 1) };
    var bytes = petalBytes(lo);
    heap[client + LEVEL] = lo.level;
    heap.fill(0, client + PETALS, client + PETALS + MAX_PETALS);
    heap.set(bytes, client + PETALS);
    heap[client + COUNT] = bytes.length;
    undo.written = heap.slice(client, client + COUNT + 1);
    return undo;
  }

  // Put back every byte apply() changed that the game hasn't changed since.
  // The game tells the client about changes to these fields with per-field
  // change stamps (client+40 and up, which more than 12 petal ids overlap);
  // apply() writes around that, so leaving its values in place would let the
  // client's copy drift (it ends up drawing petal id 0 on the title screen
  // after the next death, which crashes it).
  function restore(heap, undo) {
    if (!undo) return;
    for (var i = 0; i < undo.written.length; i++) {
      var a = undo.client + i;
      if (undo.written[i] !== undo.before[i] && heap[a] === undo.written[i]) heap[a] = undo.before[i];
    }
  }

  // Run fn (one sp_server_send call) with the loadout in place, so a spawn
  // request in it uses the loadout, then undo the write. getHeap returns a
  // current Uint8Array over wasm memory (memory can grow during fn).
  function during(getHeap, lo, fn) {
    var undo = apply(getHeap(), lo);
    try { return fn(); } finally { restore(getHeap(), undo); }
  }

  // Whether the current (slot 0) client has a flower. The page shows the spawn
  // menu while it doesn't (title screen), so hosts report changes of this.
  function hasFlower(heap) {
    var v = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
    var p = v.getUint32(CLIENT_PTR, true);
    var client = p && v.getUint32(p + CLIENT_OFF, true);
    return !!(client && v.getUint32(client + FLOWER, true));
  }

  var api = { normalize: normalize, apply: apply, restore: restore, during: during, hasFlower: hasFlower, slotCount: slotCount, zoneOf: zoneOf, ZONES: ZONES, MAX_LEVEL: MAX_LEVEL, SECONDARY: SECONDARY };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.florrLoadout = api;
})(typeof self !== 'undefined' ? self : this);
