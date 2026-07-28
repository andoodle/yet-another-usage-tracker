# Yet Another Usage Tracker

A local, zero-dependency dashboard that paces your **weekly Claude Code usage**
so you don't burn the allowance by Wednesday. It reads the transcripts Claude
Code already writes to `~/.claude/projects/`, computes what share of your weekly
allowance you've spent, and tells you how much today gets.

Nothing leaves the machine. No API keys, no credentials, no network calls — the
server binds to `localhost` and only reads files you already have.

> Not affiliated with, endorsed by, or supported by Anthropic. "Claude" and
> "Claude Code" are trademarks of Anthropic. This tool estimates consumption
> from local transcript data; it is not an official usage meter, and the numbers
> are an approximation (see [Known limits](#known-limits)).

macOS and Windows both have always-on installers — a LaunchAgent on macOS, a
built launcher exe plus a Startup-folder shortcut on Windows. The server and
dashboard are plain Node and should run anywhere Claude Code does.

## Status

- [x] scan — incremental reader for `~/.claude/projects/**/*.jsonl`
- [x] weighting — relative consumption model incl. cache write/read multipliers
- [x] budget — weekly window, limit estimation, buffer+debt allocation
- [x] server — localhost HTTP + JSON API, zero dependencies
- [x] web — dashboard with drag/scroll availability calendar
- [x] percentages — all display in % of weekly allowance (no API dollars)
- [x] calibration — enter the % `/usage` shows, tool solves for the real limit
- [x] 5-hour block — start inferred from transcript activity
- [x] launchagent — always-on install script (macOS)
- [x] windows launcher — built exe + Start Menu/Desktop/Startup shortcuts
- [x] durable plan — atomic writes + serialized saves; settings survive concurrency
- [x] cross-file dedup — warm and cold scans agree (was inflating toward 2x)
- [x] setup gate — blocking dialog collects the reset window + both `/usage` readings first
- [ ] Full Disk Access — grant it to `node` so the LaunchAgent can read ~/Desktop
- [ ] limit pinning — auto-pins on first real rate-limit hit; unverified until one occurs

## Install

Requires **Node 20+**. No `npm install` — there are no dependencies.

```bash
git clone https://github.com/andoodle/yet-another-usage-tracker.git
cd yet-another-usage-tracker
node src/server.mjs
```

Then open <http://localhost:4478>. Set `BUDGET_PORT` to use a different port.

## Run

Always-on (recommended, macOS) — runs at login, restarts if it dies:

```bash
scripts/install-launchagent.sh
```

Then just open <http://localhost:4478>.

Desktop shortcut (no Terminal window; opens the dashboard, and starts the
server first if it isn't answering):

```bash
scripts/make-desktop-shortcut.sh              # -> ~/Desktop
scripts/make-desktop-shortcut.sh /Applications
scripts/make-desktop-shortcut.sh --uninstall
```

Always-on (recommended, Windows) — builds a small launcher exe, then adds
Start Menu, Desktop, and Startup-folder shortcuts:

```powershell
.\scripts\install-windows.ps1
.\scripts\install-windows.ps1 -NoAutostart     # shortcuts only, no login start
.\scripts\install-windows.ps1 -Uninstall
```

Nothing is installed to build it. `csc.exe` (the C# compiler) ships inside
Windows as part of the .NET Framework, and the icon is rendered by this repo's
own `scripts/make-icon.mjs`. Node stays the only prerequisite.

The exe is a ~10KB launcher, not a self-contained binary: it checks whether
the port is already answering, spawns `node src/server.mjs` hidden if not
(logging to `claude-budget.log`), waits for the port, then opens your browser.
`--serve` skips the browser, which is what the Startup shortcut uses so login
doesn't hand you a tab you didn't ask for. Launching it twice won't start a
second server.

> A [Node SEA](https://nodejs.org/api/single-executable-applications.html)
> build would produce a true standalone exe, but at ~110MB, plus a bundler
> dependency and a rewrite of the static-file serving to read from SEA assets.
> Node is already required to run the server, so the thin launcher buys the
> same double-clickability for 0.01% of the size and no source changes.

Autostart is a Startup-folder shortcut rather than a Scheduled Task or a
service, deliberately: this is a personal dashboard, not infrastructure. If
you're not logged in, you're not coding, and there's nothing to pace.

Manual, or as a fallback: `node src/server.mjs`, or double-click
`Open Claude Budget.command` (macOS).

## Why it works the way it does

**There is no API for subscription usage.** Anthropic publishes none. `ccusage`
reads these same local transcripts and only fetches a *pricing* table. And
`/usage` can't be automated — `claude -p "/usage"` does resolve the command
(0 tokens, ~8ms, no API call) but print mode returns only the sentence
*"You are currently using your subscription to power your Claude Code usage"*.
The percentages are TUI-rendered and never serialize. `/status` isn't available
headless at all. Verified, not assumed.

So consumption is computed from your own transcripts as a **relative weight**:

```
weight = input + output×5 + cacheWrite×1.25 + cacheRead×0.1   (×model tier)
```

Those coefficients come from API price ratios, but **nothing is displayed in
dollars** — on a subscription there is no dollar meter, and showing API prices
would be a number you never pay. Everything on screen is a **share of your
weekly allowance**.

That's also why the estimate being imperfect doesn't matter much: pacing is
**scale-invariant**. If the total is 20% off, every day's slice is off by the
same factor, and the ratio between days — the thing that tells you whether to
keep going — is unchanged.

### The Fable sub-limit, and why the weight is calibrated

Fable is capped at **50% of the weekly limit** (documented by Anthropic), and its
usage *also* counts toward the weekly total. Two meters, one budget.

That leaves two unknowns: the weekly limit `W`, and how heavily Fable is metered.
An earlier version got this backwards — it assumed Fable weighs 2x Opus (its API
list-price ratio) and solved for the *share*, producing ~30% and contradicting the
docs. **API list prices have no necessary relationship to subscription metering.**

Now the documented 50% is treated as fact and the *weight* is solved instead, from
two readings taken at the same moment:

```
fable×k          = fablePct × 0.5 × W
fable×k + other  = weekPct × W
```

`other` is measured directly and unaffected by `k`, so `W` falls out, then `k`.
Measured on one account: **k ≈ 3.4×, i.e. Fable costs roughly 6.7× Opus per
token, not 2×.** That's a single data point — recalibrate on yours.

This also fixed the *weekly* meter, which had been reading ~2 points high — Fable is
a third of total consumption, so under-weighting it skewed both numbers. Enter the
week and Fable percentages together; either one alone can't determine either unknown.

### Estimating the weekly limit

1. **Inferred** (default): the heaviest rolling 7-day stretch you've actually
   sustained, plus 15%. Rolling, not calendar-aligned — a calendar-week max
   ignores the in-progress week, which lets a heavy current week exceed its own
   inferred limit and pin remaining budget to zero.
   This number paces allocation, but it is **not shown as a percentage**: every
   "% of limit" readout stays `—` until a real reading is entered. Pacing only
   needs the week's relative shape; reporting "72% of your limit" off a guess
   would be fiction stated to the pixel. Because that leaves nothing on screen,
   an uncalibrated dashboard opens behind a **blocking setup dialog** that asks
   for the reset window and both percentages before anything renders. It has no
   dismiss button until a solve actually fails, so an unsolvable week can't lock
   you out.
2. **Calibrated**: run `/usage`, type the weekly percentage into the field. The
   tool solves `limit = spentThisWeek ÷ pct`. One number, in units you can see.
3. **Pinned**: when you hit a real limit, Claude Code writes an error into the
   transcript. The scanner detects it and pins the limit to your exact
   week-to-date consumption at that instant. Free ground truth, no typing.

### Allocation: buffer + debt hybrid

Each policy fixes the other's weakness:

- **Baseline** — every day's share is computed once from the week's weights.
  It does *not* move when you overspend, which is what makes the overspend
  visible instead of silently repricing later days.
- **Debt** — cumulative (used − baseline) through yesterday, shown as
  "running balance". Reported, not absorbed.
- **Reserve** — 15% held back all week, released when 2 days remain. Its job is
  to pay the debt down late, so a heavy Tuesday doesn't throttle Friday.

Remaining days get `baseline + (releasedReserve − debt) × weight`, with a hard
cap so the week can't exceed the limit regardless. Tunable via `reserveFraction`
and `reserveReleaseDays` in `~/.claude/budget-data/plan.json`.

### What's inferred vs configured

| | Source |
|---|---|
| 5-hour block start | **Inferred** — first activity after a ≥5h gap, rolling every 5h |
| Weekly reset anchor | **Configured** — nothing in local data records it |

## Files

| Path | Role |
|---|---|
| `src/scan.mjs` | Incremental transcript reader. Caches per-file byte offsets + per-message records in `~/.claude/budget-data/scan-cache.json`, de-duplicated across files at merge time. Cold scan of 249MB ≈ 1.4s; incremental ≈ 40ms. |
| `src/pricing.mjs` | Per-model tiers and the cache multipliers that set relative weight. |
| `src/budget.mjs` | Week windowing, limit inference, buffer+debt allocation, block detection. |
| `src/server.mjs` | `GET /api/state`, `POST /api/plan`, static files. |
| `web/` | Dashboard. Build-once / patch-in-place rendering so drags survive updates. |

Plan and cache live in `~/.claude/budget-data/` — deleting either is safe.

## Known limits

- Messages appearing in several transcripts (a resumed or forked session copies
  its parent's history — ~50% of usage-bearing messages here) are counted once,
  de-duplicated at merge time over a sorted file walk, so warm and cold scans
  agree. A message with no id can't be identified across files and is always
  counted.
- **Only this machine's transcripts are counted.** The allowance is per
  account, but `~/.claude/projects/` is per machine. If you use Claude Code on
  a laptop and a desktop, each one sees only its own share and both understate
  the account-wide total. Treat the number as a floor, not a ledger.
- Cache-write TTL is assumed 5m unless the transcript carries the newer
  `usage.cache_creation` breakdown, so 1h-TTL writes are under-weighted.
- The weekly reset day/hour is a guess until you set it to match `/usage`.
- `~/Desktop` is TCC-protected, so the LaunchAgent needs Full Disk Access
  granted to your `node` binary (or move the project elsewhere).
- **Re-grant Full Disk Access after `brew upgrade node`.** macOS attaches TCC
  grants to the *resolved* binary, and Homebrew's `node` is a symlink into a
  version-stamped path (`/opt/homebrew/Cellar/node/<version>/bin/node`). A node
  upgrade moves the real binary, the grant stops matching, and the agent fails
  **silently** — the dashboard just stops updating with no error or prompt.
  Symptom: `~/.claude/budget-data/agent.err` shows `EPERM`. Fix: re-add
  `/opt/homebrew/bin/node` under System Settings → Privacy & Security →
  Full Disk Access. Moving the project off `~/Desktop` avoids this permanently.

## Contributing

Issues and PRs welcome. It's a small, dependency-free codebase — keep it that
way: no runtime dependencies, no build step, plain ES modules.

## License

MIT — see [LICENSE](LICENSE).
