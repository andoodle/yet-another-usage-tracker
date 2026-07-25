import fsp from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR } from './scan.mjs'

const PLAN_FILE = path.join(DATA_DIR, 'plan.json')

export const DEFAULT_PLAN = {
  // Which weekday + hour the weekly limit rolls over on (0 = Sunday).
  weekStart: { dow: 1, hour: 0 },
  // 'auto' infers capacity from your own history; 'manual' uses weeklyUsd.
  capacity: { mode: 'auto', weeklyUsd: null },
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

export async function loadPlan() {
  try {
    const p = JSON.parse(await fsp.readFile(PLAN_FILE, 'utf8'))
    return { ...DEFAULT_PLAN, ...p }
  } catch {
    return { ...DEFAULT_PLAN }
  }
}

export async function savePlan(plan) {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const merged = { ...DEFAULT_PLAN, ...plan }
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
  start.setHours(weekStart.hour, 0, 0, 0)
  const shift = (start.getDay() - weekStart.dow + 7) % 7
  start.setDate(start.getDate() - shift)
  if (start > now) start.setDate(start.getDate() - 7)
  const end = new Date(start.getTime() + 7 * DAY)
  return { start, end }
}

/** Sum bucket cost over [from, to). */
export function costBetween(buckets, from, to) {
  let sum = 0
  for (const [key, b] of Object.entries(buckets)) {
    const t = hourKeyToDate(key)
    if (t >= from && t < to) sum += b.cost
  }
  return sum
}

function hourKeyToDate(key) {
  const [datePart, hourPart] = key.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  return new Date(y, m - 1, d, Number(hourPart), 0, 0, 0)
}

/** Per-day cost totals within a window, keyed "YYYY-MM-DD". */
export function dailyTotals(buckets, from, to) {
  const out = {}
  for (const [key, b] of Object.entries(buckets)) {
    const t = hourKeyToDate(key)
    if (t < from || t >= to) continue
    const k = key.split('T')[0]
    out[k] = (out[k] || 0) + b.cost
  }
  return out
}

/**
 * Infer weekly capacity from the user's own history: the heaviest complete
 * week they've actually sustained, plus headroom. Scale-invariant pacing
 * doesn't need the true number — but this keeps the percentages honest.
 * A detected rate-limit event pins capacity exactly (see limitEvents).
 */
export function inferCapacity(buckets, weekStart, now, limitEvents = []) {
  // If we caught an actual limit event, the week-to-date spend at that moment
  // IS the capacity. That is free ground truth, no manual entry required.
  const pins = []
  for (const ev of limitEvents) {
    const at = new Date(ev.at)
    if (Number.isNaN(at.getTime())) continue
    const { start } = weekWindow(at, weekStart)
    pins.push(costBetween(buckets, start, at))
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
    const c = costBetween(buckets, cursor, to)
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

  const totalWeekWeight = days.reduce((a, d) => a + d.weight, 0)
  const baseline = {}
  for (const d of days) {
    baseline[d.date] = totalWeekWeight > 0 ? (allocatable * d.weight) / totalWeekWeight : 0
  }

  const past = days.filter((d) => d.date < todayKey)
  const remainingDays = days.filter((d) => d.date >= todayKey)

  const spentPast = past.reduce((a, d) => a + (spentByDay[d.date] || 0), 0)
  const baselinePast = past.reduce((a, d) => a + baseline[d.date], 0)
  const debt = spentPast - baselinePast

  const released = remainingDays.length <= plan.reserveReleaseDays
  const adjustPool = (released ? reserveTotal : 0) - debt

  const remWeight = remainingDays.reduce((a, d) => a + d.weight, 0)
  const planned = {}
  for (const d of remainingDays) {
    const share = remWeight > 0 ? (adjustPool * d.weight) / remWeight : 0
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
export function computeState({ buckets, limitEvents, plan, now = new Date() }) {
  const { start, end } = weekWindow(now, plan.weekStart)
  const spentWeek = costBetween(buckets, start, now)

  const inferred = inferCapacity(buckets, plan.weekStart, now, limitEvents)
  const capacity =
    plan.capacity.mode === 'manual' && plan.capacity.weeklyUsd
      ? { weeklyUsd: plan.capacity.weeklyUsd, source: 'manual' }
      : inferred

  const remaining = capacity.weeklyUsd == null ? null : Math.max(0, capacity.weeklyUsd - spentWeek)

  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayKey = dateKey(todayStart)
  const spentToday = costBetween(buckets, todayStart, now)
  const totals = dailyTotals(buckets, start, end)

  // Every day in the window, past and future.
  const days = []
  const wc = new Date(start)
  wc.setHours(0, 0, 0, 0)
  while (wc < end) {
    days.push({ date: dateKey(wc), dow: wc.getDay(), weight: weightFor(plan, wc) })
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

  return {
    now: now.toISOString(),
    week: { start: start.toISOString(), end: end.toISOString(), spent: spentWeek },
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
    block: currentBlock(buckets, now),
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
export function currentBlock(buckets, now) {
  const hours = Object.keys(buckets)
    .filter((k) => buckets[k].cost > 0)
    .sort()
  if (!hours.length) return { spent: 0, since: null, endsAt: null, open: false }

  // Blocks ROLL: a new one starts either after an idle gap or once the current
  // block's 5 hours elapse. Anchoring only on idle gaps means a long continuous
  // session never rolls over and the block reads as permanently expired.
  let blockStart = null
  for (const key of hours) {
    const t = hourKeyToDate(key)
    if (blockStart == null || t - blockStart >= 5 * HOUR) blockStart = t
  }

  // The most recent block may already have expired.
  if (!blockStart || now - blockStart >= 5 * HOUR) {
    return { spent: 0, since: null, endsAt: null, open: false }
  }

  return {
    spent: costBetween(buckets, blockStart, now),
    since: blockStart.toISOString(),
    endsAt: new Date(blockStart.getTime() + 5 * HOUR).toISOString(),
    open: true,
  }
}
