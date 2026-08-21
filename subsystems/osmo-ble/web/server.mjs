#!/usr/bin/env node
// Zero-dependency static file server for the web app. Serves the whole project root (so
// relative imports of ../protocol/*.mjs from web/app.mjs resolve) on http://localhost —
// Web Bluetooth requires a secure context, and localhost counts as one.

import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Redirect (not rewrite) "/" to "/web/index.html" so the browser's resolved base URL is
  // actually /web/, otherwise relative imports in the served HTML/JS (./app.mjs,
  // ../protocol/*.mjs) resolve against the wrong directory and 404 silently.
  if (urlPath === '/') {
    res.writeHead(302, { Location: '/web/index.html' });
    res.end();
    return;
  }

  const filePath = path.normalize(path.join(root, urlPath));

  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  // This project is under active iteration (protocol/command fixes land mid-session) — a
  // browser-cached stale copy of a .mjs module has already caused one confusing "the fix isn't
  // working" report, so always force a revalidation instead of letting heuristic HTTP caching
  // serve an old file.
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`Osmo BLE web app: http://localhost:${port}/`);
});
