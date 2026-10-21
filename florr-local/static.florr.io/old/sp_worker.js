// sp_worker.js: the offline sp_server worker plus the title screen's spawn menu.
// index.html (spawn-menu.js) starts this instead of sp_server.js when not in ?mp
// mode. It runs the original glue unchanged and handles one extra message,
// {funcName: 'florr_loadout', loadout}, the same way server/mp-host.js handles
// tunnel func 5: before each send, a player without a flower gets the chosen
// level and petals in its saved progress (see loadout.js). It also posts
// {florrAlive} when the player gains or loses its flower.
var Module = {}; // sp_server.js uses an existing global Module, so asm is reachable here
importScripts('loadout.js', 'sp_server.js');

(function () {
  var handle = self.onmessage;
  var loadout = null;
  var alive = null;
  self.onmessage = function (e) {
    var d = e.data;
    if (d && d.funcName === 'florr_loadout') { loadout = florrLoadout.normalize(d.loadout); return; }
    var that = this;
    if (loadout && d && d.funcName === 'sp_server_send' && Module.asm) {
      return florrLoadout.during(function () { return new Uint8Array(Module.asm.o.buffer); }, loadout, function () { return handle.call(that, e); });
    }
    // Tell the page whether the player has a flower (it shows the menu while not).
    if (d && d.funcName === 'sp_server_flush' && Module.asm) {
      var now = florrLoadout.hasFlower(new Uint8Array(Module.asm.o.buffer));
      if (now !== alive) { alive = now; postMessage({ florrAlive: now }); }
    }
    return handle.call(this, e);
  };
})();
