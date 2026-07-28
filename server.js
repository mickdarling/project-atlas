#!/usr/bin/env node
'use strict';

/**
 * Local-only server. Binds to 127.0.0.1 — nothing here is exposed.
 *
 *   GET  /api/data      -> { inventory, verdicts }
 *   PUT  /api/verdicts  -> writes data/verdicts.json (atomic)
 *   POST /api/open      -> reveals a repo in Finder / opens in editor
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = +(process.env.ATLAS_PORT || 4317);
const HOST = '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INVENTORY = path.join(DATA_DIR, 'inventory.json');
const VERDICTS = path.join(DATA_DIR, 'verdicts.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSONAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname;

  if (route === '/api/data' && req.method === 'GET') {
    const inventory = readJSON(INVENTORY, null);
    if (!inventory) {
      return send(res, 503, JSON.stringify({ error: 'no inventory yet — run `npm run scan`' }));
    }
    return send(res, 200, JSON.stringify({ inventory, verdicts: readJSON(VERDICTS, {}) }));
  }

  if (route === '/api/verdicts' && req.method === 'PUT') {
    try {
      const parsed = JSON.parse(await readBody(req));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return send(res, 400, JSON.stringify({ error: 'expected an object' }));
      }
      writeJSONAtomic(VERDICTS, parsed);
      return send(res, 200, JSON.stringify({ ok: true, count: Object.keys(parsed).length }));
    } catch (err) {
      return send(res, 400, JSON.stringify({ error: err.message }));
    }
  }

  // Reveal a repo locally. Path must live under the scanned root.
  if (route === '/api/open' && req.method === 'POST') {
    try {
      const { absPath } = JSON.parse(await readBody(req));
      const inventory = readJSON(INVENTORY, null);
      const known = inventory && inventory.repos.some((r) => r.absPath && r.absPath === absPath);
      if (!known) return send(res, 400, JSON.stringify({ error: 'unknown path' }));
      execFile('open', ['-R', absPath], () => {});
      return send(res, 200, JSON.stringify({ ok: true }));
    } catch (err) {
      return send(res, 400, JSON.stringify({ error: err.message }));
    }
  }

  // Static files
  if (req.method !== 'GET') return send(res, 405, JSON.stringify({ error: 'method not allowed' }));

  const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, JSON.stringify({ error: 'forbidden' }));
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, JSON.stringify({ error: 'not found' }));
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

server.listen(PORT, HOST, () => {
  const stamp = readJSON(INVENTORY, null);
  process.stdout.write(`\n  Project Atlas  ->  http://${HOST}:${PORT}\n`);
  process.stdout.write(
    stamp
      ? `  inventory: ${stamp.repos.length} projects, scanned ${stamp.generatedAt}\n\n`
      : `  no inventory yet — run \`npm run scan\`\n\n`
  );
});
