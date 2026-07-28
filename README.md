# Project Atlas

A WinDirStat-style treemap of **every project you have** — not the files inside one
repo, but the whole portfolio. One box per project, grouped by organization, sized
by how much you actually poured in, colored by how recently you touched it.

Then you triage it: done, active, someday, dead; high/medium/low priority; hide the
ones you don't want to look at, with a reason.

```
npm run scan     # harvest facts  -> data/inventory.json
npm run serve    # http://127.0.0.1:4317
npm start        # both
```

Nothing is exposed. The server binds to `127.0.0.1` and there is no outbound call
of any kind from the page.

## The one rule that makes this survive

**Two data layers, never mixed.**

| File | What it is | Who writes it |
|---|---|---|
| `data/inventory.json` | Harvested facts — commits, dates, issues, PRs, forks, remotes | `scan.js`, every time |
| `data/verdicts.json` | Your judgments — status, priority, hidden, tags, notes | The web page, only |

`scan.js` never touches `verdicts.json`. Re-run the scan as often as you like; your
judgments are never clobbered. `inventory.json` is gitignored because it regenerates;
`verdicts.json` is committed because it can't.

## What it scans

Both sides, reconciled by remote URL:

- **Local** — walks `$HOME/Developer` (override with `ATLAS_ROOT`) for git repos and
  reads commit counts, first/last commit, per-author attribution, uncommitted files,
  unpushed commits, branch.
- **GitHub** — every repo you own across every org you belong to, via `gh` GraphQL:
  open issues, open PRs, fork status and parent, archived, stars, language, topics.

The mismatch between the two is the point. Three states:

- `both` — cloned and pushed, the normal case
- `local-only` — **work on this machine that was never pushed anywhere**
- `remote-only` — on GitHub, not cloned here; usually means dormant

Run `npm run scan -- --no-github` to skip the API entirely and work offline.

## Reading the map

**Area** defaults to `√ commits by you`. Straight commit count is a bad measure of
your investment — a fork of Zulip is 67,855 commits of somebody else's work. So the
harvester computes an `effort` field: your own commits where a clone exists to
attribute against, and for never-cloned repos, the full count if you own it and zero
if it's a fork. The square root keeps small projects visible; the legend always
states which scale is active. Switch to `√ all commits` or linear `all commits` when
you want the unflattering truth.

**Color** defaults to recency — a single-hue sequential ramp, light for "two years
ago" through dark for "this week". You can also color by your status, provenance, or
priority.

**Borders carry provenance and location** so the color channel stays free:
dashed = local only, dotted = not cloned. Corner glyphs: `✱` uncommitted changes,
`↑` unpushed commits, `▤` archived, plus the status glyph and `!` priority marks.

**Provenance** is detected, not guessed: GitHub's fork flag, the remote's owner
against your org list, and per-author commit attribution.

## Triage

Click any tile. Or select one and use the keyboard:

| key | does |
|---|---|
| `1` `2` `3` | priority low / medium / high |
| `0` | clear priority |
| `d` `a` `s` `x` | done / active / someday / dead |
| `h` | hide (with an optional reason) |
| `esc` | close the panel |

Saves are debounced and land in `data/verdicts.json` within half a second.

### Verdicts go stale, and the page tells you

Every judgment records the newest commit that existed when you made it. When a repo
moves afterward, the panel says so:

> You last judged this Jul 28, 2026, when the newest commit was Jul 26, 2026.
> It has moved since — newest commit is now Jul 28, 2026.

This is the failure mode that kills these dashboards. Checkboxes rot silently; this
one shows its rot.

## Who counts as you

`data/identity.json` lists the emails and names that count as your commits. The first
scan seeds it from `git config` and the GitHub API, and appends
`_unmatchedAuthorsSeen` — the top authors in repos you own who weren't recognized.

Check that list. One machine-local git email (`mick@themachine.local`) was worth 1,759
commits and made "% yours" lie on the biggest repos. Add any that are also you and
re-run the scan.

## Accessibility

Categorical palettes are validated for color-vision deficiency, not eyeballed — three
slots, all-pairs, both modes. Identity never rests on color alone: every tile carries
its name, a glyph, and a tooltip, and a full table view (`Table` button, sortable)
mirrors the map. Light and dark are separately stepped ramps, not an inverted filter.

## Layout

```
scan.js            harvester — filesystem walk + gh GraphQL, writes inventory.json
server.js          127.0.0.1 static server + verdicts read/write + reveal-in-Finder
public/index.html  structure
public/style.css   palette roles, both themes
public/app.js      squarified treemap, encodings, triage panel, table view
data/identity.json which commits count as yours (yours to edit)
data/verdicts.json your judgments (committed)
data/inventory.json harvested facts (gitignored, regenerate any time)
```

No dependencies. Node 18+ and the `gh` CLI, authenticated.
