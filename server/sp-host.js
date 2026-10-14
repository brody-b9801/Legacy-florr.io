// server/sp-host.js
// Runs the unmodified sp_server.js + sp_server.wasm (normally a browser Web Worker)
// inside a Node vm context, so the game server can be hosted outside the browser.
//
//   const { SpServer } = require('./sp-host');
//   const sp = await SpServer.create();
//   sp.onResponse = (msg) => { /* {callbackId, finalResponse, data} */ };
//   sp.post({ funcName: 'sp_server_init', callbackId: 0, data: 0 });
//
// post()/onResponse carry exactly the objects the page and worker exchange via
// postMessage, so they can be tunnelled over a socket unchanged.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OLD = path.join(__dirname, '..', 'florr-local', 'static.florr.io', 'old');
const GLUE = fs.readFileSync(path.join(OLD, 'sp_server.js'), 'utf8');
const WASM = fs.readFileSync(path.join(OLD, 'sp_server.wasm'));

class SpServer {
  static create(opts = {}) {
    return new Promise((resolve) => {
      const sp = new SpServer(opts, () => resolve(sp));
    });
  }

  constructor(opts, onReady) {
    this.onResponse = null;
    const timers = new Set();
    this._timers = timers;
    const ctx = {
      console: opts.quiet ? { log() {}, warn() {}, error: console.error } : console,
      performance, crypto: globalThis.crypto, Date, Math, URL, TextDecoder, TextEncoder,
      WebAssembly, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
      Float32Array, Float64Array, ArrayBuffer, DataView, BigInt, Promise,
      setTimeout: (fn, ms, ...a) => { const t = setTimeout(() => { timers.delete(t); fn(...a); }, ms); timers.add(t); return t; },
      clearTimeout: (t) => { timers.delete(t); clearTimeout(t); },
      setInterval: (fn, ms, ...a) => {
        // The wasm schedules sp_server_think via setInterval; a host that drives
        // ticks itself (mp-host.js) takes it over through opts.onThinkInterval.
        const M = ctx.Module;
        if (opts.onThinkInterval && (fn === M._sp_server_think || (M.asm && fn === M.asm.v))) { opts.onThinkInterval(ms); return 0; }
        const t = setInterval(fn, ms, ...a); timers.add(t); return t;
      },
      clearInterval: (t) => { timers.delete(t); clearInterval(t); },
      location: { href: 'http://localhost/sp_server.js' },
      Module: {
        wasmBinary: opts.wasmBinary || WASM,
        onRuntimeInitialized: () => setImmediate(onReady),
      },
      postMessage: (msg) => { if (this.onResponse) this.onResponse(msg); },
    };
    // opts.extraImports (e.g. { t: { trace } } for an instrumented binary) are merged
    // into the import object the glue passes to WebAssembly.instantiate.
    if (opts.extraImports) {
      ctx.WebAssembly = Object.assign(Object.create(WebAssembly), {
        instantiate: (bin, imports) => WebAssembly.instantiate(bin, { ...imports, ...opts.extraImports }),
        instantiateStreaming: undefined,
      });
    }
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(GLUE, ctx, { filename: 'sp_server.js' });
    this.ctx = ctx;
  }

  // Deliver a page->worker message ({funcName, callbackId, data}).
  post(msg) {
    this.ctx.onmessage({ data: msg });
  }

  // Raw wasm exports / memory, for analysis tools.
  get asm() { return this.ctx.Module.asm; }
  get heap() { return new Uint8Array(this.asm.o.buffer); }

  destroy() {
    for (const t of this._timers) { clearTimeout(t); clearInterval(t); }
    this._timers.clear();
    this.onResponse = null;
  }
}

module.exports = { SpServer };
