#!/usr/bin/env node
'use strict';

/**
 * Harvester. Produces data/inventory.json.
 *
 * This file writes ONLY facts. It never touches data/verdicts.json — that file
 * holds your judgments and is the one thing here that can't be regenerated.
 * Re-run this as often as you like.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.ATLAS_ROOT || path.join(process.env.HOME, 'Developer');
const DATA_DIR = path.join(__dirname, 'data');
const OUT = path.join(DATA_DIR, 'inventory.json');
const IDENTITY = path.join(DATA_DIR, 'identity.json');

const MAX_DEPTH = 7;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'Pods', '.venv', 'venv', 'env',
  'dist', 'build', 'out', '.next', '.nuxt', 'target', 'DerivedData',
  '.cache', '__pycache__', '.tox', '.gradle', 'Library', '.Trash',
  'bower_components', '.pnpm-store', 'coverage',
]);

const args = process.argv.slice(2);
const SKIP_GITHUB = args.includes('--no-github');
const VERBOSE = args.includes('--verbose');

function log(...m) { process.stderr.write(m.join(' ') + '\n'); }
function vlog(...m) { if (VERBOSE) log(...m); }

/* ------------------------------------------------------------------ *
 * 1. Walk the filesystem for git repos
 * ------------------------------------------------------------------ */

function findRepos(dir, depth, found) {
  if (depth > MAX_DEPTH) return found;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  // A .git entry (dir for normal repos, file for worktrees/submodules)
  // marks this directory as a repo root. Don't descend past it — nested
  // repos inside a checkout are vendored code, not separate projects.
  if (entries.some((e) => e.name === '.git')) {
    found.push(dir);
    return found;
  }

  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    findRepos(path.join(dir, e.name), depth + 1, found);
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * 2. Per-repo git facts — one subprocess per repo, not one per fact
 * ------------------------------------------------------------------ */

const GIT_PROBE = `
cd "$1" 2>/dev/null || exit 0
export GIT_PAGER=cat
echo "head=$(git rev-parse HEAD 2>/dev/null)"
# --all counts every ref this clone knows about. Counting HEAD alone reports
# whatever branch happens to be checked out, which is not a property of the project.
echo "commits=$(git rev-list --count --all 2>/dev/null)"
echo "commitsHead=$(git rev-list --count HEAD 2>/dev/null)"
echo "last=$(git log -1 --format=%cI --all 2>/dev/null)"
echo "first=$(git log --reverse --format=%cI --all 2>/dev/null | head -1)"
echo "branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
echo "origin=$(git remote get-url origin 2>/dev/null)"
echo "remotes=$(git remote 2>/dev/null | tr '\\n' ',')"
echo "dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
echo "c30=$(git log --since=30.days.ago --oneline --all 2>/dev/null | wc -l | tr -d ' ')"
echo "c90=$(git log --since=90.days.ago --oneline --all 2>/dev/null | wc -l | tr -d ' ')"
echo "c365=$(git log --since=365.days.ago --oneline --all 2>/dev/null | wc -l | tr -d ' ')"
echo "unpushed=$(git log --branches --not --remotes --oneline 2>/dev/null | wc -l | tr -d ' ')"
echo "tracked=$(git ls-files 2>/dev/null | wc -l | tr -d ' ')"
echo "localBranches=$(git for-each-ref --format='%(refname)' refs/heads 2>/dev/null | wc -l | tr -d ' ')"
echo "--authors--"
git --no-pager shortlog -sne --all 2>/dev/null
echo "--churn--"
# Lines added+deleted per author email, across all refs. Commit count alone
# under-measures dense work: one commit with 3,000 lines is not one unit.
# Guardrails so DATA cannot impersonate WORK: skip any single file changed by
# more than 5,000 lines in one commit (generated output, data dumps — nobody
# hand-writes that), and skip lockfiles.
git --no-pager log --all --format='@%ae' --numstat 2>/dev/null | awk '
  /^@/ { e = tolower(substr($0, 2)); next }
  NF >= 3 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && ($1 + $2) <= 5000 \
    && $3 !~ /package-lock\.json|yarn\.lock|pnpm-lock|Cargo\.lock|\.min\.js$|\.map$/ \
    { a[e] += $1 + $2 }
  END { for (k in a) printf "%d %s\\n", a[k], k }'
`;

function probeRepo(dir) {
  let out;
  try {
    out = execFileSync('/bin/sh', ['-c', GIT_PROBE, 'probe', dir], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    vlog('  probe failed:', dir, err.message);
    return null;
  }

  const [kvPart, rest = ''] = out.split('--authors--');
  const [authorPart = '', churnPart = ''] = rest.split('--churn--');
  const kv = {};
  for (const line of kvPart.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }

  const authors = [];
  for (const line of authorPart.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*?)\s+<(.*)>\s*$/);
    if (m) authors.push({ commits: +m[1], name: m[2], email: m[3].toLowerCase() });
  }

  const churnByEmail = new Map();
  for (const line of churnPart.split('\n')) {
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (m) churnByEmail.set(m[2].trim(), +m[1]);
  }

  return { kv, authors, churnByEmail };
}

/* ------------------------------------------------------------------ *
 * 3. Remote URL -> owner/name
 * ------------------------------------------------------------------ */

function parseRemote(url) {
  if (!url) return null;
  let m =
    url.match(/^git@([^:]+):(.+?)(?:\.git)?$/) ||
    url.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/) ||
    url.match(/^https?:\/\/(?:[^@]*@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  const host = m[1];
  const parts = m[2].split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { host, owner: parts[0], name: parts[1], slug: `${parts[0]}/${parts[1]}` };
}

/* ------------------------------------------------------------------ *
 * 4. GitHub side
 * ------------------------------------------------------------------ */

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const REPO_FIELDS = `
  nameWithOwner
  name
  url
  description
  isFork
  isArchived
  isPrivate
  isEmpty
  isTemplate
  createdAt
  pushedAt
  diskUsage
  stargazerCount
  forkCount
  parent { nameWithOwner }
  primaryLanguage { name }
  repositoryTopics(first: 12) { nodes { topic { name } } }
  issues(states: OPEN) { totalCount }
  pullRequests(states: OPEN) { totalCount }
  defaultBranchRef {
    name
    target { ... on Commit { committedDate history { totalCount } } }
  }
`;

const OWNER_QUERY = `
query($login: String!, $cursor: String) {
  repositoryOwner(login: $login) {
    __typename
    repositories(first: 25, after: $cursor, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${REPO_FIELDS} }
    }
  }
}`;

function fetchOwnerRepos(login) {
  const repos = [];
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const a = ['api', 'graphql', '-f', `query=${OWNER_QUERY}`, '-F', `login=${login}`];
    if (cursor) a.push('-F', `cursor=${cursor}`);
    let raw;
    try {
      raw = gh(a);
    } catch (err) {
      log(`  ! GraphQL failed for ${login}: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
      break;
    }
    const json = JSON.parse(raw);
    const owner = json.data && json.data.repositoryOwner;
    if (!owner) break;
    repos.push(...owner.repositories.nodes);
    if (!owner.repositories.pageInfo.hasNextPage) break;
    cursor = owner.repositories.pageInfo.endCursor;
  }
  return repos;
}

function normalizeGh(r) {
  const target = r.defaultBranchRef && r.defaultBranchRef.target;
  return {
    slug: r.nameWithOwner,
    owner: r.nameWithOwner.split('/')[0],
    name: r.name,
    url: r.url,
    description: r.description || '',
    isFork: r.isFork,
    forkOf: r.parent ? r.parent.nameWithOwner : null,
    isArchived: r.isArchived,
    isPrivate: r.isPrivate,
    isEmpty: r.isEmpty,
    createdAt: r.createdAt,
    pushedAt: r.pushedAt,
    diskKB: r.diskUsage || 0,
    stars: r.stargazerCount,
    forks: r.forkCount,
    language: r.primaryLanguage ? r.primaryLanguage.name : null,
    topics: (r.repositoryTopics.nodes || []).map((n) => n.topic.name),
    openIssues: r.issues.totalCount,
    openPRs: r.pullRequests.totalCount,
    defaultBranch: r.defaultBranchRef ? r.defaultBranchRef.name : null,
    remoteCommits: target && target.history ? target.history.totalCount : 0,
    remoteLastCommit: target ? target.committedDate : null,
  };
}

/* ------------------------------------------------------------------ *
 * 5. Identity — which commits count as yours
 * ------------------------------------------------------------------ */

function readIdentity() {
  try {
    const raw = JSON.parse(fs.readFileSync(IDENTITY, 'utf8'));
    return {
      emails: Array.isArray(raw.emails) ? raw.emails : [],
      names: Array.isArray(raw.names) ? raw.names : [],
    };
  } catch {
    return { emails: [], names: [] };
  }
}

function seedIdentity(emails, names, unmatched) {
  if (fs.existsSync(IDENTITY)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    IDENTITY,
    JSON.stringify(
      {
        _comment:
          'Every email and name here counts as you when computing "% yours". ' +
          'Add machine-local git emails, old addresses, and name spellings. ' +
          'Then re-run `npm run scan`.',
        emails: [...emails].sort(),
        names: [...names].sort(),
        _unmatchedAuthorsSeen: unmatched,
      },
      null,
      2
    ) + '\n'
  );
  log(`Seeded ${IDENTITY} — edit it if any of the authors below are also you.`);
}

/* ------------------------------------------------------------------ *
 * 6. Assemble
 * ------------------------------------------------------------------ */

function main() {
  const startedAt = new Date().toISOString();

  log(`Scanning ${ROOT} ...`);
  const dirs = findRepos(ROOT, 0, []);
  log(`  found ${dirs.length} local git repos`);

  const locals = [];
  let done = 0;
  for (const dir of dirs) {
    const probed = probeRepo(dir);
    done++;
    if (done % 20 === 0) log(`  probed ${done}/${dirs.length}`);
    if (!probed) continue;
    const { kv, authors, churnByEmail } = probed;
    const remote = parseRemote(kv.origin);
    locals.push({
      path: path.relative(ROOT, dir),
      absPath: dir,
      dirName: path.basename(dir),
      remoteUrl: kv.origin || null,
      remote,
      head: kv.head || null,
      commits: +kv.commits || 0,
      commitsHead: +kv.commitsHead || 0,
      localBranches: +kv.localBranches || 0,
      firstCommitDate: kv.first || null,
      lastCommitDate: kv.last || null,
      branch: kv.branch || null,
      dirtyFiles: +kv.dirty || 0,
      commits30d: +kv.c30 || 0,
      commits90d: +kv.c90 || 0,
      commits365d: +kv.c365 || 0,
      unpushedCommits: +kv.unpushed || 0,
      trackedFiles: +kv.tracked || 0,
      authors,
      churnByEmail,
    });
  }

  // Identity: whose commits count as "mine".
  // data/identity.json is yours to edit — one machine-local git email
  // (mick@themachine.local and friends) is enough to make "% yours" lie.
  let myLogin = null;
  const identity = readIdentity();
  const myEmails = new Set(identity.emails.map((e) => e.toLowerCase()));
  const myNames = new Set(identity.names.map((n) => n.toLowerCase()));
  try {
    myEmails.add(execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8' }).trim().toLowerCase());
  } catch { /* no global email configured */ }
  try {
    myNames.add(execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim().toLowerCase());
  } catch { /* no global name configured */ }

  let owners = [];
  let ghRepos = [];
  if (!SKIP_GITHUB) {
    try {
      myLogin = gh(['api', 'user', '--jq', '.login']).trim();
      const orgs = gh(['api', 'user/orgs', '--jq', '.[].login']).trim().split('\n').filter(Boolean);
      owners = [myLogin, ...orgs];
      log(`GitHub owners: ${owners.join(', ')}`);
      for (const o of owners) {
        const rs = fetchOwnerRepos(o);
        log(`  ${o}: ${rs.length} repos`);
        ghRepos.push(...rs.map(normalizeGh));
      }
      try {
        const emails = JSON.parse(gh(['api', 'user/emails']));
        for (const e of emails) myEmails.add(String(e.email).toLowerCase());
      } catch { /* email scope not granted; global git email is enough */ }
    } catch (err) {
      log('! GitHub harvest skipped: ' + String(err.stderr || err.message).trim().split('\n')[0]);
    }
  }

  if (myLogin) myNames.add(myLogin.toLowerCase());

  const isMyAuthor = (a) =>
    myEmails.has(a.email) || myNames.has(String(a.name || '').toLowerCase());

  const ownerSet = new Set(owners.map((o) => o.toLowerCase()));
  const ghBySlug = new Map(ghRepos.map((r) => [r.slug.toLowerCase(), r]));

  const merged = new Map();

  function isMine(local, remoteRec) {
    if (remoteRec && ownerSet.has(remoteRec.owner.toLowerCase())) return true;
    if (local && local.remote && ownerSet.has(local.remote.owner.toLowerCase())) return true;
    return false;
  }

  // Several working copies can point at one GitHub repo (backups, review
  // checkouts, archived snapshots). They are separate things on disk and each
  // gets its own tile — keyed by path, because a slug is not unique.
  // The clone with the most history is "primary" and carries the GitHub
  // metadata; the others would otherwise double-count issues and PRs.
  const slugToLocals = new Map();
  for (const l of locals) {
    const s = l.remote && l.remote.host.includes('github.com') ? l.remote.slug : null;
    if (!s) continue;
    if (!slugToLocals.has(s)) slugToLocals.set(s, []);
    slugToLocals.get(s).push(l);
  }
  for (const list of slugToLocals.values()) {
    list.sort((a, b) => b.commits - a.commits || a.path.localeCompare(b.path));
  }
  const claimedSlugs = new Set([...slugToLocals.keys()].map((s) => s.toLowerCase()));

  // Local repos first — they carry the real commit history
  for (const l of locals) {
    const slug = l.remote && l.remote.host.includes('github.com') ? l.remote.slug : null;
    const g = slug ? ghBySlug.get(slug.toLowerCase()) : null;
    const siblings = slug ? slugToLocals.get(slug) : [l];
    const isPrimary = !slug || siblings[0] === l;

    const myCommits = l.authors.filter(isMyAuthor).reduce((s, a) => s + a.commits, 0);

    let churn = 0, myChurn = 0;
    for (const [email, lines] of l.churnByEmail || []) {
      churn += lines;
      if (myEmails.has(email)) myChurn += lines;
    }
    // A single "import everything" commit is an event, not a body of work.
    // Churn credit is capped at 2,000 lines per commit.
    churn = Math.min(churn, l.commits * 2000);
    myChurn = Math.min(myChurn, myCommits * 2000);

    let provenance;
    if (g && g.isFork) provenance = 'fork';
    else if (!l.remote) provenance = myCommits > 0 || l.commits > 0 ? 'mine' : 'unknown';
    else if (isMine(l, g)) provenance = 'mine';
    else provenance = 'external';

    const owner = (g && g.owner) || (l.remote && l.remote.owner) || null;

    const key = `local:${l.path}`;
    merged.set(key, {
      key,
      slug,
      clonesOfSlug: siblings.length,
      isPrimaryClone: isPrimary,
      duplicateOf: isPrimary ? null : `local:${siblings[0].path}`,
      name: (g && g.name) || (l.remote && l.remote.name) || l.dirName,
      dirName: l.dirName,
      owner,
      group: owner || 'Uncommitted / local-only',
      presence: g ? 'both' : 'local-only',
      provenance,
      path: l.path,
      absPath: l.absPath,
      remoteUrl: l.remoteUrl,
      remoteHost: l.remote ? l.remote.host : null,
      url: g ? g.url : null,
      description: g ? g.description : '',
      // Across every ref this clone knows about, not just the checked-out branch.
      commits: l.commits,
      commitsHead: l.commitsHead,
      remoteCommits: g ? g.remoteCommits : null,
      localBranches: l.localBranches,
      myCommits,
      myCommitShare: l.commits ? myCommits / l.commits : 0,
      // What YOU poured in, as opposed to what the repo contains. A 67k-commit
      // fork of someone else's project is not 67k commits of your work.
      effort: myCommits,
      churn,
      myChurn,
      firstCommitDate: l.firstCommitDate,
      lastCommitDate: l.lastCommitDate,
      // Only the primary clone borrows GitHub's push freshness. A backup copy
      // showing "yesterday" because the REAL repo was pushed yesterday reads
      // as a live project when it's actually a stale folder.
      lastActivity: maxDate(l.lastCommitDate, g && isPrimary ? g.pushedAt : null),
      branch: l.branch,
      defaultBranch: g ? g.defaultBranch : null,
      dirtyFiles: l.dirtyFiles,
      unpushedCommits: l.unpushedCommits,
      trackedFiles: l.trackedFiles,
      commits30d: l.commits30d,
      commits90d: l.commits90d,
      commits365d: l.commits365d,
      contributors: l.authors.length,
      topAuthors: l.authors.slice(0, 5),
      isFork: g ? g.isFork : false,
      forkOf: g ? g.forkOf : null,
      isArchived: g ? g.isArchived : false,
      isPrivate: g ? g.isPrivate : null,
      // Only the primary clone carries these, or four working copies of one
      // repo would report its issue count four times.
      openIssues: g && isPrimary ? g.openIssues : null,
      openPRs: g && isPrimary ? g.openPRs : null,
      stars: g && isPrimary ? g.stars : null,
      language: g ? g.language : null,
      topics: g ? g.topics : [],
      diskKB: g ? g.diskKB : null,
    });
  }

  // GitHub repos with no local clone
  for (const g of ghRepos) {
    const key = `gh:${g.slug}`;
    if (merged.has(key) || claimedSlugs.has(g.slug.toLowerCase())) continue;
    merged.set(key, {
      key,
      slug: g.slug,
      name: g.name,
      dirName: null,
      owner: g.owner,
      group: g.owner,
      presence: 'remote-only',
      provenance: g.isFork ? 'fork' : 'mine',
      path: null,
      absPath: null,
      remoteUrl: g.url,
      remoteHost: 'github.com',
      url: g.url,
      description: g.description,
      clonesOfSlug: 0,
      isPrimaryClone: true,
      duplicateOf: null,
      commits: g.remoteCommits,
      commitsHead: g.remoteCommits,
      remoteCommits: g.remoteCommits,
      localBranches: null,
      myCommits: null, // never cloned, so per-author attribution is unavailable
      myCommitShare: 0,
      // No clone to attribute against: credit a repo you own, credit a fork nothing.
      effort: g.isFork ? 0 : g.remoteCommits,
      churn: null, // needs a clone to measure
      myChurn: null,
      firstCommitDate: g.createdAt,
      lastCommitDate: g.remoteLastCommit || g.pushedAt,
      lastActivity: g.pushedAt || g.remoteLastCommit,
      branch: null,
      defaultBranch: g.defaultBranch,
      dirtyFiles: 0,
      unpushedCommits: 0,
      trackedFiles: null,
      commits30d: null,
      commits90d: null,
      commits365d: null,
      contributors: null,
      topAuthors: [],
      isFork: g.isFork,
      forkOf: g.forkOf,
      isArchived: g.isArchived,
      isPrivate: g.isPrivate,
      openIssues: g.openIssues,
      openPRs: g.openPRs,
      stars: g.stars,
      language: g.language,
      topics: g.topics,
      diskKB: g.diskKB,
    });
  }

  const repos = [...merged.values()].sort((a, b) => b.commits - a.commits);

  // Who is committing to repos you own that isn't recognised as you?
  const unmatchedTally = new Map();
  for (const l of locals) {
    const rec = merged.get(l.remote && l.remote.host.includes('github.com')
      ? `gh:${l.remote.slug}` : `local:${l.path}`);
    if (!rec || rec.provenance !== 'mine') continue;
    for (const a of l.authors) {
      if (isMyAuthor(a)) continue;
      if (/\[bot\]|noreply@anthropic|dependabot|github-actions/i.test(a.email)) continue;
      const k = `${a.name} <${a.email}>`;
      unmatchedTally.set(k, (unmatchedTally.get(k) || 0) + a.commits);
    }
  }
  const unmatched = [...unmatchedTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([who, commits]) => ({ who, commits }));

  seedIdentity(myEmails, myNames, unmatched);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: startedAt,
        finishedAt: new Date().toISOString(),
        root: ROOT,
        myLogin,
        owners,
        identity: { emails: [...myEmails].sort(), names: [...myNames].sort() },
        unmatchedAuthors: unmatched,
        counts: {
          total: repos.length,
          local: repos.filter((r) => r.presence !== 'remote-only').length,
          remote: repos.filter((r) => r.presence !== 'local-only').length,
          both: repos.filter((r) => r.presence === 'both').length,
          localOnly: repos.filter((r) => r.presence === 'local-only').length,
          remoteOnly: repos.filter((r) => r.presence === 'remote-only').length,
          duplicateClones: repos.filter((r) => r.duplicateOf).length,
          openIssues: repos.reduce((s, r) => s + (r.openIssues || 0), 0),
          openPRs: repos.reduce((s, r) => s + (r.openPRs || 0), 0),
        },
        repos,
      },
      null,
      2
    ) + '\n'
  );

  log('');
  log(`Wrote ${OUT}`);
  log(`  ${repos.length} projects  |  both: ${repos.filter((r) => r.presence === 'both').length}` +
      `  local-only: ${repos.filter((r) => r.presence === 'local-only').length}` +
      `  remote-only: ${repos.filter((r) => r.presence === 'remote-only').length}`);

  if (unmatched.length) {
    log('');
    log('Authors in YOUR repos not recognised as you (add real aliases to data/identity.json):');
    for (const u of unmatched.slice(0, 8)) log(`  ${String(u.commits).padStart(6)}  ${u.who}`);
  }
}

function maxDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

main();
