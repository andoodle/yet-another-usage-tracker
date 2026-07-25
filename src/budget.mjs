import fsp from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR } from './scan.mjs'

const PLAN_FILE = path.join(DATA_DIR, 'plan.json')

export const DEFAULT_PLAN = {
  // Exact moment the weekly limit rolls over (0 = Sunday). Minutes matter —
  // real reset anchors are wall-clock times like Wed 15:45, not round hours.
  weekStart: { dow: 1, hour: 0, minute: 0 },
  // 'auto' infers from your own history; 'manual' uses weeklyUsd.
  // `fable` is normally DERIVED as fableShare × the overall limit, since it is
  // a sub-limit of the same budget rather than an independent allowance.
  capacity: {
    all: { mode: 'auto', weeklyUsd: null },
    fable: { mode: 'auto', weeklyUsd: null },
    // The 5-hour session limit is a DIFFERENT limit, not a slice of the week.
    // It needs its own capacity or its percentage is meaningless.
    block: { mode: 'auto', weeklyUsd: null },
  },
  // Share of the weekly limit usable on Fable. This is DOCUMENTED by Anthropic
  // (50% on Max), so it is treated as fact and not solved for.
  fableShare: 0.5,
  // How much Fable consumption weighs relative to this tool's price-ratio
  // estimate. API list prices put Fable at 2x Opus, but a subscription meters
  // usage on its own terms — measurement showed ~3.3x that, i.e. ~6.7x Opus.
  // Solved from observed /usage readings rather than assumed. 1 = no correction.
  fableWeight: 1,
  // Last observed /usage percentages, kept so entering one reading can be
  // combined with the other to solve for both unknowns at once.
  observed: { weekPct: null, fablePct: null },
  // A known 5-hour-block reset moment (ISO). Reconstructing the block chain
  // from transcript history alone drifts — gaps and hour bucketing move the
  // anchor by hours. One observed reset time pins it exactly; the chain then
  // rolls forward in 5h steps for as long as you keep working.
  blockAnchor: null,
  // Per-weekday default availability, 0 = away, 1 = normal, 2 = heavy.
  weekdayWeights: { 0: 0.4, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 0.4 },
  // Date-specific overrides, "YYYY-MM-DD" -> weight. Set by dragging the calendar.
  dayOverrides: {},
  // Fraction of weekly capacity held back and only released near the end of
  // the window. Pays down accumulated debt instead of throttling you silently.
  reserveFraction: 0.15,
  // Reserve unlocks once this many days (including today) remain.
  reserveReleaseDays: 2,
}

/** Bring older plan files forward without losing calibration the user did. */
function migrate(p) {
  const out = { ...DEFAULT_PLAN, ...p }
  out.weekStart = { minute: 0, ...DEFAULT_PLAN.weekStart, ...(p.weekStart || {}) }

  // v1 stored one flat capacity; v2 keyed it 'standard'. Both meant the
  // overall weekly limit, which is now 'all'. Preserve any calibration.
  const legacy =
    p.capacity && ('mode' in p.capacity || 'weeklyUsd' in p.capacity)
      ? { mode: p.capacity.mode || 'auto', weeklyUsd: p.capacity.weeklyUsd ?? null }
      : p.capacity?.standard || p.capacity?.all || null

  out.capacity = {
    all: { ...DEFAULT_PLAN.capacity.all, ...(legacy || {}) },
    fable: { ...DEFAULT_PLAN.capacity.fable, ...(p.capacity?.fable || {}) },
    block: { ...DEFAULT_PLAN.capacity.block, ...(p.capacity?.block || {}) },
  }
  return out
}

/**
 * Solve the weekly limit AND the Fable weight together from two observed
 * /usage readings.
 *
 * The two unknowns are the weekly limit `W` and the Fable weight correction
 * `k`. Anthropic documents the Fable cap as `fableShare × W`, so that is taken
 * as fact rather than solved for — the earlier approach did the reverse
 * (trusting an API price ratio and solving for the share), which contradicted
 * the docs and left the weekly meter wrong too, since Fable is a large slice
 * of total consumption.
 *
 *   fableUnits × k        = fablePct × fableShare × W
 *   fableUnits × k + other = weekPct × W
 *
 * Subtracting gives `other = (weekPct − fablePct × fableShare) × W`, and
 * `other` is measured directly and unaffected by k — so W falls out, then k.
 *
 * @returns {{weeklyUsd:number, fableWeight:number}|{error:string}}
 */
export function solveFromObservations({ weekPct, fablePct, fableShare, fableUnits, otherUnits }) {
  const w = weekPct / 100
  const f = fablePct / 100
  const denom = w - f * fableShare

  if (!(otherUnits > 0)) return { error: 'no non-Fable usage recorded this week yet' }
  if (denom <= 0) {
    // Fable would account for the entire week or more — inconsistent readings,
    // or every single request this week was Fable.
    return { error: 'readings imply Fable is 100% of the week; check the numbers' }
  }
  const weeklyUsd = otherUnits / denom
  if (!(fableUnits > 0)) return { weeklyUsd, fableWeight: 1 }

  const fableWeight = (f * fableShare * weeklyUsd) / fableUnits
  if (!Number.isFinite(fableWeight) || fableWeight <= 0) return { error: 'could not solve Fable weight' }
  return { weeklyUsd, fableWeight }
}

export async function loadPlan() {
  try {
    return migrate(JSON.parse(await fsp.readFile(PLAN_FILE, 'utf8')))
  } catch {
    return { ...DEFAULT_PLAN }
  }
}

export async function savePlan(plan) {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const merged = migrate(plan)
  // Clamp the user-tunable knobs so a bad value can't wedge the allocator.
  merged.reserveFraction = Math.max(0, Math.min(0.6, Number(merged.reserveFraction) || 0))
  merged.reserveReleaseDays = Math.max(0, Math.min(7, Math.round(Number(merged.reserveReleaseDays) || 0)))
  // A solve from inconsistent readings could otherwise store an absurd weight
  // and skew every meter; keep it inside a defensible range.
  merged.fableWeight = Math.max(0.05, Math.min(50, Number(merged.fableWeight) || 1))
  await fsp.writeFile(PLAN_FILE, JSON.stringify(merged, null, 2))
  return merged
}

const HOUR = 3600e3
const DAY = 24 * HOUR

export function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Start of the weekly window containing `now`. */
export function weekWindow(now, weekStart) {
  const start = new Date(now)
  start.setHours(weekStart.hour, weekStart.minute || 0, 0, 0)
  const shift = (start.getDay() - weekStart.dow + 7) % 7
  start.setDate(start.getDate() - shift)
  if (start > now) start.setDate(start.getDate() - 7)
  const end = new Date(start.getTime() + 7 * DAY)
  return { start, end }
}

/**
 * Cost of one bucket for a given meter, with the Fable weight correction
 * applied. 'all' is the full total — Fable included, because Fable draws from
 * the same weekly limit. 'fable' is the Fable-only subset for its sub-limit.
 *
 * `b.cost` is NOT used for the total: it was summed at scan time with the
 * uncorrected weight, so it would silently ignore `fableWeight`.
 */
function bucketCost(b, pool, fw = 1) {
  const fable = ((b.pools && b.pools.fable) || 0) * fw
  const other = (b.pools && b.pools.other) || 0
  if (!pool || pool === 'all') return fable + other
  if (pool === 'fable') return fable
  return (b.pools && b.pools[pool]) || 0
}

/** Sum bucket cost over [from, to), optionally for a single pool. */
export function costBetween(buckets, from, to, pool, fw = 1) {
  let sum = 0
  for (const [key, b] of Object.entries(buckets)) {
    const t = hourKeyToDate(key)
    if (t >= from && t < to) sum += bucketCost(b, pool, fw)
  }
  return sum
}

function hourKeyToDate(key) {
  const [datePart, hourPart] = key.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  return new Date(y, m - 1, d, Number(hourPart), 0, 0, 0)
}

/** Per-day cost totals within a window, keyed "YYYY-MM-DD". */
export function dailyTotals(buckets, from, to, pool, fw = 1) {
  const out = {}
  for (const [key, b] of Object.entries(buckets)) {
    const t = hourKeyToDate(key)
    if (t < from || t >= to) continue
    const k = key.split('T')[0]
    out[k] = (out[k] || 0) + bucketCost(b, pool, fw)
  }
  return out
}

/**
 * Infer weekly capacity from the user's own history: the heaviest complete
 * week they've actually sustained, plus headroom. Scale-invariant pacing
 * doesn't need the true number — but this keeps the percentages honest.
 * A detected rate-limit event pins capacity exactly (see limitEvents).
 */
export function inferCapacity(buckets, weekStart, now, limitEvents = [], pool, fw = 1) {
  // If we caught an actual limit event, the week-to-date spend at that moment
  // IS the capacity. That is free ground truth, no manual entry required.
  const pins = []
  for (const ev of limitEvents) {
    const at = new Date(ev.at)
    if (Number.isNaN(at.getTime())) continue
    const { start } = weekWindow(at, weekStart)
    pins.push(costBetween(buckets, start, at, pool, fw))
  }
  if (pins.length) {
    return { weeklyUsd: Math.max(...pins), source: 'limit-event', pins: pins.length }
  }

  const keys = Object.keys(buckets)
  if (!keys.length) return { weeklyUsd: null, source: 'unknown' }

  // Rolling 7-day windows stepped daily, NOT calendar weeks. A calendar-week
  // max ignores the in-progress week, so a heavy current week can exceed its
  // own inferred capacity and pin remaining budget to zero.
  const first = keys.sort()[0]
  const [fy, fm, fd] = first.split('T')[0].split('-').map(Number)
  const cursor = new Date(fy, fm - 1, fd, 0, 0, 0, 0)

  let best = 0
  while (cursor <= now) {
    const to = new Date(Math.min(cursor.getTime() + 7 * DAY, now.getTime()))
    const c = costBetween(buckets, cursor, to, pool, fw)
    if (c > best) best = c
    cursor.setDate(cursor.getDate() + 1)
  }
  if (best <= 0) return { weeklyUsd: null, source: 'unknown' }
  // The heaviest 7 days you ran without being cut off is a floor, not a ceiling.
  return { weeklyUsd: best * 1.15, source: 'history' }
}

export function weightFor(plan, date) {
  const k = dateKey(date)
  if (Object.prototype.hasOwnProperty.call(plan.dayOverrides, k)) return plan.dayOverrides[k]
  return plan.weekdayWeights[date.getDay()] ?? 1
}

/**
 * BUFFER + DEBT hybrid allocation.
 *
 * The two policies compose because they solve opposite halves of the problem:
 *
 *   BASELINE — each day's share is computed ONCE from the whole week's weights
 *     over (capacity − reserve). It does not move when you overspend, which is
 *     what makes the overspend visible instead of silently repricing later days.
 *
 *   DEBT — cumulative (actually spent) − (baseline) through yesterday. Positive
 *     means you're borrowing. It's reported as a number rather than absorbed.
 *
 *   RESERVE — held back all week, unlocked when `reserveReleaseDays` remain.
 *     Its whole job is to pay debt down late, so a heavy Tuesday doesn't
 *     throttle Friday.
 *
 * Remaining days are then adjusted by (releasedReserve − debt), split by weight.
 * A hard cap keeps the week from exceeding capacity regardless.
 *
 * @returns {{planned: Record<string, number>, debt: number, reserve: {total: number, released: boolean}, throttled: boolean}}
 */
export function allocate({ capacity, plan, days, spentByDay, todayKey }) {
  const reserveTotal = capacity * plan.reserveFraction
  const allocatable = capacity - reserveTotal

  // Allocation uses effWeight (user weight × in-window fraction) so partial
  // first/last days don't get a full day's share.
  const w = (d) => (d.effWeight != null ? d.effWeight : d.weight)
  const totalWeekWeight = days.reduce((a, d) => a + w(d), 0)
  const baseline = {}
  for (const d of days) {
    baseline[d.date] = totalWeekWeight > 0 ? (allocatable * w(d)) / totalWeekWeight : 0
  }

  const past = days.filter((d) => d.date < todayKey)
  const remainingDays = days.filter((d) => d.date >= todayKey)

  const spentPast = past.reduce((a, d) => a + (spentByDay[d.date] || 0), 0)
  const baselinePast = past.reduce((a, d) => a + baseline[d.date], 0)
  const debt = spentPast - baselinePast

  const released = remainingDays.length <= plan.reserveReleaseDays
  const adjustPool = (released ? reserveTotal : 0) - debt

  const remWeight = remainingDays.reduce((a, d) => a + w(d), 0)
  const planned = {}
  for (const d of remainingDays) {
    const share = remWeight > 0 ? (adjustPool * w(d)) / remWeight : 0
    planned[d.date] = Math.max(0, baseline[d.date] + share)
  }

  // Hard ceiling: nothing left to allocate beyond what the week actually has.
  // Measured against yesterday's close so today's own spend isn't double-counted.
  const trueRemaining = Math.max(0, capacity - spentPast)
  const sumPlanned = Object.values(planned).reduce((a, b) => a + b, 0)
  let throttled = false
  if (sumPlanned > trueRemaining && sumPlanned > 0) {
    throttled = true
    const scale = trueRemaining / sumPlanned
    for (const k of Object.keys(planned)) planned[k] *= scale
  }

  return {
    planned,
    baseline,
    debt,
    reserve: { total: reserveTotal, released },
    throttled,
  }
}

/** Build the full dashboard state. */
// Default pool is 'all'. It was left as the long-removed 'standard' after the
// pool rename, which silently produced zero for every total — bucket lookups
// for an unknown pool return 0 rather than throwing.
export function computeState({ buckets, limitEvents, plan, pool = 'all', now = new Date() }) {
  const { start, end } = weekWindow(now, plan.weekStart)
  const fw = plan.fableWeight ?? 1
  const spentWeek = costBetween(buckets, start, now, pool, fw)

  // The overall limit is the one real quantity; Fable's cap is a share of it.
  // Inferring Fable independently would be wrong — a week with little Fable
  // use would "prove" a tiny Fable limit that doesn't exist.
  const inferredAll = inferCapacity(buckets, plan.weekStart, now, limitEvents, 'all', fw)
  const allCfg = plan.capacity.all || { mode: 'auto', weeklyUsd: null }
  // Resolve the overall limit ONCE. Everything else — the Fable sub-cap and
  // the Fable meter's overall reference — must derive from this same number,
  // or calibrating the overall limit leaves the other readouts disagreeing.
  const allCapacity =
    allCfg.mode === 'manual' && allCfg.weeklyUsd
      ? { weeklyUsd: allCfg.weeklyUsd, source: 'manual' }
      : inferredAll

  const cap = plan.capacity[pool] || { mode: 'auto', weeklyUsd: null }
  let capacity
  if (cap.mode === 'share' && cap.share > 0) {
    // A sub-limit is stored as a FRACTION of the overall limit, not an
    // absolute. That way recalibrating the weekly limit rescales it instead of
    // leaving the two meters describing different-sized weeks.
    capacity = allCapacity.weeklyUsd
      ? { weeklyUsd: allCapacity.weeklyUsd * cap.share, source: 'calibrated-share', share: cap.share }
      : { weeklyUsd: null, source: 'unknown' }
  } else if (cap.mode === 'manual' && cap.weeklyUsd) {
    capacity = { weeklyUsd: cap.weeklyUsd, source: 'manual' }
  } else if (pool === 'fable') {
    capacity = allCapacity.weeklyUsd
      ? { weeklyUsd: allCapacity.weeklyUsd * (plan.fableShare ?? 0.5), source: 'derived' }
      : { weeklyUsd: null, source: 'unknown' }
  } else {
    capacity = allCapacity
  }

  const remaining = capacity.weeklyUsd == null ? null : Math.max(0, capacity.weeklyUsd - spentWeek)

  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayKey = dateKey(todayStart)
  const spentToday = costBetween(buckets, todayStart, now, pool, fw)
  const totals = dailyTotals(buckets, start, end, pool, fw)

  // Every calendar day the window touches. A mid-day reset anchor (e.g. Wed
  // 15:45) makes the first and last days PARTIAL, so each day's effective
  // weight is scaled by how much of it actually falls inside the window.
  // Those two fractions sum to 1, so the week still totals seven days.
  const days = []
  const wc = new Date(start)
  wc.setHours(0, 0, 0, 0)
  while (wc < end) {
    const dayStart = new Date(wc)
    const dayEnd = new Date(wc.getTime() + DAY)
    const overlap =
      (Math.min(dayEnd.getTime(), end.getTime()) - Math.max(dayStart.getTime(), start.getTime())) / DAY
    const weight = weightFor(plan, wc)
    days.push({
      date: dateKey(wc),
      dow: wc.getDay(),
      weight, // what the user set — drives the drag UI
      partial: overlap < 0.999,
      effWeight: weight * Math.max(0, Math.min(1, overlap)), // what allocation uses
    })
    wc.setDate(wc.getDate() + 1)
  }

  const alloc =
    capacity.weeklyUsd == null
      ? null
      : allocate({ capacity: capacity.weeklyUsd, plan, days, spentByDay: totals, todayKey })

  const perDay = days.map((d) => ({
    ...d,
    spent: totals[d.date] || 0,
    planned: alloc ? (alloc.planned[d.date] ?? null) : null,
    baseline: alloc ? alloc.baseline[d.date] : null,
    isPast: d.date < todayKey,
    isToday: d.date === todayKey,
  }))

  const allowance = alloc ? alloc.planned[todayKey] : null

  // Where the plan says you *should* be by this moment: every past day's
  // baseline in full, plus the elapsed fraction of today's. Lets the weekly
  // gauge say "ahead/behind pace" rather than just "87% gone".
  const dayFrac = Math.min(1, (now - todayStart) / DAY)
  const baselinePast = perDay
    .filter((d) => d.isPast)
    .reduce((a, d) => a + (d.baseline || 0), 0)
  const expected = alloc ? baselinePast + (alloc.baseline[todayKey] || 0) * dayFrac : null
  const daysLeft = perDay.filter((d) => !d.isPast).length

  return {
    now: now.toISOString(),
    pool,
    // For the sub-limit meter, the overall budget is the OTHER constraint —
    // Fable can be under its 50% cap and still be blocked by the week total.
    overall:
      pool === 'fable'
        ? {
            spent: costBetween(buckets, start, now, 'all', fw),
            capacity: allCapacity.weeklyUsd,
            share: plan.fableShare ?? 0.5,
          }
        : null,
    week: {
      start: start.toISOString(),
      end: end.toISOString(),
      spent: spentWeek,
      expected,
      daysLeft,
    },
    capacity,
    remaining,
    debt: alloc ? alloc.debt : null,
    reserve: alloc ? alloc.reserve : null,
    throttled: alloc ? alloc.throttled : false,
    today: {
      date: todayKey,
      spent: spentToday,
      allowance,
      baseline: alloc ? alloc.baseline[todayKey] : null,
      // A zero allowance with spend against it is "over", not "unknown".
      pct: allowance == null ? null : allowance > 0 ? spentToday / allowance : spentToday > 0 ? 99 : 0,
    },
    block: (() => {
      const blk = currentBlock(buckets, now, pool, plan.blockAnchor, fw)
      const bc = plan.capacity.block || { mode: 'auto', weeklyUsd: null }
      const cap =
        bc.mode === 'manual' && bc.weeklyUsd ? bc.weeklyUsd : inferBlockCapacity(buckets, now, fw)
      return {
        ...blk,
        capacity: cap,
        pct: cap ? blk.spent / cap : null,
        source: bc.mode === 'manual' && bc.weeklyUsd ? 'manual' : 'history',
      }
    })(),
    perDay,
    limitEvents: limitEvents.slice(-5),
    plan,
  }
}

/**
 * The 5-hour session block. Its start is INFERRED, not configured: a block
 * begins at the first activity following a gap of >= 5h. That boundary is
 * derivable from the transcripts. The weekly reset anchor is not — nothing in
 * the local data records it, so that one stays a user setting.
 */
export function currentBlock(buckets, now, pool, anchorISO, fw = 1) {
  // A user-supplied anchor beats inference. Roll it forward in 5h steps to the
  // block containing `now`, and only trust it if there was actually activity in
  // that window — after a long idle the real block starts at the next message,
  // not on the rolled schedule, so fall back to inference there.
  if (anchorISO) {
    const anchor = new Date(anchorISO)
    if (!Number.isNaN(anchor.getTime())) {
      let endsAt = new Date(anchor)
      while (endsAt <= now) endsAt = new Date(endsAt.getTime() + 5 * HOUR)
      while (endsAt - 5 * HOUR > now) endsAt = new Date(endsAt.getTime() - 5 * HOUR)
      const since = new Date(endsAt.getTime() - 5 * HOUR)
      const spent = costBetween(buckets, since, now, pool, fw)
      if (spent > 0) {
        return { spent, since: since.toISOString(), endsAt: endsAt.toISOString(), open: true, anchored: true }
      }
    }
  }
  return inferBlock(buckets, now, pool, fw)
}

function inferBlock(buckets, now, pool, fw = 1) {
  // Must go through bucketCost: 'all' has no `pools` entry of its own, so a
  // direct pools[pool] lookup silently finds nothing and reports no block.
  const hours = Object.keys(buckets)
    .filter((k) => bucketCost(buckets[k], pool, fw) > 0)
    .sort()
  if (!hours.length) return { spent: 0, since: null, endsAt: null, open: false }

  // Blocks ROLL: a new one starts either after an idle gap or once the current
  // block's 5 hours elapse. Anchoring only on idle gaps means a long continuous
  // session never rolls over and the block reads as permanently expired.
  //
  // Use the bucket's exact first-message timestamp, not the hour floor —
  // rounding to the top of the hour skews the reset countdown by up to 59 min,
  // and the 5-hour limit is usually the one that actually bites.
  let blockStart = null
  for (const key of hours) {
    const b = buckets[key]
    const t = b.firstTs != null ? new Date(b.firstTs) : hourKeyToDate(key)
    if (blockStart == null || t - blockStart >= 5 * HOUR) blockStart = t
  }

  // The most recent block may already have expired.
  if (!blockStart || now - blockStart >= 5 * HOUR) {
    return { spent: 0, since: null, endsAt: null, open: false }
  }

  return {
    spent: costBetween(buckets, blockStart, now, pool, fw),
    since: blockStart.toISOString(),
    endsAt: new Date(blockStart.getTime() + 5 * HOUR).toISOString(),
    open: true,
  }
}

/**
 * Capacity of the 5-hour session limit, inferred the same way as the weekly
 * one: the heaviest 5-hour stretch actually sustained, plus headroom.
 */
export function inferBlockCapacity(buckets, now, fw = 1) {
  const hours = Object.keys(buckets).sort()
  if (!hours.length) return null
  let best = 0
  for (const key of hours) {
    const t = hourKeyToDate(key)
    if (t > now) continue
    const c = costBetween(buckets, t, new Date(t.getTime() + 5 * HOUR), 'all', fw)
    if (c > best) best = c
  }
  return best > 0 ? best * 1.15 : null
}
