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
const { execFile, spawn } = require('child_process');

const PORT = +(process.env.ATLAS_PORT || 4317);
const HOST = '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INVENTORY = path.join(DATA_DIR, 'inventory.json');
const VERDICTS = path.join(DATA_DIR, 'verdicts.json');
const PREFS = path.join(DATA_DIR, 'prefs.json');
const PROGRESS = path.join(DATA_DIR, 'scan-progress.json');

/* ------------------------------------------------------------------ *
 * Live events. The menu bar app writes prefs; every open page hears
 * about it over SSE and applies them. Same channel announces scans.
 * ------------------------------------------------------------------ */
let sseClients = [];
let scanning = false;

function broadcast(event, data) {
  sseClients = sseClients.filter((c) => !c.writableEnded);
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(msg);
}

setInterval(() => broadcast('ping', { t: Date.now() }), 25000).unref();

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

  // Lightweight state for the menu bar: cheap enough to hit on every menu open.
  if (route === '/api/status' && req.method === 'GET') {
    const inv = readJSON(INVENTORY, null);
    return send(res, 200, JSON.stringify({
      up: true,
      scanning,
      // Only meaningful mid-scan; a stale progress file from the last run
      // must not read as current activity.
      progress: scanning ? readJSON(PROGRESS, null) : null,
      counts: inv ? inv.counts : null,
      generatedAt: inv ? inv.generatedAt : null,
      judged: Object.keys(readJSON(VERDICTS, {})).length,
      prefs: readJSON(PREFS, {}),
    }));
  }

  if (route === '/api/prefs' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(readJSON(PREFS, {})));
  }

  // Merge-in view preferences (from the menu bar or the page itself) and tell
  // every listener. Prefs are view state — never judgments.
  if (route === '/api/prefs' && req.method === 'POST') {
    try {
      const patch = JSON.parse(await readBody(req));
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return send(res, 400, JSON.stringify({ error: 'expected an object' }));
      }
      const prefs = { ...readJSON(PREFS, {}), ...patch };
      for (const k of Object.keys(prefs)) if (prefs[k] === null) delete prefs[k];
      writeJSONAtomic(PREFS, prefs);
      broadcast('prefs', prefs);
      return send(res, 200, JSON.stringify(prefs));
    } catch (err) {
      return send(res, 400, JSON.stringify({ error: err.message }));
    }
  }

  if (route === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ scanning })}\n\n`);
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter((c) => c !== res); });
    return undefined;
  }

  // Kick off a re-harvest. The scan writes facts only; verdicts are untouchable.
  if (route === '/api/scan' && req.method === 'POST') {
    if (scanning) return send(res, 409, JSON.stringify({ error: 'scan already running' }));
    scanning = true;
    broadcast('scan-start', {});
    const child = spawn(process.execPath, [path.join(__dirname, 'scan.js')], {
      cwd: __dirname,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}` },
    });
    let errTail = '';
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    // Relay the scanner's progress file to every open page while it runs,
    // skipping unchanged states so the stream stays quiet between phases.
    let lastProgress = '';
    const progTimer = setInterval(() => {
      const p = readJSON(PROGRESS, null);
      if (!p) return;
      const s = JSON.stringify(p);
      if (s === lastProgress) return;
      lastProgress = s;
      broadcast('scan-progress', p);
    }, 1000);
    child.on('close', (code) => {
      clearInterval(progTimer);
      scanning = false;
      broadcast('scan-done', { ok: code === 0, code, errTail: code === 0 ? undefined : errTail });
    });
    return send(res, 202, JSON.stringify({ started: true }));
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
