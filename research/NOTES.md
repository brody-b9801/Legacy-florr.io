# florr.io (old) protocol notes

Captures: `captures/mouse-session.json`, `captures/kbd-session.json` (written by the
`index.html` harness via `__proto.save`). Decoder: `node tools/analyze-capture.js <capture>`.

## Transport (worker)
Page → worker: `{funcName, callbackId, data}` where funcName is one of
`sp_server_init`, `sp_server_send` (C2S bytes), `sp_server_flush`, `sp_server_think`.
Worker → page: `{callbackId, finalResponse, data}` (S2C bytes).

## C2S obfuscation — SOLVED
Each `sp_server_send` buffer is XORed with a fixed 256-byte table, indexed by byte
position within the buffer (`buf[i] ^ KEY[i & 0xff]`). The table is a literal in the
data section of both binaries and is identical across page loads:

- `sp_server.wasm` file offset 463085
- `client.wasm` file offset 1762197
- starts `37 0d 2d 2e f7 65 f4 13 c5 ce b2 96 7b d8 72 42 94 36 95 99 bf 3b ac 3d ...`

Found by recovering key bytes from known plaintexts (angle 0 / magnitude 0 in keyboard
input, the nickname in the spawn packet), then searching the binaries for that run.

## C2S message layout (after de-XOR)
A send buffer holds one or more messages back to back:

| field   | type   | notes |
|---------|--------|-------|
| counter | varint (LEB128) | +1 per message; 1 byte until 127, then 2 |
| opcode  | u8     | see below |
| payload | ...    | |

The client often resends its previous message at the head of the next buffer
(mouse session: 303 of 816 messages were repeats), so the server must ignore
counters it has already seen.

### 0x0c input — 11 bytes total with a 1-byte counter, 12 with a 2-byte counter
| field | type | notes |
|-------|------|-------|
| flags | u8   | bit0 = attack, bit1 = defend |
| angle | f32 LE | movement direction, radians, screen space (+y is down) |
| mag   | f32 LE | movement strength |

Both input schemes produce the **same message**; they differ only in values and cadence:

| | keyboard (`florrio_keyboard_control=Y`) | mouse (default) |
|---|---|---|
| angle | 8 directions only (0, ±45°, ±90°, ±135°, 180°); WASD and arrows identical | atan2 of cursor offset from canvas centre |
| mag | 1000 while a direction is held, 0 on release (angle is kept) | cursor distance from centre, ≈1.35× CSS px (seen 38–552) |
| opposing keys (W+S) | no message sent | n/a |
| attack / defend | Space / Shift set flag bit 0 / bit 1 | LMB / RMB set flag bit 0 / bit 1 |
| cadence | one message per change (key down / key up) | continuous, about every 33 ms |

Open: in the mouse session some labels produced only 1–4 messages over 1.2 s (e.g.
"N far", RMB hold) while others produced ~60. The cause of the variable cadence is
not yet known; it doesn't affect the format.

### 0x04 spawn
`u8 ?, u8 ?` (seen `03 06`), then a NUL-terminated UTF-8 nickname.

### 0x00 hello (handshake)
First send after `sp_server_init`, counter 1: `u8 01`, then three NUL-terminated
strings: browser user agent, an empty string (token?), language (`en-US`).

## Worker call pattern
- `sp_server_init` once (callback gets a final empty response).
- `sp_server_send` carries C2S buffers (fire and forget).
- `sp_server_flush` is called every client frame (~60/s) with a fresh callbackId; the
  server answers that callback (non-final) only when a world update is ready (~30/s).
  So the transport is a pull model, which tunnels easily.

## sp_server.wasm internals (Stage 2, in progress)
Tooling: `npx wabt` (wasm2wat / wasm-decompile). Export map:
`u`=init (func 656), `w`=send (655), `t`=flush (657), `v`=think (654),
`x`=cp6_timeout_fire (659), `y`=cp6_check_ws (660), `o`=memory, `p`=malloc?, `r`=free.

- `send` XORs the buffer in place with the table at **memory address 4576**
  (`buf[i] ^= mem[4576 + (i & 255)]`), then parses varint counter + opcode.
- The last-seen counter is stored at **fixed address 418968** (`if ctr <= last: drop`).
  Connection state lives at static addresses (418936..418968, 8545488 flags), so the
  build assumes exactly one connection.
- The player is reached through a global pointer at **24936** → heap object
  (`[0]=0x5990`, vtable-like) → `[30]` → `[25]` → `[41]`.
- `25092` heads a linked list of ≥50 nodes at 0x1f0 stride: a preallocated entity pool,
  not a client list.
- `init` mostly zeroes large static ranges (22928..24800+), which also suggests static,
  single-client state.

## Headless hosting (works)
`server/sp-host.js` runs the unmodified glue + wasm in a Node `vm` context.
`node tools/replay.js scratchpad_capture1.json --seconds 20` replays a browser session:
the headless server produced a comparable response stream (327 vs 397 non-empty
responses, 60 KB vs 72 KB; the difference is expected from RNG and timing).

## S2C — partly solved
`think` builds one update per tick, then XORs it with the **same table**, shifted by one:
`buf[1 + i] ^= mem[4576 + (i & 255)]`; byte 0 (`0x01`) is left clear. It queues the
packet at `8545516[count++]` (u8 count at 8545512, max 16; think does nothing while
more than 16 are queued). After de-XOR the body still isn't readable (no nickname), so
there is probably another layer such as compression. Not needed while the
real client does the decoding.

## Multi-client support inside the engine
- **Connections become clients.** Init builds the static connection object
  "local" (418876..419240) and pushes its node (419000 = object + 120) onto a
  pending-connection queue (count 25112, head 25116, tail 25120; node =
  {owner, prev, next}). A block at the end of init's run-once section pops it and
  turns it into an engine client: it zeroes 136 bytes at node-120, keeps the
  object's first word (418880) as the client **slot**, writes a 5-char name and a
  36-char token, and creates the heap-side client/player objects.
- **Slots.** `mem[8545488]` is the current slot. Per-slot data: client pointer
  struct at `24936 + 12*slot`, bytes at `24476+slot`, `24837+slot`, `25066+slot`.
  These arrays only hold 2 slots in this build (slot 2 runs into other globals).
  The transport only serializes updates for slot 0: for any other slot it
  selects a dummy object at address 4.
- `tools/patch-add-client.js` copies that init block into a new export
  `add_client()` → **sp_server.mp.wasm** (the original wasm is kept). The block
  depends only on $p0 (= 0) and init's 208-byte stack frame, and never branches out.

## Multiplayer (server/mp-host.js), working
Every connection gets its **own engine client, bound as slot 0**, and connections
take turns being slot 0. Each connection's saved context contains:
- the connection object 418876..419240 (C2S counter at 418968, 4 KB send buffer ptr),
- the current slot 8545488 (always 0) and the outgoing queue 8545512..8545580,
- the slot-0 globals: 24936..24947, 24476, 24837, 25066.

A new connection loads the post-init template, empties the token string (so it
doesn't share a heap buffer), sets slot 0, enqueues node 419000 like init does,
and calls `add_client()`. The first connection takes init's own client.
Ticks: one `think` per connection per interval. The first advances the world by
real dt (timestamps 8545496/8545504 are shared), the rest have dt ~ 0 and
serialize their own view. With nobody connected the world pauses.

What didn't work, and why:
- Cloning the connection without a new engine client: everyone controlled and saw
  the first player.
- Real slot 1 via `add_client(slot=1)`: both clients pointed at the same static
  connection object, which world code walks for all clients. Swapping its contents
  corrupted shared containers (garbage pointers in think/spawn). Slot 1 also never
  gets updates from the transport.
- A tick with no current client (slot -1) faults once a second client exists.

Verified 2026-10-14:
- Headless: 1-4 players, 3 runs each, no faults; every player's name is in memory,
  and each player receives a distinct update stream.
- Browser: two tabs, one on keyboard control and one on mouse, showed "2 Flowers" on
  the leaderboard, each with its own level-1 flower and its own view; the server
  logged no errors.

Open issues:
- Disconnecting doesn't remove that player's flower.
- A background tab stops polling, so its queue fills and its view pauses; it
  resumes when the tab is visible again.
- Not yet shown: two players on screen at once (needs two visible windows).

## Disconnects and reconnects (server/index.js + index.html shim)
- A close frame (tab closed or reloaded) means the player left: the flower is
  killed at once (`damage` export), and the closed context keeps ticking ~3 s
  so the death completes.
- A dropped link (TCP end or error, or 30 s with no frames) **suspends** the
  player: the flower stays and its updates stay queued (max 16; think pauses that
  context when full). The page shim reconnects with `/ws?session=<token>` (token
  sent as callbackId -2) and resumes the same player; because the client pulls
  updates with flush, little is lost in the gap. With no resume within 45 s the
  flower is killed, and later resumes get close code 4000, which makes the page
  reload.
- The page sends a keepalive (func 4) every 5 s, so background tabs and proxies
  that swallow pings don't trigger timeouts.
- Earlier bug (2026-10-14): any drop killed the player at once and the page had
  no reconnect, so others saw that player freeze and then die.

## Mob drops
- **Drops are rolled when a mob spawns**, in `$f144` (dcmp `f_oe`). The mob's
  definition holds a u8 count at +32 and 8-byte entries from +36 (u8 petal id,
  f32 chance at +4). For each entry, `random() < t * chance` appends the petal to
  the mob's drop list. `t` is 3.0 when world byte [873] == 1 (a built-in 3x mode),
  otherwise 1.0. A mob carries at most 6 drops.
- RNG: `std::minstd_rand` (48271, Schrage 44488/3399), state at 8573024
  (8573028 is used for shuffles); `random() = (x - 1) * 2^-31`.
- Mob definitions: a static table at 8548484..8550920, 116 bytes each. No mob
  has more than 6 possible drops, so the cap never truncates.
- Drop list (`entity[51]`, byte offset 204): 16-byte pooled object {entity*, f32,
  u8 count at +8, petal ids at +9..+15 (room for 7)}.
- **On death** (`f_ra`/`$f43` → `B_ua`), every listed petal is spawned. Exception:
  a rarity-5 petal is skipped if another player already has it equipped, or if
  the same petal is already lying on the ground.
- The petal table is at 8545792, 52 bytes per petal id 1..38; field [6] is rarity.
- `f_ra` also runs the player death penalty: it shuffles the inventory by rarity
  with 10% and 1% rolls (not fully decoded).
- `tools/patch-add-client.js --all-drops` replaces the spawn roll with "always
  true" → `sp_server.mp.alldrops.wasm`; `node server/index.js --all-drops` uses it.
  Measured: 0.35 → 5.3 drops carried per mob (every mob carries all its possible drops).

## Stage 3 (works)
`node server/index.js 3001 --sp` gives each WebSocket connection a private world.
Opening `http://localhost:3001/?mp` (tunnel shim in index.html) spawned and played
normally with the server running in Node.
