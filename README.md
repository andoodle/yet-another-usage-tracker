# claude-budget

- [x] scan — incremental reader for `~/.claude/projects/**/*.jsonl`
- [x] weighting — relative consumption model incl. cache write/read multipliers
- [x] budget — weekly window, limit estimation, buffer+debt allocation
- [x] server — localhost HTTP + JSON API, zero dependencies
- [x] web — dashboard with drag/scroll availability calendar
- [x] percentages — all display in % of weekly allowance (no API dollars)
- [x] calibration — enter the % `/usage` shows, tool solves for the real limit
- [x] 5-hour block — start inferred from transcript activity
- [x] launchagent — always-on install script
- [ ] Full Disk Access — grant it to `node` so the LaunchAgent can read ~/Desktop
- [ ] limit pinning — auto-pins on first real rate-limit hit; unverified until one occurs

Paces weekly Claude usage so you don't burn the allowance early. Reads your local
Claude Code transcripts; nothing leaves the machine, no credentials are touched.

## Run

```bash
node src/server.mjs
```

Then open <http://localhost:4478>. For always-on:

```bash
scripts/install-launchagent.sh
```

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

### Estimating the weekly limit

1. **Inferred** (default): the heaviest rolling 7-day stretch you've actually
   sustained, plus 15%. Rolling, not calendar-aligned — a calendar-week max
   ignores the in-progress week, which lets a heavy current week exceed its own
   inferred limit and pin remaining budget to zero.
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
| `src/scan.mjs` | Incremental transcript reader. Caches per-file byte offsets + hourly aggregates in `~/.claude/budget-data/scan-cache.json`. Cold scan of 249MB ≈ 1.6s; incremental ≈ 40ms. |
| `src/pricing.mjs` | Per-model tiers and the cache multipliers that set relative weight. |
| `src/budget.mjs` | Week windowing, limit inference, buffer+debt allocation, block detection. |
| `src/server.mjs` | `GET /api/state`, `POST /api/plan`, static files. |
| `web/` | Dashboard. Build-once / patch-in-place rendering so drags survive updates. |

Plan and cache live in `~/.claude/budget-data/` — deleting either is safe.

## Known limits

- Messages are deduped by id within a file; the same message appearing in two
  different transcripts (rare) is counted twice.
- Cache-write TTL is assumed 5m unless the transcript carries the newer
  `usage.cache_creation` breakdown, so 1h-TTL writes are under-weighted.
- The weekly reset day/hour is a guess until you set it to match `/usage`.
- `~/Desktop` is TCC-protected, so the LaunchAgent needs Full Disk Access
  granted to your `node` binary (or move the project elsewhere).
