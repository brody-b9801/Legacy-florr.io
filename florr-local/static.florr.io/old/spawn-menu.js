// spawn-menu.js: spawn level / petal menu on the title screen.
//
// The choice is sent to whichever sp_server is running: over the ?mp tunnel
// (func 5, see server/index.js) or to the offline worker, which this file swaps
// for sp_worker.js. The server writes it into the player's saved progress before
// the next spawn; the game then levels the flower up to that level and picks the
// spawn zone from it (loadout.js). With "Custom spawn" off nothing is sent and
// the game's normal progression applies.
(function () {
  var L = window.florrLoadout;
  var STORE = 'florr_spawn_loadout';
  var mp = new URL(window.location).searchParams.get('mp') !== null;

  // Petal ids 1..38 as in sp_server's petal table (name, rarity, short note).
  var RARITIES = ['Common', 'Unusual', 'Rare', 'Epic', 'Legendary', 'Unique'];
  // petals.png: the game's own petal cards, captured from its inventory bar.
  // 70 px cards, 8 per row, id 1 at the top left.
  var SHEET = 'petals.png', CARD = 70, COLS = 8, ROWS = 5;
  var SLOT = 38, SLOT2 = 34, PICK = 38; // card sizes in the menu: petal slots, secondary slots, picker (8 per row)
  var PETALS = [null,
    ['Basic', 0, 'A nice petal, not too strong but not too weak'],
    ['Fast', 0, 'Weaker than most petals, but recharges very quickly'],
    ['Heavy', 0, 'Very resilient and deals more damage, but recharges very slowly'],
    ['Rock', 2, 'Extremely durable, but takes a long time to recharge'],
    ['Square', 5, 'This shape... it looks familiar...'],
    ['Rose', 1, 'Its healing properties are amazing'],
    ['Stinger', 1, "It really hurts, but it's very fragile"],
    ['Iris', 1, 'Very poisonous, but takes a little while to do its work'],
    ['Wing', 2, 'It comes and goes'],
    ['Missile', 2, 'You can actually shoot this one'],
    ['Peas', 2, '4 in 1 deal'],
    ['Peas', 3, '4 in 1 deal, now with poison'],
    ['Cactus', 2, 'Somehow increases your maximum health'],
    ['Faster', 2, 'Makes your other petals spin faster'],
    ['Rose', 3, 'Extremely powerful rose'],
    ['Twin', 1, 'Why stop at one? Why not TWO?!'],
    ['Triplet', 3, 'How about THREE?!'],
    ['Bubble', 2, 'Right click to pop it and propel your flower'],
    ['Pollen', 3, 'Asthmatics beware'],
    ['Dandelion', 2, 'Prevents healing on affected units'],
    ['Cactus', 3, 'More max health, and your flower poisons what it hits'],
    ['Egg', 3, 'Something interesting might pop out of this'],
    ['Egg', 4, 'Something interesting might pop out of this'],
    ['Rose ×3', 2, 'Three healing roses'],
    ['Antennae', 4, 'Lets your flower sense foes farther away'],
    ['Heaviest', 3, 'So heavy that nothing gets in the way'],
    ['Stinger ×3', 4, 'Three stingers'],
    ['Yin Yang', 3, 'Reverses the rotation direction of your petals'],
    ['Web', 2, "It's really sticky"],
    ['Web ×3', 4, 'Three webs'],
    ['Honey', 2, 'Slows down whatever it hits'],
    ['Leaf', 1, 'Heals your flower passively'],
    ['Cactus ×3', 4, 'Three cacti'],
    ['Peas', 4, '4 in 1 deal, with poison'],
    ['Basic', 5, 'Something incredibly rare and useless'],
    ['Salt', 2, 'Reflects some damage back to the flower that dealt it'],
    ['Rice', 3, 'Spawns instantly, but not very strong'],
    ['Corn', 3, 'Takes a long time to spawn, but has a lot of health'],
  ];
  // The in-game map labels the west 30% Easy, the next 30% Medium, the rest Hard.
  var ZONE_NAMES = ['Easy', 'Medium', 'Hard', 'Hard (east end)'];

  // ---- state ----------------------------------------------------------------

  var state = { enabled: false, level: 1, primary: [], secondary: [] };
  try { var saved = JSON.parse(localStorage.getItem(STORE)); if (saved) state = Object.assign(state, saved); } catch (e) {}
  var sel = { row: 'primary', i: 0 }; // slot that the next palette click fills

  function loadout() {
    return L.normalize({ level: state.level, primary: state.primary, secondary: state.secondary });
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {} }

  // ---- delivery to the sp_server worker / tunnel ------------------------------

  var worker = null;
  function push() {
    if (!worker) return;
    var lo = state.enabled ? loadout() : null;
    if (worker.sendLoadout) worker.sendLoadout(JSON.stringify(lo)); // ?mp tunnel (index.html)
    else worker.postMessage({ funcName: 'florr_loadout', callbackId: -1, loadout: lo }); // sp_worker.js
  }
  var Prev = window.Worker;
  window.Worker = function (url, opts) {
    var sp = String(url).indexOf('sp_server') >= 0;
    if (sp && !mp) url = String(url).replace('sp_server.js', 'sp_worker.js');
    var w = new Prev(url, opts);
    if (sp) {
      worker = w;
      // sp_worker.js reports {florrAlive}; keep it from the game (this listener
      // is added before the game sets onmessage, so it runs first).
      if (!mp) w.addEventListener('message', function (e) {
        if (e.data && e.data.florrAlive !== undefined) { e.stopImmediatePropagation(); setAlive(e.data.florrAlive); }
      });
      push();
    }
    return w;
  };
  window.Worker.prototype = Prev.prototype;

  // ---- UI -----------------------------------------------------------------------

  var css = '' +
    '#spawnMenu{position:fixed;left:16px;top:50%;transform:translateY(-50%);z-index:50;width:366px;max-height:calc(100% - 32px);overflow:auto;' +
    'box-sizing:border-box;padding:12px 14px;border-radius:10px;background:rgba(0,0,0,.45);border:3px solid rgba(0,0,0,.35);' +
    'font:700 13px Ubuntu,sans-serif;color:#fff;text-shadow:0 0 2px #000,0 0 2px #000;user-select:none;display:none}' +
    '#spawnMenu h3{margin:0 0 8px;font-size:17px;display:flex;justify-content:space-between;align-items:center}' +
    '#spawnMenu label.sm-toggle{display:flex;gap:6px;align-items:center;font-size:13px;cursor:pointer}' +
    '#spawnMenu .sm-body{transition:opacity .15s}#spawnMenu .sm-body.off{opacity:.4;pointer-events:none}' +
    '#spawnMenu .sm-level{display:flex;gap:8px;align-items:center;margin:4px 0}' +
    '#spawnMenu input[type=range]{flex:1;accent-color:#7eef6d}' +
    '#spawnMenu input[type=number]{width:46px;font:inherit;text-align:center;border-radius:4px;border:2px solid rgba(0,0,0,.4);padding:2px}' +
    '#spawnMenu .sm-zone{font-size:12px;opacity:.85;margin-bottom:8px}' +
    '#spawnMenu .sm-sub{font-size:12px;margin:6px 0 4px;opacity:.9}' +
    '#spawnMenu .sm-row{display:flex;flex-wrap:wrap;gap:4px}' +
    '#spawnMenu .sm-slot,#spawnMenu .sm-petal{width:' + SLOT + 'px;height:' + SLOT + 'px;border-radius:3px;cursor:pointer;background-repeat:no-repeat}' +
    '#spawnMenu .sm-slot{background-color:rgba(255,255,255,.12)}#spawnMenu .sm-slot.sel{outline:2px solid #fff;outline-offset:1px}' +
    '#spawnMenu .sm-row.primary .sm-slot.empty{opacity:.4}' +
    '#spawnMenu .sm-row.secondary .sm-slot{width:' + SLOT2 + 'px;height:' + SLOT2 + 'px}' +
    '#spawnMenu .sm-palette{display:grid;grid-template-columns:repeat(8,' + PICK + 'px);gap:4px;margin-top:4px}' +
    '#spawnMenu .sm-petal{width:' + PICK + 'px;height:' + PICK + 'px}#spawnMenu .sm-petal:hover,#spawnMenu .sm-slot:hover{filter:brightness(1.15)}' +
    '#spawnMenu .sm-btns{display:flex;gap:6px;margin-top:8px}' +
    '#spawnMenu button{flex:1;font:inherit;font-size:12px;color:#fff;text-shadow:inherit;background:rgba(255,255,255,.15);border:2px solid rgba(0,0,0,.35);border-radius:5px;padding:4px;cursor:pointer}' +
    '#spawnMenu button:hover{background:rgba(255,255,255,.25)}' +
    '#spawnMenu .sm-hint{font-size:11px;opacity:.7;margin-top:6px}' +
    '#spawnMenu .sm-collapse{cursor:pointer;font-size:14px;padding:0 4px}' +
    '#spawnMenu.collapsed .sm-content{display:none}#spawnMenu.collapsed h3{margin:0}';

  var root = null, body, levelRange, levelNum, zoneEl, primaryRow, secondaryRow, enabledBox;

  // Show petal id's card from the sprite sheet, scaled to the element's size (px).
  function petalStyle(el, id, size) {
    var p = PETALS[id];
    if (!p) { el.style.backgroundImage = ''; el.title = 'Empty'; return; }
    var k = size / CARD, i = id - 1;
    el.style.backgroundImage = 'url(' + SHEET + ')';
    el.style.backgroundSize = (COLS * size) + 'px ' + (ROWS * size) + 'px';
    el.style.backgroundPosition = -(i % COLS) * CARD * k + 'px ' + -Math.floor(i / COLS) * CARD * k + 'px';
    el.title = p[0] + ' (' + RARITIES[p[1]] + ')\n' + p[2];
  }

  function renderSlots() {
    var lo = loadout();
    state.primary = lo.primary; state.secondary = lo.secondary;
    [['primary', primaryRow], ['secondary', secondaryRow]].forEach(function (pair) {
      var row = pair[0], el = pair[1], ids = state[row];
      el.innerHTML = '';
      ids.forEach(function (id, i) {
        var s = document.createElement('div');
        s.className = 'sm-slot' + (sel.row === row && sel.i === i ? ' sel' : '') + (id ? '' : ' empty');
        petalStyle(s, id || (row === 'primary' ? 1 : 0), row === 'primary' ? SLOT : SLOT2);
        if (!id && row === 'primary') s.title = 'Empty: spawns as Basic';
        s.onclick = function () { sel = { row: row, i: i }; renderSlots(); };
        s.oncontextmenu = function (e) { e.preventDefault(); state[row][i] = 0; changed(); };
        el.appendChild(s);
      });
    });
    if (sel.i >= state[sel.row].length) sel = { row: 'primary', i: 0 };
  }

  function renderLevel() {
    levelRange.value = levelNum.value = state.level;
    var z = L.zoneOf(state.level), zones = L.ZONES;
    var from = z ? zones[z - 1].maxLevel + 1 : 1, to = zones[z].maxLevel === Infinity ? L.MAX_LEVEL : zones[z].maxLevel;
    zoneEl.textContent = 'Spawns in ' + ZONE_NAMES[z] + ' · levels ' + from + '–' + to + ' · ' + L.slotCount(state.level) + ' petal slots';
  }

  function changed() { save(); renderLevel(); renderSlots(); push(); }

  function pick(id) {
    state[sel.row][sel.i] = id;
    // advance to the next slot, wrapping from primary into secondary
    var n = state[sel.row].length;
    if (sel.i + 1 < n) sel.i++;
    else if (sel.row === 'primary') sel = { row: 'secondary', i: 0 };
    changed();
  }

  function build() {
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    root = document.createElement('div'); root.id = 'spawnMenu';
    root.innerHTML =
      '<h3><label class="sm-toggle"><input type="checkbox" class="sm-on"> Custom spawn</label><span class="sm-collapse" title="Hide / show">▾</span></h3>' +
      '<div class="sm-content"><div class="sm-body">' +
      '<div class="sm-level">Level <input type="range" min="1" max="' + L.MAX_LEVEL + '"><input type="number" min="1" max="' + L.MAX_LEVEL + '"></div>' +
      '<div class="sm-zone"></div>' +
      '<div class="sm-sub">Petals</div><div class="sm-row primary"></div>' +
      '<div class="sm-sub">Secondary</div><div class="sm-row secondary"></div>' +
      '<div class="sm-sub">Pick a slot, then a petal · right-click a slot to empty it</div><div class="sm-palette"></div>' +
      '<div class="sm-btns"><button class="sm-clear">Clear petals</button><button class="sm-basic">Reset all</button></div>' +
      '</div><div class="sm-hint">Off: normal progression. Applies the next time you spawn.</div></div>';
    document.body.appendChild(root);
    var q = function (s) { return root.querySelector(s); };
    body = q('.sm-body'); levelRange = q('input[type=range]'); levelNum = q('input[type=number]');
    zoneEl = q('.sm-zone'); primaryRow = q('.sm-row.primary'); secondaryRow = q('.sm-row.secondary'); enabledBox = q('.sm-on');

    // Keep keys and clicks away from the game while using the menu.
    ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'wheel', 'touchstart', 'touchend'].forEach(function (t) {
      root.addEventListener(t, function (e) { e.stopPropagation(); });
    });
    root.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    enabledBox.checked = !!state.enabled;
    body.classList.toggle('off', !state.enabled);
    enabledBox.onchange = function () { state.enabled = enabledBox.checked; body.classList.toggle('off', !state.enabled); changed(); };
    var setLevel = function (v) { state.level = Math.max(1, Math.min(L.MAX_LEVEL, Math.floor(+v) || 1)); changed(); };
    levelRange.oninput = function () { setLevel(levelRange.value); };
    levelNum.onchange = function () { setLevel(levelNum.value); };
    q('.sm-clear').onclick = function () { state.primary = []; state.secondary = []; sel = { row: 'primary', i: 0 }; changed(); };
    q('.sm-basic').onclick = function () { state.level = 1; state.primary = []; state.secondary = []; sel = { row: 'primary', i: 0 }; changed(); };
    q('.sm-collapse').onclick = function () { root.classList.toggle('collapsed'); this.textContent = root.classList.contains('collapsed') ? '▸' : '▾'; };

    var pal = q('.sm-palette');
    var ids = []; for (var id = 1; id < PETALS.length; id++) ids.push(id);
    ids.sort(function (a, b) { return PETALS[a][1] - PETALS[b][1] || a - b; });
    ids.forEach(function (id) {
      var el = document.createElement('div'); el.className = 'sm-petal';
      petalStyle(el, id, PICK);
      el.onclick = function () { pick(id); };
      pal.appendChild(el);
    });
    renderLevel(); renderSlots();
  }

  // Show the menu only on the title screen, i.e. while the player has no flower
  // (reported by the server over the tunnel, or by sp_worker.js).
  var alive = false;
  function setAlive(a) { alive = !!a; if (root) root.style.display = alive ? 'none' : 'block'; }
  window.addEventListener('florr-alive', function (e) { setAlive(e.detail); });

  function start() { build(); setAlive(alive); }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
