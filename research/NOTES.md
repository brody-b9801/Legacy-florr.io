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

### Handshake
The first send after `sp_server_init` is 122 bytes; not yet decoded.

## S2C — NOT YET SOLVED
Byte 0 is always `0x01`. The rest is not the C2S table (the nickname doesn't
appear after de-XOR with it). Possibly a second table, a stream cipher, or compression.
Only needed for the fallback path (our own server, plan stage 4b).
