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
 * Decide how much of the REMAINING weekly budget today gets.
 *
 * `remaining` is capacity minus everything already spent this week, and
 * `weights` covers today plus every day left in the window. Returning a
 * proportional share is the "strict" reading: overspend yesterday and every
 * remaining day shrinks automatically, so the week can never blow past the cap.
 *
 * TODO(you): this is the one genuinely opinionated decision in the tool, and
 * it changes what the dashboard tells you to do. Three defensible policies:
 *
 *   1. STRICT (implemented below) — self-correcting, never overruns, but one
 *      heavy day quietly punishes every day after it with no warning.
 *   2. DEBT — keep each day's original allocation and show the overspend as a
 *      running deficit. Honest about *why* you're short; can still overrun.
 *   3. BUFFER — hold back N% of capacity as reserve, allocate from the rest,
 *      and only release the reserve in the last day or two of the week.
 *
 * Which one you want depends on whether you'd rather be silently throttled or
 * loudly warned. Edit this function to change it.
 */
export function todaysAllowance({ remaining, weights }) {
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  if (totalWeight <= 0) return remaining
  return (remaining * weights[0]) / totalWeight
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

  // Days from today through the end of the window.
  const days = []
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  while (cursor < end) {
    days.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  const weights = days.map((d) => weightFor(plan, d))

  const allowance = remaining == null ? null : todaysAllowance({ remaining, weights })

  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const spentToday = costBetween(buckets, todayStart, now)

  // Every day in the window (including past ones) for the calendar UI.
  const perDay = []
  const wc = new Date(start)
  wc.setHours(0, 0, 0, 0)
  const totals = dailyTotals(buckets, start, end)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  while (wc < end) {
    const k = dateKey(wc)
    const isPast = wc < todayStart
    const isToday = k === dateKey(todayStart)
    const w = weightFor(plan, wc)
    let planned = null
    if (remaining != null && !isPast && totalWeight > 0) {
      planned = (remaining * w) / totalWeight
    }
    perDay.push({
      date: k,
      dow: wc.getDay(),
      weight: w,
      spent: totals[k] || 0,
      planned,
      isPast,
      isToday,
    })
    wc.setDate(wc.getDate() + 1)
  }

  // The 5-hour rolling block is what actually bites first in practice.
  const blockFrom = new Date(now.getTime() - 5 * HOUR)
  const spentBlock = costBetween(buckets, blockFrom, now)

  return {
    now: now.toISOString(),
    week: { start: start.toISOString(), end: end.toISOString(), spent: spentWeek },
    capacity,
    remaining,
    today: {
      date: dateKey(todayStart),
      spent: spentToday,
      allowance,
      // A zero allowance with spend against it is "over", not "unknown".
      pct: allowance == null ? null : allowance > 0 ? spentToday / allowance : spentToday > 0 ? 99 : 0,
    },
    block5h: { spent: spentBlock, since: blockFrom.toISOString() },
    perDay,
    limitEvents: limitEvents.slice(-5),
    plan,
  }
}
