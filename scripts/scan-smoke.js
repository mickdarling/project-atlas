#!/usr/bin/env node
'use strict';

/**
 * Scanner regression: linked Git worktrees collapse into their primary
 * checkout, while an independent clone of the same remote remains a duplicate
 * tile. Runs entirely under temporary root and data directories.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-scan-smoke-'));
const ROOT = path.join(FIXTURE, 'root');
const DATA = path.join(FIXTURE, 'data');
const REPO = path.join(ROOT, 'repo');
const WORKTREE = path.join(ROOT, 'repo-worktree');
const COPY = path.join(ROOT, 'repo-copy');
const REMOTE = 'https://github.com/example/atlas-fixture.git';

function run(command, args, cwd = FIXTURE, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  fs.mkdirSync(ROOT, { recursive: true });
  run('git', ['init', '-b', 'main', REPO]);
  run('git', ['config', 'user.name', 'Atlas Test'], REPO);
  run('git', ['config', 'user.email', 'atlas@example.test'], REPO);
  fs.writeFileSync(path.join(REPO, 'README.md'), '# fixture\n');
  run('git', ['add', 'README.md'], REPO);
  run('git', ['commit', '-m', 'Initial fixture'], REPO);
  run('git', ['remote', 'add', 'origin', REMOTE], REPO);

  run('git', ['worktree', 'add', '-b', 'feature/worktree', WORKTREE], REPO);
  fs.writeFileSync(path.join(WORKTREE, 'dirty.txt'), 'uncommitted\n');

  run('git', ['clone', REPO, COPY]);
  run('git', ['remote', 'set-url', 'origin', REMOTE], COPY);

  run(process.execPath, [path.join(__dirname, '..', 'scan.js'), '--no-github'], FIXTURE, {
    ...process.env,
    ATLAS_ROOT: ROOT,
    ATLAS_DATA: DATA,
  });

  const inventory = JSON.parse(fs.readFileSync(path.join(DATA, 'inventory.json'), 'utf8'));
  assert(inventory.counts.total === 2, `total ${inventory.counts.total}, expected 2`);
  assert(inventory.counts.local === 2, `local ${inventory.counts.local}, expected 2`);
  assert(inventory.counts.duplicateClones === 1,
    `duplicate clones ${inventory.counts.duplicateClones}, expected 1`);
  assert(inventory.counts.linkedWorktrees === 1,
    `linked worktrees ${inventory.counts.linkedWorktrees}, expected 1`);

  const primary = inventory.repos.find((repo) => repo.path === 'repo');
  const copy = inventory.repos.find((repo) => repo.path === 'repo-copy');
  assert(primary, 'primary checkout missing from inventory');
  assert(copy, 'independent clone missing from inventory');
  assert(!inventory.repos.some((repo) => repo.path === 'repo-worktree'),
    'linked worktree incorrectly emitted as its own project');
  assert(primary.worktreeCount === 2, `worktree count ${primary.worktreeCount}, expected 2`);
  assert(primary.dirtyFiles === 1, `aggregate dirty files ${primary.dirtyFiles}, expected 1`);
  assert(primary.worktrees.map((wt) => wt.path).sort().join(',') === 'repo,repo-worktree',
    'worktree paths were not retained on the primary checkout');
  assert(copy.worktreeCount === 1, 'independent clone should have one worktree');
  assert(inventory.repos.filter((repo) => repo.slug === 'example/atlas-fixture').length === 2,
    'independent clone should remain a second tile for the shared remote');

  process.stdout.write('scan smoke ok\n');
} catch (err) {
  process.stderr.write(`SCAN SMOKE FAIL: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(FIXTURE, { recursive: true, force: true });
}
