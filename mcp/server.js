#!/usr/bin/env node
'use strict';

/**
 * MCP-AQL adapter for Project Atlas.
 *
 * A stdio MCP server exposing the Atlas through the five CRUDE endpoints
 * of the MCP-AQL spec (github.com/MCPAQL/spec, v1.0.0-draft):
 * mcp_aql_create / read / update / delete / execute — or one unified
 * mcp_aql endpoint with --single.
 *
 * It proxies the running Atlas server at 127.0.0.1:4317 instead of touching
 * data/ files: the Atlas server stays the single writer, verdict writes stay
 * atomic, and every open page hears about AI actions over SSE exactly as it
 * hears about yours. Server down = a clean discriminated error, never a
 * stale file read.
 *
 * The two-layer rule, extended to a third party:
 *   - Facts are read-only through EVERY endpoint. Nothing here can write
 *     inventory.json.
 *   - Judgments written through this adapter are stamped via:"mcp", so the
 *     human's calls and the AI's are never indistinguishable.
 *   - EXECUTE ops are the ones to keep behind explicit client approval.
 *     App self-update is deliberately NOT exposed here.
 *
 * Registration:  claude mcp add atlas -- node <repo>/mcp/server.js
 */

const http = require('http');
const readline = require('readline');

const PORT = +(process.env.ATLAS_PORT || 4317);
const SINGLE = process.argv.includes('--single');
const VERSION = '0.1.0';

/* ------------------------------------------------------------- HTTP */

function api(method, path, body) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* non-JSON body */ }
          resolve({ code: res.statusCode, json });
        });
      }
    );
    req.on('error', () => resolve({ code: 0, json: null }));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/* Discriminated responses, per spec: success carries data, failure carries
 * a machine code and a human message. */
const ok = (data) => ({ success: true, data });
const fail = (code, message) => ({ success: false, error: { code, message } });

const DOWN = fail('ATLAS_DOWN',
  `The Atlas server is not answering on 127.0.0.1:${PORT}. Start it (menu bar → Start Server, or npm run serve).`);

/* -------------------------------------------------------- vocabulary */

const TYPES = {
  Status: ['active', 'in-use', 'someday', 'done', 'dead'],
  Priority: [0, 1, 2, 3],
  Visibility: ['visible', 'hidden', 'ignored'],
  Provenance: ['mine', 'fork', 'external'],
  Presence: ['both', 'local-only', 'remote-only'],
  PrefKey: ['group', 'color', 'size', 'accent', 'hue', 'hueTo', 'scale', 'date', 'visibility', 'share', 'chrome', 'theme'],
};

/* The fields a project record can carry, merged facts + judgment. Field
 * selection exists because 178 full records would swamp a context window. */
const SUMMARY_FIELDS = [
  'key', 'name', 'owner', 'presence', 'provenance', 'lastActivity',
  'effort', 'commits', 'openIssues', 'status', 'priority', 'visibility',
];

function mergedRecord(r, verdicts) {
  const v = verdicts[r.key] || {};
  return {
    ...r,
    status: v.status || null,
    priority: v.priority || 0,
    visibility: v.visibility || 'visible',
    hiddenReason: v.hiddenReason || null,
    provenance: v.provenance || r.provenance,
    provenanceOverridden: !!v.provenance,
    disown: !!v.disown,
    tags: v.tags || [],
    note: v.note || null,
    aka: v.aka || null,
    via: v.via || null,
    markedAt: v.markedAt || null,
  };
}

function pick(rec, fields) {
  const out = {};
  for (const f of fields) if (f in rec) out[f] = rec[f];
  return out;
}

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (Date.now() - t) / 86400000;
}

/* ------------------------------------------------------ data helpers */

async function loadData() {
  const r = await api('GET', '/api/data');
  if (r.code === 0) return { error: DOWN };
  if (r.code === 503) return { error: fail('NO_INVENTORY', 'No inventory yet — run a refresh first (npm run scan, or the EXECUTE refresh operation).') };
  if (r.code !== 200 || !r.json) return { error: fail('ATLAS_ERROR', `GET /api/data returned ${r.code}`) };
  return { inventory: r.json.inventory, verdicts: r.json.verdicts || {} };
}

/** Resolve a project by key, slug, or name — in that order, case-insensitive
 *  past the exact-key match. Ambiguity is an error that names the candidates
 *  rather than a silent first-match. */
function findRepo(inventory, keyish) {
  const q = String(keyish || '');
  const ql = q.toLowerCase();
  const repos = inventory.repos;
  let hit = repos.find((r) => r.key === q);
  if (hit) return { repo: hit };
  const bySlug = repos.filter((r) => (r.slug || '').toLowerCase() === ql);
  if (bySlug.length) {
    // Several working copies can share a slug; the primary carries the stats.
    return { repo: bySlug.find((r) => r.isPrimaryClone) || bySlug[0] };
  }
  const byName = repos.filter((r) => (r.name || '').toLowerCase() === ql);
  if (byName.length === 1) return { repo: byName[0] };
  if (byName.length > 1) {
    return { error: fail('AMBIGUOUS', `"${q}" matches ${byName.length} projects: ${byName.map((r) => r.key).join(', ')} — use a key.`) };
  }
  return { error: fail('NOT_FOUND', `No project matches "${q}" by key, slug, or name.`) };
}

/* Mirrors the page's setVerdict: merge, prune empties, stamp markedAt and
 * the commit that was newest when the call was made — plus via:"mcp", the
 * attribution that keeps AI judgments distinguishable from the human's. */
async function patchVerdict(keyish, patch) {
  const d = await loadData();
  if (d.error) return d.error;
  const f = findRepo(d.inventory, keyish);
  if (f.error) return f.error;
  const r = f.repo;

  const next = { ...(d.verdicts[r.key] || {}), ...patch };
  if (next.visibility === 'visible') delete next.visibility;
  for (const k of Object.keys(next)) {
    const val = next[k];
    if (val === undefined || val === null || val === '' ||
        (Array.isArray(val) && !val.length) || val === false) {
      delete next[k];
    }
  }

  const meaningful = Object.keys(next).some((k) => !['markedAt', 'seenLastCommit', 'via'].includes(k));
  if (!meaningful) {
    delete d.verdicts[r.key];
  } else {
    next.markedAt = new Date().toISOString();
    if (r.lastActivity) next.seenLastCommit = r.lastActivity;
    next.via = 'mcp';
    d.verdicts[r.key] = next;
  }

  const put = await api('PUT', '/api/verdicts', d.verdicts);
  if (put.code === 0) return DOWN;
  if (put.code !== 200) return fail('SAVE_FAILED', `PUT /api/verdicts returned ${put.code}`);
  return ok({ key: r.key, name: r.name, verdict: d.verdicts[r.key] || null });
}

/* --------------------------------------------------------- operations *
 * Schema-driven, per spec: every operation declares its CRUDE endpoint,
 * description, and parameters. The Gatekeeper validates against exactly
 * this table, and introspect serves it back to clients at runtime.
 * -------------------------------------------------------------------- */

const P = (type, description, opts = {}) => ({ type, description, ...opts });

const OPS = {
  /* ---- READ ---- */

  introspect: {
    endpoint: 'read',
    description: 'Discover operations and types at runtime (spec-required).',
    params: {
      query: P('string', '"operations" or "types"', { required: true, enum: ['operations', 'types'] }),
      name: P('string', 'Optional: one operation or type to detail'),
    },
    handler: async ({ query, name }) => {
      if (query === 'operations') {
        const list = Object.entries(OPS)
          .filter(([n]) => !name || n === name)
          .map(([n, op]) => ({ name: n, endpoint: op.endpoint, description: op.description, params: op.params }));
        if (name && !list.length) return fail('NOT_FOUND', `No operation named "${name}".`);
        return ok(name ? list[0] : { operations: list });
      }
      if (query === 'types') {
        if (name) {
          if (!(name in TYPES)) return fail('NOT_FOUND', `No type named "${name}".`);
          return ok({ [name]: TYPES[name] });
        }
        return ok({ types: TYPES });
      }
      return fail('VALIDATION_ERROR', 'query must be "operations" or "types".');
    },
  },

  list_projects: {
    endpoint: 'read',
    description: 'List projects with filters, sorting, and field selection.',
    params: {
      search: P('string', 'Substring match over name, org, path, language, description, topics, tags, notes, aka'),
      org: P('string', 'Owner/organization name'),
      status: P('string', 'Verdict status, or "untriaged"', { enum: [...TYPES.Status, 'untriaged'] }),
      priority: P('number', 'Verdict priority 0–3', { enum: TYPES.Priority }),
      visibility: P('string', 'Defaults to visible', { enum: [...TYPES.Visibility, 'all'] }),
      provenance: P('string', 'Effective provenance (override wins)', { enum: TYPES.Provenance }),
      presence: P('string', 'Where the project lives', { enum: TYPES.Presence }),
      workedWithinDays: P('number', 'Only projects with activity in the last N days'),
      quietForDays: P('number', 'Only projects quiet for at least N days (no activity data counts as quiet)'),
      duplicatesOnly: P('boolean', 'Only projects with more than one working copy'),
      untriagedOnly: P('boolean', 'Only visible projects with no status verdict'),
      sort: P('string', 'Field name, "-" prefix for descending. Default "-commits"'),
      limit: P('number', 'Default 50'),
      fields: P('array', `Fields to return. Default: ${SUMMARY_FIELDS.join(', ')}`),
    },
    handler: async (p) => {
      const d = await loadData();
      if (d.error) return d.error;
      let rows = d.inventory.repos.map((r) => mergedRecord(r, d.verdicts));

      const vis = p.visibility || 'visible';
      if (vis !== 'all') rows = rows.filter((r) => r.visibility === vis);
      if (p.org) rows = rows.filter((r) => (r.owner || '').toLowerCase() === p.org.toLowerCase() || (r.group || '').toLowerCase() === p.org.toLowerCase());
      if (p.status === 'untriaged') rows = rows.filter((r) => !r.status);
      else if (p.status) rows = rows.filter((r) => r.status === p.status);
      if (p.priority !== undefined) rows = rows.filter((r) => r.priority === p.priority);
      if (p.provenance) rows = rows.filter((r) => r.provenance === p.provenance);
      if (p.presence) rows = rows.filter((r) => r.presence === p.presence);
      if (p.duplicatesOnly) rows = rows.filter((r) => r.clonesOfSlug > 1);
      if (p.untriagedOnly) rows = rows.filter((r) => !r.status && r.visibility === 'visible');
      if (p.workedWithinDays !== undefined) {
        rows = rows.filter((r) => { const dd = daysSince(r.lastActivity); return dd !== null && dd < p.workedWithinDays; });
      }
      if (p.quietForDays !== undefined) {
        rows = rows.filter((r) => { const dd = daysSince(r.lastActivity); return dd === null || dd >= p.quietForDays; });
      }
      if (p.search) {
        const q = p.search.toLowerCase();
        rows = rows.filter((r) => [
          r.name, r.owner, r.path, r.language, r.description, r.slug, r.note, r.hiddenReason, r.aka,
          ...(r.topics || []), ...(r.tags || []),
        ].filter(Boolean).join(' ').toLowerCase().includes(q));
      }

      const sort = p.sort || '-commits';
      const desc = sort.startsWith('-');
      const field = desc ? sort.slice(1) : sort;
      rows.sort((a, b) => {
        const av = a[field], bv = b[field];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av > bv ? 1 : -1) * (desc ? -1 : 1);
      });

      const total = rows.length;
      rows = rows.slice(0, p.limit || 50);
      const fields = Array.isArray(p.fields) && p.fields.length ? p.fields : SUMMARY_FIELDS;
      return ok({ total, returned: rows.length, projects: rows.map((r) => pick(r, fields)) });
    },
  },

  get_project: {
    endpoint: 'read',
    description: 'Full fact record plus verdict for one project.',
    params: { key: P('string', 'Project key, slug, or unique name', { required: true }) },
    handler: async ({ key }) => {
      const d = await loadData();
      if (d.error) return d.error;
      const f = findRepo(d.inventory, key);
      if (f.error) return f.error;
      return ok(mergedRecord(f.repo, d.verdicts));
    },
  },

  get_counts: {
    endpoint: 'read',
    description: 'Portfolio counts and when the inventory was generated.',
    params: {},
    handler: async () => {
      const r = await api('GET', '/api/status');
      if (r.code === 0) return DOWN;
      return ok({ counts: r.json.counts, generatedAt: r.json.generatedAt, judged: r.json.judged });
    },
  },

  get_refresh_state: {
    endpoint: 'read',
    description: 'Whether a refresh is running, and where it is.',
    params: {},
    handler: async () => {
      const r = await api('GET', '/api/status');
      if (r.code === 0) return DOWN;
      return ok({ scanning: r.json.scanning, progress: r.json.progress || null });
    },
  },

  list_duplicates: {
    endpoint: 'read',
    description: 'The ⧉ duplicate-clone clusters: every working copy per slug.',
    params: {},
    handler: async () => {
      const d = await loadData();
      if (d.error) return d.error;
      const clusters = new Map();
      for (const r of d.inventory.repos) {
        if (!(r.clonesOfSlug > 1) || !r.path) continue;
        if (!clusters.has(r.slug)) clusters.set(r.slug, []);
        clusters.get(r.slug).push({
          key: r.key, path: r.path, commits: r.commits, lastActivity: r.lastActivity,
          isPrimaryClone: r.isPrimaryClone,
          visibility: (d.verdicts[r.key] || {}).visibility || 'visible',
        });
      }
      const out = [...clusters.entries()].map(([slug, clones]) => ({
        slug,
        clones: clones.sort((a, b) => (b.isPrimaryClone - a.isPrimaryClone) || b.commits - a.commits),
      }));
      return ok({ clusters: out });
    },
  },

  list_untriaged: {
    endpoint: 'read',
    description: 'The triage queue: visible projects with no status verdict, coldest first (same order as the page).',
    params: { limit: P('number', 'Default 50') },
    handler: async ({ limit }) => {
      const d = await loadData();
      if (d.error) return d.error;
      const rows = d.inventory.repos
        .map((r) => mergedRecord(r, d.verdicts))
        .filter((r) => !r.status && r.visibility === 'visible')
        .sort((a, b) => {
          const ta = a.lastActivity ? Date.parse(a.lastActivity) : -Infinity;
          const tb = b.lastActivity ? Date.parse(b.lastActivity) : -Infinity;
          return ta - tb;
        });
      return ok({
        total: rows.length,
        projects: rows.slice(0, limit || 50).map((r) =>
          pick(r, ['key', 'name', 'owner', 'lastActivity', 'effort', 'commits', 'openIssues', 'description'])),
      });
    },
  },

  get_prefs: {
    endpoint: 'read',
    description: 'The shared view state every page and the menu bar follow.',
    params: {},
    handler: async () => {
      const r = await api('GET', '/api/prefs');
      if (r.code === 0) return DOWN;
      return ok(r.json || {});
    },
  },

  get_version: {
    endpoint: 'read',
    description: 'The app’s own code: current commit and commits behind origin/main.',
    params: {},
    handler: async () => {
      const r = await api('GET', '/api/version');
      if (r.code === 0) return DOWN;
      return ok(r.json || {});
    },
  },

  /* ---- CREATE (additive only) ---- */

  add_tag: {
    endpoint: 'create',
    description: 'Add a tag to a project (additive; existing tags kept).',
    params: {
      key: P('string', 'Project key, slug, or unique name', { required: true }),
      tag: P('string', 'Tag to add', { required: true }),
    },
    handler: async ({ key, tag }) => {
      const d = await loadData();
      if (d.error) return d.error;
      const f = findRepo(d.inventory, key);
      if (f.error) return f.error;
      const tags = [...new Set([...(d.verdicts[f.repo.key] || {}).tags || [], String(tag).trim()])].filter(Boolean);
      return patchVerdict(f.repo.key, { tags });
    },
  },

  add_note: {
    endpoint: 'create',
    description: 'APPEND a dated line to a project’s note. Never replaces — replacing is UPDATE set_note.',
    params: {
      key: P('string', 'Project key, slug, or unique name', { required: true }),
      text: P('string', 'Text to append', { required: true }),
    },
    handler: async ({ key, text }) => {
      const d = await loadData();
      if (d.error) return d.error;
      const f = findRepo(d.inventory, key);
      if (f.error) return f.error;
      const prev = (d.verdicts[f.repo.key] || {}).note || '';
      const stamp = new Date().toISOString().slice(0, 10);
      const note = (prev ? prev + '\n\n' : '') + `[${stamp} · mcp] ${String(text).trim()}`;
      return patchVerdict(f.repo.key, { note });
    },
  },

  /* ---- UPDATE (judgments and view state — never facts) ---- */

  set_status: {
    endpoint: 'update',
    description: 'Set a project’s status verdict; null clears it.',
    params: {
      key: P('string', 'Project key, slug, or unique name', { required: true }),
      status: P('string', 'active | in-use | someday | done | dead | null to clear', { required: true }),
    },
    handler: ({ key, status }) => {
      if (status !== null && !TYPES.Status.includes(status)) {
        return fail('VALIDATION_ERROR', `status must be one of ${TYPES.Status.join(', ')} or null.`);
      }
      return patchVerdict(key, { status: status || undefined });
    },
  },

  set_priority: {
    endpoint: 'update',
    description: 'Set priority 1–3; 0 clears.',
    params: {
      key: P('string', 'Project key, slug, or unique name', { required: true }),
      priority: P('number', '0 (clear) to 3 (high)', { required: true, enum: TYPES.Priority }),
    },
    handler: ({ key, priority }) => {
      if (!TYPES.Priority.includes(priority)) return fail('VALIDATION_ERROR', 'priority must be 0–3.');
      return patchVerdict(key, { priority: priority || undefined });
    },
  },

  set_visibility: {
    endpoint: 'update',
    description: 'Show, hide, or ignore a project — reversible filing, never deletion.',
    params: {
      key: P('string', 'Project key, slug, or unique name', { required: true }),
      visibility: P('string', 'visible | hidden | ignored', { required: true, enum: TYPES.Visibility }),
      reason: P('string', 'Searchable reason (hidden/ignored only)'),
    },
    handler: ({ key, visibility, reason }) => {
      if (!TYPES.Visibility.includes(visibility)) return fail('VALIDATION_ERROR', 'visibility must be visible, hidden, or ignored.');
      return patchVerdict(key, { visibility, hiddenReason: visibility === 'visible' ? undefined : (reason || undefined) });
    },
  },

  set_provenance: {
    endpoint: 'update',
    description: 'Override detected provenance (shown with ✎ like manual overrides); null reverts to auto-detect.',
    params: {
      key: P('string', 'Project key, slug, or unique name', { required: true }),
      provenance: P('string', 'mine | fork | external | null for auto', { required: true }),
      disown: P('boolean', 'Don’t count its commits as the user’s work (defaults to true for non-mine)'),
    },
    handler: ({ key, provenance, disown }) => {
      if (provenance !== null && !TYPES.Provenance.includes(provenance)) {
        return fail('VALIDATION_ERROR', `provenance must be one of ${TYPES.Provenance.join(', ')} or null.`);
      }
      const patch = { provenance: provenance || undefined };
      if (disown !== undefined) patch.disown = disown;
      else if (provenance && provenance !== 'mine') patch.disown = true;
      else if (provenance === 'mine') patch.disown = false;
      return patchVerdict(key, patch);
    },
  },

  set_note: {
    endpoint: 'update',
    description: 'Replace a project’s note; empty clears. Appending is CREATE add_note.',
    params: {
      key: P('string', 'Project key, slug, or unique name', { required: true }),
      text: P('string', 'New note text ("" clears)', { required: true }),
    },
    handler: ({ key, text }) => patchVerdict(key, { note: String(text).trim() || undefined }),
  },

  set_aka: {
    endpoint: 'update',
    description: 'Set the share name shown instead of the hash pseudonym in share mode; empty clears.',
    params: {
      key: P('string', 'Project key, slug, or unique name', { required: true }),
      aka: P('string', 'Share name ("" clears)', { required: true }),
    },
    handler: ({ key, aka }) => patchVerdict(key, { aka: String(aka).trim() || undefined }),
  },

  update_prefs: {
    endpoint: 'update',
    description: 'Change the shared view state — every open page and the menu bar follow live over SSE.',
    params: Object.fromEntries(TYPES.PrefKey.map((k) => [k, P('string', `View pref "${k}"`)])),
    handler: async (p) => {
      const patch = {};
      for (const k of TYPES.PrefKey) if (p[k] !== undefined) patch[k] = p[k];
      if (!Object.keys(patch).length) return fail('VALIDATION_ERROR', `Provide at least one of: ${TYPES.PrefKey.join(', ')}`);
      const r = await api('POST', '/api/prefs', patch);
      if (r.code === 0) return DOWN;
      if (r.code !== 200) return fail('ATLAS_ERROR', `POST /api/prefs returned ${r.code}`);
      return ok(r.json);
    },
  },

  /* ---- DELETE (verdict data only — facts are untouchable) ---- */

  remove_tag: {
    endpoint: 'delete',
    description: 'Remove one tag from a project.',
    params: {
      key: P('string', 'Project key, slug, or unique name', { required: true }),
      tag: P('string', 'Tag to remove', { required: true }),
    },
    handler: async ({ key, tag }) => {
      const d = await loadData();
      if (d.error) return d.error;
      const f = findRepo(d.inventory, key);
      if (f.error) return f.error;
      const tags = ((d.verdicts[f.repo.key] || {}).tags || []).filter((t) => t !== tag);
      return patchVerdict(f.repo.key, { tags });
    },
  },

  clear_verdict: {
    endpoint: 'delete',
    description: 'Clear one judgment field, or the whole judgment record. Only verdict data — never facts.',
    params: {
      key: P('string', 'Project key, slug, or unique name', { required: true }),
      field: P('string', 'One of status, priority, visibility, provenance, note, tags, aka, disown — omit for the whole record'),
    },
    handler: async ({ key, field }) => {
      const CLEARABLE = ['status', 'priority', 'visibility', 'provenance', 'note', 'tags', 'aka', 'disown'];
      if (field && !CLEARABLE.includes(field)) {
        return fail('VALIDATION_ERROR', `field must be one of ${CLEARABLE.join(', ')}`);
      }
      if (field) {
        const patch = { [field]: undefined };
        if (field === 'visibility') patch.hiddenReason = undefined;
        return patchVerdict(key, patch);
      }
      const d = await loadData();
      if (d.error) return d.error;
      const f = findRepo(d.inventory, key);
      if (f.error) return f.error;
      delete d.verdicts[f.repo.key];
      const put = await api('PUT', '/api/verdicts', d.verdicts);
      if (put.code === 0) return DOWN;
      if (put.code !== 200) return fail('SAVE_FAILED', `PUT /api/verdicts returned ${put.code}`);
      return ok({ key: f.repo.key, name: f.repo.name, verdict: null });
    },
  },

  /* ---- EXECUTE (runtime, non-idempotent — keep behind approval) ---- */

  refresh: {
    endpoint: 'execute',
    description: 'Start a content refresh (re-harvest local repos + GitHub). Takes minutes; poll get_refresh_state (READ) for progress.',
    params: {},
    handler: async () => {
      const r = await api('POST', '/api/scan', {});
      if (r.code === 0) return DOWN;
      if (r.code === 409) return fail('ALREADY_RUNNING', 'A refresh is already running — poll get_refresh_state.');
      if (r.code !== 202) return fail('ATLAS_ERROR', `POST /api/scan returned ${r.code}`);
      return ok({ started: true });
    },
  },

  reveal_in_finder: {
    endpoint: 'execute',
    description: 'Reveal a local project in the user’s Finder — a side-effect on their desktop.',
    params: { key: P('string', 'Project key, slug, or unique name', { required: true }) },
    handler: async ({ key }) => {
      const d = await loadData();
      if (d.error) return d.error;
      const f = findRepo(d.inventory, key);
      if (f.error) return f.error;
      if (!f.repo.absPath) return fail('NOT_LOCAL', `${f.repo.name} is not cloned on this machine.`);
      const r = await api('POST', '/api/open', { absPath: f.repo.absPath });
      if (r.code === 0) return DOWN;
      if (r.code !== 200) return fail('ATLAS_ERROR', `POST /api/open returned ${r.code}`);
      return ok({ revealed: f.repo.absPath });
    },
  },
};

/* --------------------------------------------------------- gatekeeper */

const ENDPOINTS = ['create', 'read', 'update', 'delete', 'execute'];

function validateParams(op, params) {
  for (const [name, spec] of Object.entries(op.params)) {
    if (spec.required && (params[name] === undefined ||
        (params[name] === '' && spec.type !== 'string'))) {
      return fail('VALIDATION_ERROR', `Required parameter "${name}" is missing.`);
    }
  }
  return null;
}

/** One operation through one endpoint, Gatekeeper first. */
async function dispatch(endpoint, operation, params) {
  const op = OPS[operation];
  if (!op) return fail('UNKNOWN_OPERATION', `No operation named "${operation}". Use introspect on the READ endpoint.`);
  if (endpoint !== 'any' && op.endpoint !== endpoint) {
    return fail('ENDPOINT_MISMATCH',
      `"${operation}" is a ${op.endpoint.toUpperCase()} operation and cannot be called through the ${endpoint.toUpperCase()} endpoint.`);
  }
  const p = params || {};
  const invalid = validateParams(op, p);
  if (invalid) return invalid;
  try {
    return await op.handler(p);
  } catch (err) {
    return fail('INTERNAL_ERROR', err.message);
  }
}

/** Batch, per spec: in order, results for every op including failures. */
async function dispatchBatch(endpoint, operations) {
  const results = [];
  let succeeded = 0;
  for (let i = 0; i < operations.length; i++) {
    const entry = operations[i] || {};
    const result = await dispatch(endpoint, entry.operation, entry.params);
    if (result.success) succeeded++;
    results.push({ index: i, operation: entry.operation, result });
  }
  return { success: true, results, summary: { total: operations.length, succeeded, failed: operations.length - succeeded } };
}

/* --------------------------------------------------------- MCP wiring */

function opsFor(endpoint) {
  return Object.entries(OPS).filter(([, op]) => endpoint === 'any' || op.endpoint === endpoint).map(([n]) => n);
}

const INPUT_SCHEMA = (endpoint) => ({
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      description: `Operation to run. One of: ${opsFor(endpoint).join(', ')}`,
    },
    params: { type: 'object', description: 'Operation parameters — discover with introspect on the READ endpoint.' },
    operations: {
      type: 'array',
      description: 'Batch mode: [{operation, params}, …] processed in order. Provide either operation or operations.',
      items: { type: 'object' },
    },
  },
});

function toolList() {
  if (SINGLE) {
    return [{
      name: 'mcp_aql',
      description: 'Project Atlas via MCP-AQL (Single mode): all operations through one endpoint. ' +
        'Facts are read-only; judgments written here are stamped via:"mcp". Start with ' +
        '{operation:"introspect", params:{query:"operations"}}.',
      inputSchema: INPUT_SCHEMA('any'),
    }];
  }
  const DESC = {
    create: 'Additive Atlas operations: add_tag, add_note (append). Never destructive.',
    read: 'Read-only Atlas queries: introspect (start here), list_projects, get_project, list_untriaged, list_duplicates, get_counts, get_refresh_state, get_prefs, get_version.',
    update: 'Modify judgments and view state — never facts: set_status/priority/visibility/provenance/note/aka, update_prefs (drives every open page live). Writes are stamped via:"mcp".',
    delete: 'Remove judgment data only: remove_tag, clear_verdict. inventory facts are untouchable.',
    execute: 'Runtime, non-idempotent: refresh (minutes — warn the user), reveal_in_finder. Keep behind explicit approval.',
  };
  return ENDPOINTS.map((e) => ({
    name: `mcp_aql_${e}`,
    description: `Project Atlas ${e.toUpperCase()} endpoint (MCP-AQL). ${DESC[e]}`,
    inputSchema: INPUT_SCHEMA(e),
  }));
}

async function handleToolCall(name, args) {
  let endpoint = null;
  if (SINGLE && name === 'mcp_aql') endpoint = 'any';
  else if (!SINGLE && name.startsWith('mcp_aql_')) {
    const e = name.slice('mcp_aql_'.length);
    if (ENDPOINTS.includes(e)) endpoint = e;
  }
  if (!endpoint) return fail('UNKNOWN_TOOL', `No tool named "${name}".`);

  const a = args || {};
  if (Array.isArray(a.operations)) {
    if (a.operation) return fail('VALIDATION_ERROR', 'Provide either operation or operations, not both.');
    return dispatchBatch(endpoint, a.operations);
  }
  if (!a.operation) return fail('VALIDATION_ERROR', 'Missing "operation" (or "operations" for batch).');
  return dispatch(endpoint, a.operation, a.params);
}

/* JSON-RPC 2.0 over stdio, newline-delimited — the MCP stdio transport. */

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not ours to answer: no id to answer to
  }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'project-atlas', version: VERSION },
    });
  }
  if (method === 'notifications/initialized' || String(method || '').startsWith('notifications/')) {
    return; // notifications get no response
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: toolList() });
  if (method === 'tools/call') {
    const result = await handleToolCall(params && params.name, params && params.arguments);
    return reply(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: !result.success,
    });
  }
  if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
});

rl.on('close', () => process.exit(0));
