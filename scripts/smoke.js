#!/usr/bin/env node
'use strict';

/**
 * Smoke test: boot server.js on a scratch port and prove the API answers.
 * Runs with NO inventory (a fresh checkout), which is itself a case worth
 * testing — the server must degrade cleanly, not crash.
 *
 * Exits 0 on success, 1 with the failing check named on stderr.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = +(process.env.SMOKE_PORT || 43170);
const BASE = { host: '127.0.0.1', port: PORT };

// A scratch data dir keeps the test hermetic: no inventory (so the degraded
// path is exercised) and no risk of clobbering real prefs or verdicts.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-smoke-'));

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, ATLAS_PORT: String(PORT), ATLAS_DATA: DATA },
  stdio: ['ignore', 'inherit', 'inherit'],
});

function request(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...BASE, method, path: reqPath, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ code: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function fail(msg) {
  process.stderr.write(`SMOKE FAIL: ${msg}\n`);
  server.kill();
  process.exit(1);
}

(async () => {
  // Wait for the server to bind.
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const r = await request('GET', '/api/status');
      if (r.code === 200) up = true;
    } catch { /* not up yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) fail('server never answered /api/status');

  const status = JSON.parse((await request('GET', '/api/status')).body);
  if (status.up !== true) fail('/api/status did not report up:true');

  // No inventory in a fresh checkout: /api/data must 503 cleanly, not crash.
  const data = await request('GET', '/api/data');
  if (data.code !== 503) fail(`/api/data without inventory returned ${data.code}, expected 503`);

  // Prefs round-trip.
  const posted = await request('POST', '/api/prefs', { group: 'owner', color: 'recency' });
  if (posted.code !== 200) fail(`POST /api/prefs returned ${posted.code}`);
  const prefs = JSON.parse((await request('GET', '/api/prefs')).body);
  if (prefs.group !== 'owner' || prefs.color !== 'recency') fail('prefs did not round-trip');

  // Malformed prefs must 400, not crash.
  const bad = await request('POST', '/api/prefs', ['not', 'an', 'object']);
  if (bad.code !== 400) fail(`POST /api/prefs with an array returned ${bad.code}, expected 400`);

  // The page itself serves.
  const page = await request('GET', '/');
  if (page.code !== 200 || !page.body.includes('Project Atlas')) fail('index.html did not serve');
  for (const asset of ['/app.js', '/palette.js', '/style.css']) {
    const r = await request('GET', asset);
    if (r.code !== 200) fail(`${asset} returned ${r.code}`);
  }

  // Version check answers. Fields vary by environment (offline, shallow
  // clone); answering at all is the contract.
  const ver = await request('GET', '/api/version');
  if (ver.code !== 200) fail(`/api/version returned ${ver.code}`);

  // Unknown paths 404 rather than crash or leak.
  const missing = await request('GET', '/no-such-file.js');
  if (missing.code !== 404) fail(`unknown path returned ${missing.code}, expected 404`);

  process.stdout.write('smoke ok\n');
  server.kill();
  process.exit(0);
})().catch((err) => fail(err.message));
