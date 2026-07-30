#!/usr/bin/env node
'use strict';

/**
 * MCP adapter smoke test: boot the Atlas server against a scratch data dir
 * seeded with a tiny inventory, spawn mcp/server.js over stdio, and walk
 * the CRUDE surface — initialize, tools/list, introspect, at least one
 * operation per endpoint, the Gatekeeper rejection, batch, and attribution
 * (verdicts written via MCP carry via:"mcp").
 *
 * Exits 0 on success, 1 with the failing check named on stderr.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');

const PORT = +(process.env.SMOKE_PORT || 43171);
const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mcp-smoke-'));

/* Two ordinary projects and a duplicate pair — enough to exercise listing,
 * resolution, triage ordering, and the ⧉ cluster view. */
const INVENTORY = {
  generatedAt: '2026-07-30T12:00:00.000Z',
  counts: { total: 4, openIssues: 7, localOnly: 1, remoteOnly: 0, duplicateClones: 1, openPRs: 0 },
  repos: [
    {
      key: 'local:alpha', slug: 'me/alpha', name: 'alpha', owner: 'me', group: 'me',
      presence: 'both', provenance: 'mine', path: 'alpha', absPath: '/tmp/alpha',
      commits: 100, effort: 90, lastActivity: '2026-07-29T00:00:00Z', openIssues: 5,
      clonesOfSlug: 0, isPrimaryClone: true, duplicateOf: null, isPrivate: true, topics: [],
    },
    {
      key: 'local:beta', slug: 'me/beta', name: 'beta', owner: 'me', group: 'me',
      presence: 'local-only', provenance: 'mine', path: 'beta', absPath: '/tmp/beta',
      commits: 10, effort: 10, lastActivity: '2024-01-01T00:00:00Z', openIssues: 0,
      clonesOfSlug: 0, isPrimaryClone: true, duplicateOf: null, isPrivate: null, topics: [],
    },
    {
      key: 'local:gamma', slug: 'me/gamma', name: 'gamma', owner: 'me', group: 'me',
      presence: 'both', provenance: 'mine', path: 'gamma', absPath: '/tmp/gamma',
      commits: 50, effort: 40, lastActivity: '2026-01-01T00:00:00Z', openIssues: 2,
      clonesOfSlug: 2, isPrimaryClone: true, duplicateOf: null, isPrivate: true, topics: [],
    },
    {
      key: 'local:gamma-backup', slug: 'me/gamma', name: 'gamma', owner: 'me', group: 'me',
      presence: 'both', provenance: 'mine', path: 'backup/gamma', absPath: '/tmp/gamma-backup',
      commits: 48, effort: 40, lastActivity: '2025-12-01T00:00:00Z', openIssues: null,
      clonesOfSlug: 2, isPrimaryClone: false, duplicateOf: 'local:gamma', isPrivate: true, topics: [],
    },
  ],
};
fs.writeFileSync(path.join(DATA, 'inventory.json'), JSON.stringify(INVENTORY));

const atlas = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, ATLAS_PORT: String(PORT), ATLAS_DATA: DATA },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.js')], {
  env: { ...process.env, ATLAS_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'inherit'],
});

function shutdown(code) {
  mcp.kill();
  atlas.kill();
  process.exit(code);
}

function fail(msg) {
  process.stderr.write(`MCP SMOKE FAIL: ${msg}\n`);
  shutdown(1);
}

/* Minimal JSON-RPC client over the child's stdio. */
const pending = new Map();
let nextId = 1;
readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const done = pending.get(msg.id);
  if (done) { pending.delete(msg.id); done(msg); }
});

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }
    }, 10000);
  });
}

/** tools/call → the parsed discriminated payload. */
async function call(tool, args) {
  const res = await rpc('tools/call', { name: tool, arguments: args });
  if (!res.result || !res.result.content) throw new Error(`no content from ${tool}`);
  return JSON.parse(res.result.content[0].text);
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(JSON.parse(buf)));
    }).on('error', reject);
  });
}

(async () => {
  // Wait for the Atlas server.
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await get('/api/status'); up = true; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!up) fail('Atlas server never answered');

  // MCP handshake.
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  if (!init.result || init.result.serverInfo.name !== 'project-atlas') fail('initialize did not identify project-atlas');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await rpc('tools/list', {});
  const names = tools.result.tools.map((t) => t.name).sort();
  const want = ['mcp_aql_create', 'mcp_aql_delete', 'mcp_aql_execute', 'mcp_aql_read', 'mcp_aql_update'];
  if (JSON.stringify(names) !== JSON.stringify(want)) fail(`tools/list gave ${names.join(', ')}`);

  // READ: introspect is spec-mandatory.
  const intro = await call('mcp_aql_read', { operation: 'introspect', params: { query: 'operations' } });
  if (!intro.success || intro.data.operations.length < 15) fail('introspect returned too few operations');

  // READ: listing, resolution, triage order (coldest first = beta).
  const list = await call('mcp_aql_read', { operation: 'list_projects', params: { visibility: 'all' } });
  if (!list.success || list.data.total !== 4) fail(`list_projects total ${list.data && list.data.total}, expected 4`);
  const untriaged = await call('mcp_aql_read', { operation: 'list_untriaged', params: {} });
  if (untriaged.data.projects[0].key !== 'local:beta') fail('list_untriaged is not coldest-first');
  const dups = await call('mcp_aql_read', { operation: 'list_duplicates', params: {} });
  if (dups.data.clusters.length !== 1 || dups.data.clusters[0].clones.length !== 2) fail('list_duplicates missed the gamma cluster');
  const one = await call('mcp_aql_read', { operation: 'get_project', params: { key: 'me/alpha' } });
  if (!one.success || one.data.key !== 'local:alpha') fail('get_project did not resolve a slug to its key');

  // Gatekeeper: an UPDATE op through READ must be rejected, not routed.
  const blocked = await call('mcp_aql_read', { operation: 'set_status', params: { key: 'local:alpha', status: 'active' } });
  if (blocked.success || blocked.error.code !== 'ENDPOINT_MISMATCH') fail('Gatekeeper allowed set_status through READ');

  // UPDATE: write a verdict, check attribution lands on disk.
  const set = await call('mcp_aql_update', { operation: 'set_status', params: { key: 'local:alpha', status: 'active' } });
  if (!set.success) fail(`set_status failed: ${JSON.stringify(set.error)}`);
  const disk1 = await get('/api/data');
  if (!disk1.verdicts['local:alpha'] || disk1.verdicts['local:alpha'].via !== 'mcp') fail('verdict not stamped via:"mcp"');

  // CREATE + batch: two additive ops in one request, in order.
  const batch = await call('mcp_aql_create', {
    operations: [
      { operation: 'add_tag', params: { key: 'local:alpha', tag: 'smoke' } },
      { operation: 'add_note', params: { key: 'local:alpha', text: 'batch says hello' } },
    ],
  });
  if (!batch.success || batch.summary.succeeded !== 2) fail(`batch summary ${JSON.stringify(batch.summary)}`);

  // Batch endpoint enforcement: an UPDATE op inside a CREATE batch fails, batch continues.
  const mixed = await call('mcp_aql_create', {
    operations: [{ operation: 'set_priority', params: { key: 'local:alpha', priority: 2 } }],
  });
  if (mixed.results[0].result.success) fail('CREATE batch accepted an UPDATE operation');

  // DELETE: clear the whole record; the file record disappears.
  const cleared = await call('mcp_aql_delete', { operation: 'clear_verdict', params: { key: 'local:alpha' } });
  if (!cleared.success || cleared.data.verdict !== null) fail('clear_verdict did not clear');
  const disk2 = await get('/api/data');
  if (disk2.verdicts['local:alpha']) fail('verdict record survived clear_verdict');

  // EXECUTE-adjacent READ: refresh state answers without a scan running.
  const state = await call('mcp_aql_read', { operation: 'get_refresh_state', params: {} });
  if (!state.success || state.data.scanning !== false) fail('get_refresh_state wrong');

  // UPDATE prefs round-trip through the adapter.
  const prefs = await call('mcp_aql_update', { operation: 'update_prefs', params: { group: 'duplicates' } });
  if (!prefs.success || prefs.data.group !== 'duplicates') fail('update_prefs did not round-trip');

  // Unknown operation names itself clearly.
  const unknown = await call('mcp_aql_read', { operation: 'no_such_op', params: {} });
  if (unknown.success || unknown.error.code !== 'UNKNOWN_OPERATION') fail('unknown operation not rejected');

  // Regression: closing stdin right after a request must not swallow the
  // in-flight answer — the server drains before exiting.
  const short = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.js')], {
    env: { ...process.env, ATLAS_PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let shortOut = '';
  short.stdout.on('data', (c) => { shortOut += c; });
  short.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'mcp_aql_read', arguments: { operation: 'get_counts', params: {} } } }) + '\n');
  short.stdin.end();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('drain-on-close: server never answered after stdin closed')), 8000);
    short.on('exit', () => { clearTimeout(t); resolve(); });
  });
  const answered = shortOut.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).some((m) => m && m.id === 1 && m.result && m.result.isError === false);
  if (!answered) fail('drain-on-close: in-flight request was swallowed');

  process.stdout.write('mcp smoke ok\n');
  shutdown(0);
})().catch((err) => fail(err.message));
