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

## Installed as a local app

`./scripts/install.sh` sets up three things (re-runnable after any change):

- **Server LaunchAgent** (`com.mickdarling.project-atlas`) — KeepAlive, starts at
  login, restarts if it dies. The dashboard is simply always at
  `http://127.0.0.1:4317`.
- **Daily-scan LaunchAgent** (`com.mickdarling.project-atlas-scan`) — re-harvests
  at 07:00 so the map opens fresh. Facts only; it can never touch `verdicts.json`.
- **`~/Applications/Atlas.app`** — Dock-able launcher: makes sure the agent is up,
  opens the dashboard.
- **Menu bar app** (`AtlasMenu.app`, the ⊞ icon) — native Swift, compiled by the
  installer, no dependencies. Status at a glance **with its date** ("178 projects
  · 2,813 open issues · updated 2 hr. ago"), **Open Dashboard**, **Update Now**,
  **Stop/Start Server**, and the full view configuration: Group By, Color By,
  Accent By, Area, Palette, Scale, Worked On, Showing, Theme — plus **Map Only**
  and **Share Mode**. The icon itself reports state without opening the panel:
  the plain grid when data is fresh, rotating arrows while a scan runs, a
  clock-with-exclamation when the inventory is over a day old (the scan is
  daily, so stale means something's wrong), dimmed when the server is down.
  A 60 s background poll keeps it honest.

### How the menu bar drives the page

The server holds `data/prefs.json` (view state only — never judgments) and streams
changes over Server-Sent Events. The menu bar POSTs a pref; every open page hears
it and applies it live; the page pushes its own toolbar changes back up the same
channel, so the menu's checkmarks stay honest. Echo loops are broken by a no-op
guard — applying a state you're already in does nothing.

**Map Only** is the payoff: configuration lives in the menu bar, so the page can
be nothing but the map on a big screen. A faint floating `⚙ controls` button is
the way back from the page itself. Rescans triggered from the menu (or the 07:00
agent) soft-refresh every open page when they finish — new facts, same view
state, no reload.

### Updating the app

"Update" means the app's own code — a *refresh* re-harvests content, and the two
words never cross. When the panel opens, the server compares the running checkout
against `origin/main` (cached ~30 minutes). If new commits exist, the panel shows
"App update available (N commits)" with an **Update App** button. Confirming runs
`git pull --ff-only` plus the same `scripts/install.sh` a manual install uses,
then the server and menu bar app restart on the new code (`update.log` in the
logs directory records it). Fast-forward only: a diverged local checkout is
reported, never merged. When the install is current, nothing is shown at all.

Logs land in `~/Library/Logs/project-atlas/`. To uninstall:
`launchctl bootout gui/$UID/com.mickdarling.project-atlas{,-scan}` and delete the
plists from `~/Library/LaunchAgents`.

### Why this can't be cloud-hosted (and doesn't need to be)

A browser page is sandboxed from the local filesystem no matter where it's served
from — hosting it remotely makes local access *less* possible, not more. And the
harvester's real work isn't reading files, it's **executing** `git` and `gh`
against a hundred working copies, which no hosted page can ever do. The local
server isn't a workaround; it's the correct shape. Bonus: page and server both
local means nothing ever leaves the machine.

## The one rule that makes this survive

**Two data layers, never mixed.**

| File | What it is | Who writes it |
|---|---|---|
| `data/inventory.json` | Harvested facts — commits, dates, issues, PRs, forks, remotes | `scan.js`, every time |
| `data/verdicts.json` | Your judgments — status, priority, hidden, tags, notes | The web page, only |

`scan.js` never touches `verdicts.json`. Re-run the scan as often as you like; your
judgments are never clobbered.

**Everything under `data/` stays on your machine.** The generator is public; what it
generates — the inventory of your repos, your judgments, your identity aliases — is
about *your* portfolio and is gitignored, never pushed. `verdicts.json` is the one
file that can't be regenerated, so back it up somewhere private (the **Export**
button downloads it; a private gist or your own backups both work).

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

**Area** defaults to `√ work by you` — commits **plus changed lines ÷ 100**, both
attributed to you personally. Commit count alone lies twice: a fork of Zulip is
67,855 commits of somebody else's work, and a dense project can be nine commits and
six thousand hand-written lines. Counting both, seven tiny edits and one 3,000-line
commit are both real sessions.

Three guardrails keep *data* from impersonating *work*: any single file changed by
more than 5,000 lines in one commit is skipped (generated output — nobody types
that), lockfiles are skipped, and churn credit caps at 2,000 lines per commit, so a
one-commit archive import scores as an event, not a body of work. The alternatives
(`√ commits by you`, `√ all commits`, linear, issues, files, equal) are all still
there, and every option carries a hover definition saying exactly what it measures.

**Color** has six modes. Recency is the default — a single-hue ramp, pale for "two
years ago" through dark for "this week".

`Mine vs outside × recency` is the bivariate one: **hue** says whose the project is
(blue yours, orange a fork, green someone else's clone) and **lightness** says how
recently you touched it. Three hues, which is exactly the all-pairs colour-vision
ceiling — a fourth could not be told apart reliably, so there isn't one.

`Open issues` matters here more than it looks: 2,806 of them across the portfolio,
860 on `mcp-server` alone. If issues are where ideas land, this is the idea map.
Size by issues too and the map reorganizes around thinking rather than typing.

### Palettes: pick two colours

The **Palette** control takes a low colour and a high colour — Red → Green,
Red → Blue, Amber → Violet, or the same hue twice for a classic single-hue ramp.
Nine anchors, so 81 combinations, and **all 81 pass validation in both light and
dark**. Ramps are generated at runtime in OKLCH and snapped to a passing chroma:
high chroma clips against the sRGB gamut at the ends, squashing the lightness steps
together, so chroma walks down until the shape checks pass.

The badge next to the picker runs the real checks — the same maths and the same
Machado colour-vision matrices the offline validator uses — and says what it finds.
Hover it for the numbers.

**Red → Green is offered, and it is safe here**, which is not the usual answer. It
works because lightness moves monotonically from end to end, so the ramp still reads
as a ramp when hue is gone: the two ends measure ΔE 34.9 apart under protanopia.
A red→green scale with *constant* lightness — the spreadsheet default — would be
unreadable, and the badge would say so.

### Counting commits honestly

`commits` is `git rev-list --count --all` — every ref the clone knows about. Counting
`HEAD` instead reports whatever branch happened to be checked out, which is a fact
about your last `git switch`, not about the project. The gap is not small:
`mcp-server` is 2,933 on its current branch and **4,090** across all refs. The panel
shows all three numbers (all refs, this branch, GitHub's default branch) so a
surprising figure can be traced.

### Duplicate working copies

Several folders can hold clones of one GitHub repo — backups, review checkouts,
archived snapshots. Nine slugs here do; `DollhouseMCP/mcp-server` has four.

Each gets its own tile, keyed by **path**, because a slug is not unique. The clone
with the most history is primary and carries the GitHub metadata; the rest are
marked `⧉` and report no issue count, so four copies of one repo can't report its
860 issues four times. They're prime candidates for hiding.

The panel makes that actionable: open any copy and the ⧉ note lists **every**
working copy of the slug — path, commit count, last work, which is primary, and a
badge on backup-looking paths (`*backup*`, `*archive*`, `-old`, `copy`). Each
non-primary copy gets one-click **Hide as duplicate** (files it away with the
reason "duplicate", reversible right there or via Showing → Only hidden) and
**Reveal in Finder**. Deleting a folder stays a human act in Finder — the tool
flags and files, it never rms. **Group by → Duplicate clusters** turns the whole
set into per-slug groups so all of them can be resolved in one sitting.

### Focus: pick what you want to see

Click an organization's header and it expands to fill the map. Everything else
**minimizes to a dock along the bottom** — not hidden, still named, one click from
coming back. That is the difference between focus and a trapdoor: because the others
are still on screen, you can add a second organization, and a third.

Click a focused header to send it back to the dock; **show all** in the toolbar chip
clears everything. Focus is remembered per grouping mode, because "DollhouseMCP"
means nothing once you regroup by language. It is view state, so it lives in
localStorage and never touches `verdicts.json`.

### Type is fitted, not estimated

A first guess is computed from measured glyph widths, then **the browser is asked
what it actually did** and anything that overflowed is shrunk — reads and writes
batched into separate phases so the whole map costs a handful of reflows rather than
one per tile.

This matters because no formula models CSS wrapping. `awesome-mcp-servers` in a 44px
box wants five ragged lines where width ÷ box predicts three; hyphens are break
opportunities and the last line of each run is short. Estimation was leaving labels
clipped mid-word.

At the 4px floor a box is simply too small to label, and the name is removed rather
than cut off — the tile is still hoverable and clickable. Group headers get the same
treatment, solved for the name and its count pill together.

### Scale: normalized to what you're looking at

Fixed age brackets flatten a set that is all recent or all ancient — everything lands
in one bucket and the map goes one colour, which is what "everything's red" was.

So **Scale → Auto** spreads the ramp across the projects actually on screen, using
equal-frequency bins so every step gets used. Focus one org and the colours
re-normalize to that org's own history — 176 projects becomes 58. The legend always
names the real dates at the ends, so a colour still means something you can act on.
**Scale → Fixed** restores absolute brackets.

**Anything too small to draw is named, not dropped.** A silent omission reads as
"nothing there", so the legend reports the count and lists them on hover.

**Borders carry provenance and location** so the color channel stays free:
dashed = local only, dotted = not cloned.

### Corner glyphs

Hover any tile's glyph cluster (or the legend's glyph note) and each one is
explained in place. The full table:

| glyph | means |
|---|---|
| `✱` | uncommitted changes sitting on disk |
| `↑` | commits not pushed to any remote |
| `▤` | archived on GitHub |
| `⧉` | second working copy — another clone carries this repo's stats |
| `✎` | provenance set by hand |
| `▁ ▄ █` | priority low / medium / high |
| `◌` / `⊘` | hidden / ignored |
| `● ▣ ◔ ✓ ✕` | status: active / in use / someday / done / dead |

### Group by status is a triage queue

Status is your call, so most repos start untriaged — and one giant "Unsorted" blob
says nothing. Grouping by status splits the untriaged by recency instead:
*touched in last 3 months* / *quiet this year* / *cold for a year+* / *archived on
GitHub*. Cold ones are quick kills (`x` dead, `s` someday); recently-touched ones
probably deserve `a`. Status and priority colours step a **single** hue (the
palette's high end) so the ladder reads as a ladder, not five categories.

**Provenance** is detected, not guessed: GitHub's fork flag, the remote's owner
against your org list, and per-author commit attribution.

## Triage

Click any tile. Or select one and use the keyboard:

| key | does |
|---|---|
| `1` `2` `3` | priority low / medium / high |
| `0` | clear priority |
| `a` | active |
| `u` | **in use, not developed** — you run it, you don't work on it |
| `s` | someday |
| `d` | done |
| `x` | dead |
| `h` | hide — off my screen for now |
| `i` | ignore — not my project, stop counting it |
| `p` | pin the panel |
| `esc` | close the panel |

### Triage mode: the untriaged set as a card pass

Judging 170 repos by clicking tiles one at a time is a chore nobody finishes. The
**Triage** button turns it into a card pass: every untriaged, visible project, one
at a time, **coldest first** — cold ones are the quick kills. Each card carries
what a 5-second call needs: last work, your commits and lines, open issues,
description, top authors.

The keys above judge and advance. **Space or enter skips** — skips are free,
triage never forces a judgment. **`z` undoes** the last judgment, skip, or batch.
`1`–`3` set priority without advancing. When one org's remainder is all dead,
the "rest of this org is dead (N)" button does it in one stroke — it arms on the
first click and fires on the second, and `z` takes the whole batch back. Verdicts
stay one-at-a-time appends to `verdicts.json`; the map behind the card recolours
live as you work.

### Worked on: filter by date

Recency is also a *filter*, not just a colour. The **Worked on** control keeps
only projects touched in the last week / 30 / 90 / 365 days — or the inverse,
**quiet 1 year + / 2 years +**, the graveyard view. It reads `lastActivity`, the
same field recency colour reads, so the filter and the colour can never disagree.
The auto scale then re-spreads the ramp across whatever survives.

### Share mode: the shape without the names

The map is worth showing people, but tile names, orgs, paths and descriptions
reveal private work. **Share** keeps the picture and drops the identities:
private repos become stable pseudonyms (`project-k3f2` — hashed from the repo's
key, so it reads the same in every screenshot and after every rescan), private
orgs become `org-xyz`, and descriptions, paths, notes, tags, authors and
hide-reasons vanish from every surface. Public repos keep their real names —
they're on GitHub anyway — and the numbers stay, because numbers are the point
of sharing. Compose with **map only** for a clean screenshot.

### Accent: a second variable per tile

**Accent by** draws a folder-tab strip along each tile's top edge carrying a
second encoding — recency, issues, status, priority, provenance, or the
**research flag** (topics/tags saying research / paper / results / findings).
Off by default: one variable is the right default, two is a choice. The tab's
hue pair is picked to avoid the fill's, a 1px separator keeps the two touching
encodings apart, and the palette badge vouches for both ramps — including a
fill-vs-tab check under every colour-vision simulation, because two adjacent
ramps interact in ways each-alone validation misses.

### Nothing you file away becomes unreachable

A one-way hide is a trap: the moment you use it, the thing you filed becomes
invisible to the tool that filed it, so you stop using it at all.

So visibility is a **first-class, sortable field** — `visible` / `hidden` / `ignored`
— not a boolean. The **Showing** control in the toolbar has `Only hidden + ignored`,
`Only hidden`, and `Only ignored`. You can group the map by it, sort the table
column by it, and the reason you typed when filing something is searchable. Hidden
tiles dim; ignored tiles dim and desaturate.

### Correcting provenance by hand

Detection is not always right — GitHub doesn't flag `docker-zulip` as a fork, so it
scored as 1,000 commits of your work. The panel's **Provenance** control overrides
the detected value, and calling something not-yours ticks *don't count its commits as
my work*, which drops its area to nothing. Untick it if you did do the work.
Overridden tiles carry a `✎`.

Status is ordinal — "how alive is this" — so it's one hue stepped by liveness rather
than five competing hues, with the glyph carrying exact identity. Five adjacent
categorical hues cannot clear the colour-vision gates on a treemap where every tile
touches every other; a validated ordinal ramp can.

The panel **pushes the map aside instead of covering it**, so you can still see what
you're comparing against. Unpinned it closes when you click away; pinned it stays
and swaps content as you select tiles. `esc` closes it either way.

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

Check that list. In the first real portfolio this ran against, one machine-local git
email (`user@machine.local` style) was worth 1,759 commits and made "% yours" lie on
the biggest repos. Add any aliases that are also you and re-run the scan. This file
is gitignored — it holds your emails and other people's, and stays local.

## Accessibility

Every palette here was validated by script, not eyeballed. The eight ramps in
`public/ramps.js` are generated: each hue's chroma is walked down until the ramp
passes the ordinal checks (lightness monotone, adjacent ΔL ≥ 0.06, pale end clears
2:1 against the surface, single hue) in **both** light and dark. Regenerate them
rather than hand-editing. Categorical use is capped at three slots, all-pairs,
both modes — the documented ceiling, and the reason status is ordinal rather than
five hues.

Identity never rests on color alone: every tile carries
its name, a glyph, and a tooltip, and a full table view (`Table` button, sortable)
mirrors the map. Light and dark are separately stepped ramps, not an inverted filter.

## Layout

```
scan.js            harvester — filesystem walk + gh GraphQL, writes inventory.json
server.js          127.0.0.1 static server + verdicts read/write + reveal-in-Finder
public/index.html  structure
public/style.css   palette roles, both themes
public/app.js      squarified treemap, encodings, triage panel, table view
public/ramps.js    GENERATED — 8 validated sequential ramps, light and dark
data/identity.json which commits count as yours (yours to edit)
data/verdicts.json your judgments (LOCAL ONLY, gitignored — export to back up)
data/inventory.json harvested facts (gitignored, regenerate any time)
```

No dependencies. Node 18+ and the `gh` CLI, authenticated.
