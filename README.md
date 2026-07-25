# claude-budget

- [x] scan — incremental reader for `~/.claude/projects/**/*.jsonl`
- [x] pricing — weighted per-MTok cost model incl. cache write/read multipliers
- [x] budget — weekly window, capacity inference, per-day allocation
- [x] server — localhost HTTP + JSON API, zero dependencies
- [x] web — dashboard with drag-to-set availability calendar
- [x] launchagent — always-on install script
- [ ] allocation policy — pick STRICT / DEBT / BUFFER (see `src/budget.mjs` → `todaysAllowance`)
- [ ] capacity ground truth — auto-pins on first real rate-limit hit; unverified until one occurs

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

## How it works

**There is no API for subscription usage.** Anthropic publishes none, and no
third-party tool has one — `ccusage` reads the same local transcripts and only
fetches a *pricing* table. So this computes a weighted proxy from your own
transcripts:

```
cost = input×rate + output×rate×5 + cacheWrite×rate×1.25 + cacheRead×rate×0.1
```

Absolute dollars are not a bill and not your true limit percentage. That doesn't
matter for the job: pacing is **scale-invariant**. If the proxy is 20% off, every
day's slice is off by the same factor, and the ratio between days — the thing that
tells you whether to keep going — is unchanged.

**Capacity** is inferred from the heaviest rolling 7-day stretch you've actually
sustained, plus 15% headroom. When you do hit a real limit, Claude Code writes an
error into the transcript; the scanner detects it and pins capacity to your exact
week-to-date spend at that instant. Free ground truth, no manual entry.

**Allocation.** Remaining weekly budget is split across the days left in the
window, proportional to each day's availability weight. Drag a day to 0 and its
share is redistributed across the rest.

## Files

| Path | Role |
|---|---|
| `src/scan.mjs` | Incremental transcript reader. Caches per-file byte offsets + hourly aggregates in `~/.claude/budget-data/scan-cache.json`. Cold scan of 249MB ≈ 1.6s; incremental ≈ 40ms. |
| `src/pricing.mjs` | Per-model rates and the cache multipliers. |
| `src/budget.mjs` | Week windowing, capacity inference, day allocation. |
| `src/server.mjs` | `GET /api/state`, `POST /api/plan`, static files. |
| `web/` | Dashboard. |

Plan and cache live in `~/.claude/budget-data/` — deleting either is safe; the
scan rebuilds and the plan falls back to defaults.

## Known limits

- Messages are deduped by id within a file; the same message appearing in two
  different transcripts (rare) is counted twice.
- Cache-write TTL is assumed 5m unless the transcript carries the newer
  `usage.cache_creation` breakdown, so 1h-TTL writes are under-counted.
- Weekly reset day/hour is a guess until you set it to match what `/usage` shows.
