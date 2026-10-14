# Legacy florr.io

A self-hosted multiplayer server for the old florr.io client (`static.florr.io/old/`).

The old build only ran single-player: the game server (`sp_server.wasm`) ran in a Web Worker inside your own browser. This project runs that same, unmodified server code in Node, with a small patch, so several players can share one world over a LAN or the internet.

> Unofficial fan project, not affiliated with M28. See the [note to M28](#note-to-m28).

## Quick start

Requires [Node.js](https://nodejs.org/) (tested on v24). There are no npm dependencies.

```sh
node server/index.js 3001
```

- **You:** open `http://localhost:3001/?mp`
- **Friends on your LAN:** open `http://<your-LAN-IP>:3001/?mp` (find your IP with `ipconfig`)
- **Single-player, offline:** open the same page without `?mp`; it runs its own local world like the original

### Server options

`node server/index.js [port] [options]` starts a room. Options can be combined:

| Option | What it does |
|---|---|
| *(none)* | One shared world for everyone, normal mobs and drops, no spawn menu |
| `--spawn-menu` | Players can pick their spawn level (1-99) and petals on the title screen. The level also sets the spawn zone (Easy / Medium / Hard) |
| `--no-mobs` | No mobs ever spawn |
| `--all-drops` | Every mob drops all of its possible petals (no effect with `--no-mobs`) |
| `--sp` | Each connection gets its own private world |

For example, `node server/index.js 3001 --spawn-menu --no-mobs` is a sandbox room for trying out loadouts.

### Playing over the internet

[Cloudflare quick tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) need no account and no port forwarding:

```sh
cloudflared tunnel --url http://localhost:3001
```

Share the printed `https://<random-name>.trycloudflare.com/?mp` link. The address changes every time the tunnel restarts, and the game runs only while your PC and the tunnel are on.

## How it works

- **Protocol.** Client-to-server messages are XORed with a 256-byte table that is stored in both wasm binaries. Decoded, they are varint-framed messages such as hello, spawn and input. Server-to-client updates use the same table plus another layer that isn't decoded yet. The real client decodes them, so the server doesn't need to.
- **Hosting.** `server/sp-host.js` runs the original `sp_server.js` + `.wasm` in a Node `vm` context. In `?mp` mode, the page swaps its worker for a WebSocket that carries the same `postMessage` calls.
- **Shared world.** The engine supports several clients, but the single-player build only ever creates one, and it only sends updates for "slot 0".
  - `sp_server.mp.wasm` adds an `add_client()` export, copied from the engine's own startup code.
  - Each connection gets its own engine client. Connections take turns being slot 0: their connection state is swapped in around every call.
  - Flowers, petals and mobs live in the one shared world.
- **Disconnects.**
  - Closing the tab removes your flower, through the game's own death logic.
  - A dropped connection only puts you on hold for 45 seconds. The page reconnects by itself and resumes the same flower.
- **Site lock.** `client.wasm` only starts on a few known hostnames. In `?mp` mode the page reports `localhost`, so the game works on any address.

The full research notes are in [`research/NOTES.md`](research/NOTES.md): wire format, memory map, client slots, drop mechanics, and the approaches that didn't work.

## Repository layout

| Path | Contents |
|---|---|
| `florr-local/static.florr.io/old/` | The game: original client and server files, plus the patched `sp_server.mp*.wasm` |
| `server/` | `index.js` (HTTP + WebSocket server), `mp-host.js` (shared world), `sp-host.js` (runs sp_server in Node) |
| `tools/` | `analyze-capture.js` (decode captures), `replay.js` (replay a capture headlessly), `instrument-wat.js` (call tracing), `patch-add-client.js` (builds the patched server) |
| `captures/` | Recorded mouse and keyboard sessions used to decode the input protocol |
| `research/NOTES.md` | Reverse-engineering notes |
| `serve.js`, `har-extract.js` | Original static server and HAR extractor |

### Rebuilding the patched server

The patch tool works on WebAssembly text format, so it needs [wabt](https://github.com/WebAssembly/wabt) (`npm i wabt` anywhere):

```sh
npx wasm2wat --generate-names florr-local/static.florr.io/old/sp_server.wasm -o sp_named.wat
node tools/patch-add-client.js sp_named.wat sp_mp.wat [--all-drops]
npx wat2wasm sp_mp.wat -o florr-local/static.florr.io/old/sp_server.mp.wasm   # or sp_server.mp.alldrops.wasm
```

## Known limitations

- The world pauses while nobody is connected.
- A background tab stops rendering, so its view catches up when you switch back.
- Quick-tunnel URLs change each run. A fixed address needs a named Cloudflare tunnel and a domain.

## Note to M28

This project is not affiliated with, endorsed by, or connected to M28 or florr.io. The game client, game server code, art and other assets in `florr-local/` belong to M28; everything else here is just tooling to host that old build for friends.

- It is non-commercial: no ads, no payments, no public servers.
- It only targets the retired `static.florr.io/old/` build, not the current game, and it doesn't touch M28's servers or accounts.
- If you'd like anything changed or removed, please open an issue on this repository and I'll take it down promptly.

Thank you for making a game my friends and I loved.

## Note

Game assets belong to their original owner, M28. This is purely a fan project. Since this version of the game, florr.io has changed drastically. However, I spent hours on this version of the game with my friends, and it's honestly nostalgic to me. This is solely being built to experience the nostalgia of playing this version with those friends again.
