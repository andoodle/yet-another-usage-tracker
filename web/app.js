const $ = (id) => document.getElementById(id)
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MAX_WEIGHT = 2
const STEP = 0.1

let state = null
let dragging = null // { date, el } while a gesture is live
const cells = new Map() // date -> { el, avail, spent, name, amt, label }

// Everything is expressed as a share of the WEEKLY ALLOWANCE. The underlying
// unit is a weighted token cost, but on a subscription there is no dollar
// meter — showing API prices would be a number that means nothing here.
const capacityUnits = () => state?.capacity?.weeklyUsd ?? null

const pct = (n) => {
  const cap = capacityUnits()
  if (n == null || !cap) return '—'
  const v = (n / cap) * 100
  if (v > 0 && v < 0.1) return '<0.1%'
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`
}

const signedPct = (n) => {
  const cap = capacityUnits()
  if (n == null || !cap) return '—'
  const v = (n / cap) * 100
  return `${v >= 0 ? '+' : '−'}${Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : Math.abs(v).toFixed(0)}%`
}

const LEVELS = [
  [0, 'away'],
  [0.5, 'light'],
  [1, 'normal'],
  [1.5, 'heavy'],
  [2, 'max'],
]
const levelName = (w) =>
  LEVELS.reduce((best, [v, n]) => (Math.abs(v - w) < Math.abs(best[0] - w) ? [v, n] : best), LEVELS[0])[1]

async function load(fresh = false) {
  const res = await fetch(`/api/state${fresh ? '?fresh=1' : ''}`)
  apply(await res.json())
}

let postSeq = 0
async function patchPlan(patch) {
  const seq = ++postSeq
  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const next = await res.json()
  // Ignore responses that a newer in-flight save has already superseded.
  if (seq === postSeq) apply(next)
}

function apply(next) {
  state = next
  paintSummary()
  syncWeekDom()
  paintWeek()
}

function verdictFor(pct) {
  if (pct == null) return ['Not enough history to pace yet.', '']
  if (pct >= 99) return ["Today's allocation is exhausted.", 'bad']
  const p = Math.round(pct * 100)
  if (pct < 0.6) return [`${p}% of today's share used — comfortable.`, 'good']
  if (pct < 0.95) return [`${p}% of today's share used — on pace.`, 'warn']
  if (pct < 1.4) return [`${p}% of today's share — borrowing from later in the week.`, 'warn']
  return [`${p}% of today's share — well over.`, 'bad']
}

function paintSummary() {
  const wStart = new Date(state.week.start)
  const wEnd = new Date(state.week.end)
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  $('window-label').textContent =
    `Week of ${fmt(wStart)} – ${fmt(new Date(wEnd - 1))} · ${state.fileCount} transcripts scanned`

  // Headline is "how much of today's share is gone", which is the number that
  // actually decides whether to keep working.
  const used = state.today.pct
  $('today-spent').textContent = used == null ? '—' : `${Math.min(999, Math.round(used * 100))}%`
  $('today-allow').textContent =
    state.today.allowance == null ? '' : `of today's share (${pct(state.today.allowance)} of week)`

  const meter = $('today-meter')
  meter.style.width = `${Math.min(100, (used ?? 0) * 100)}%`
  meter.style.background =
    used == null ? 'var(--muted)' : used < 0.6 ? 'var(--good)' : used < 1 ? 'var(--warn)' : 'var(--bad)'

  const [text, cls] = verdictFor(used)
  $('verdict').textContent = text
  $('verdict').className = `verdict ${cls}`

  $('week-spent').textContent = pct(state.week.spent)
  $('week-remaining').textContent = pct(state.remaining)

  // Debt / reserve — the two halves of the hybrid policy, stated explicitly.
  const debtEl = $('debt')
  if (state.debt == null) {
    debtEl.textContent = '—'
    debtEl.className = ''
  } else if (state.debt > 0) {
    debtEl.textContent = `${signedPct(-state.debt)} behind plan`
    debtEl.className = 'bad'
  } else {
    debtEl.textContent = `${signedPct(-state.debt)} ahead of plan`
    debtEl.className = 'good'
  }

  $('reserve').textContent = state.reserve
    ? `${pct(state.reserve.total)} ${state.reserve.released ? 'released' : 'held back'}`
    : '—'

  const blk = state.block
  $('block-spent').textContent = blk?.open
    ? `${pct(blk.spent)} · resets ${new Date(blk.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'none open'

  const src = state.capacity.source
  $('capacity-source').textContent =
    src === 'limit-event'
      ? `pinned by ${state.capacity.pins} real limit hit${state.capacity.pins > 1 ? 's' : ''}`
      : src === 'manual'
        ? 'set by you'
        : src === 'history'
          ? 'heaviest rolling 7 days + 15%'
          : 'unknown — no history yet'

  $('week-dow').value = String(state.plan.weekStart.dow)
  $('week-hour').value = String(state.plan.weekStart.hour)
  if (document.activeElement !== $('cal-pct')) {
    $('cal-pct').value =
      state.plan.capacity.mode === 'manual' && capacityUnits()
        ? Math.round((state.week.spent / capacityUnits()) * 100)
        : ''
  }
}

/** Create day columns once. Rebuild only when the set of dates changes. */
function syncWeekDom() {
  const host = $('week')
  const wanted = state.perDay.map((d) => d.date).join(',')
  if (host.dataset.key === wanted) return
  host.dataset.key = wanted
  host.textContent = ''
  cells.clear()

  for (const day of state.perDay) {
    const el = document.createElement('div')
    el.className = 'day'
    el.dataset.date = day.date

    const track = document.createElement('div')
    track.className = 'track'

    const avail = document.createElement('div')
    avail.className = 'avail'

    const spent = document.createElement('div')
    spent.className = 'spent-bar'

    const label = document.createElement('div')
    label.className = 'level'

    track.append(avail, spent, label)

    const name = document.createElement('div')
    name.className = 'name'
    const b = document.createElement('b')
    b.textContent = DOW[day.dow]
    name.append(b, document.createTextNode(day.date.slice(5)))

    const amt = document.createElement('div')
    amt.className = 'amt'

    el.append(track, name, amt)
    host.append(el)
    cells.set(day.date, { el, track, avail, spent, name, amt, label })

    if (!day.isPast) attachDrag(track, day.date)
  }
}

/** Update sizes/text in place. Safe to call mid-drag. */
function paintWeek() {
  for (const day of state.perDay) {
    const c = cells.get(day.date)
    if (!c) continue

    const weight = dragging?.date === day.date ? dragging.weight : day.weight
    // Past days have no forward allocation, so they're judged against the
    // baseline they were originally given — otherwise an overspent Tuesday
    // renders the same colour as a day that stayed within its share.
    const ref = day.planned ?? day.baseline
    const over = ref > 0 && day.spent > ref

    c.el.className =
      'day' +
      (day.isPast ? ' past' : '') +
      (day.isToday ? ' today' : '') +
      (!day.isPast && weight === 0 ? ' away' : '') +
      (dragging?.date === day.date ? ' dragging' : '')

    // Wide translucent fill = availability. This is what the drag manipulates,
    // so the gesture has a direct 1:1 visual it controls.
    c.avail.style.height = day.isPast ? '0%' : `${(weight / MAX_WEIGHT) * 100}%`

    // Narrow solid bar = usage, measured against that day's own allocation.
    const frac = ref > 0 ? Math.min(1.15, day.spent / ref) : 0
    c.spent.style.height = `${frac * 100}%`
    c.spent.classList.toggle('over', over)

    c.label.textContent = day.isPast ? '' : levelName(weight)
    c.amt.textContent = day.isPast
      ? pct(day.spent)
      : `${pct(day.spent)} / ${day.planned == null ? '—' : pct(day.planned)}`
  }
}

function attachDrag(track, date) {
  let startY = 0
  let startWeight = 1
  let moved = false
  let pending = null

  const current = () => state.perDay.find((d) => d.date === date)

  const commit = (final) => {
    const overrides = { ...state.plan.dayOverrides, [date]: dragging.weight }
    if (final) {
      const w = dragging.weight
      dragging = null
      patchPlan({ dayOverrides: { ...state.plan.dayOverrides, [date]: w } })
    } else {
      patchPlan({ dayOverrides: overrides })
    }
  }

  const onMove = (e) => {
    if (!dragging) return
    e.preventDefault()
    const delta = ((startY - e.clientY) / track.offsetHeight) * MAX_WEIGHT
    const w = Math.max(0, Math.min(MAX_WEIGHT, Math.round((startWeight + delta) / STEP) * STEP))
    if (Math.abs(w - dragging.weight) > 1e-9) {
      dragging.weight = Number(w.toFixed(2))
      moved = true
      paintWeek()
      // Throttle server round-trips so other columns update live without
      // flooding the socket on every pixel.
      if (!pending) pending = setTimeout(() => { pending = null; if (dragging) commit(false) }, 120)
    }
  }

  const onUp = (e) => {
    if (!dragging) return
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    if (pending) { clearTimeout(pending); pending = null }
    try { track.releasePointerCapture(e.pointerId) } catch {}
    if (moved) commit(true)
    else { dragging = null; paintWeek() }
  }

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const day = current()
    if (!day) return
    startY = e.clientY
    startWeight = day.weight
    moved = false
    dragging = { date, weight: day.weight }

    // Listen on window so the gesture keeps working when the cursor leaves the
    // column. Pointer capture is a nice-to-have on top — it must NOT be able to
    // abort setup, or a throw here silently kills the whole drag.
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    try { track.setPointerCapture(e.pointerId) } catch {}

    paintWeek()
  })

  // Wheel over a column nudges it — easier than dragging for small tweaks.
  track.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const day = current()
      if (!day) return
      const w = Math.max(0, Math.min(MAX_WEIGHT, day.weight + (e.deltaY < 0 ? STEP : -STEP)))
      patchPlan({ dayOverrides: { ...state.plan.dayOverrides, [date]: Number(w.toFixed(2)) } })
    },
    { passive: false },
  )

  // Double-click clears the override back to the weekday default.
  track.addEventListener('dblclick', () => {
    const next = { ...state.plan.dayOverrides }
    delete next[date]
    patchPlan({ dayOverrides: next })
  })
}

$('refresh').addEventListener('click', () => load(true))
$('week-dow').addEventListener('change', (e) =>
  patchPlan({ weekStart: { ...state.plan.weekStart, dow: Number(e.target.value) } }),
)
$('week-hour').addEventListener('change', (e) =>
  patchPlan({ weekStart: { ...state.plan.weekStart, hour: Number(e.target.value) } }),
)
$('cal-pct').addEventListener('change', (e) => {
  const v = e.target.value === '' ? null : Number(e.target.value)
  if (v == null) return
  patchPlan({ calibratePct: v })
})

load()
setInterval(() => { if (!dragging) load() }, 60_000)
