// serve.js — zero-dependency static server for the local/LAN florr.io build.
//
//   node serve.js [port]
//
// Serves florr-local/static.florr.io/old/ (the folder containing index.html).
// Binds 0.0.0.0 so other machines on the LAN can reach it at http://<your-ip>:<port>/.
// Sets the wasm MIME type and COOP/COEP headers that the game's worker + wasm need.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2], 10) || 3000;
const ROOT = path.join(__dirname, 'florr-local', 'static.florr.io', 'old');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve safely inside ROOT (prevent path traversal).
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + urlPath);
      console.log('404 ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Needed for SharedArrayBuffer / cross-origin isolation used by wasm workers.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
    console.log('200 ' + urlPath + ' (' + (MIME[ext] || 'octet-stream') + ')');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Serving ' + ROOT);
  console.log('  Local:   http://localhost:' + PORT + '/');
  console.log('  LAN:     http://<your-LAN-IP>:' + PORT + '/  (see `ipconfig`)');
});
