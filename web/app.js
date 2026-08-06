const $ = (id) => document.getElementById(id)
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MAX_WEIGHT = 2
const STEP = 0.1
// Height of a full 24h day card; partial boundary days scale down from this.
const TRACK_PX = 280

let all = null // full API payload: { pools, poolMeta, plan, fileCount }
let state = null // the currently selected pool's view
let pool = 'all'
let dragging = null // { date, weight } while a gesture is live
const cells = new Map() // date -> { el, avail, spent, name, amt, label }

// Everything is expressed as a share of the WEEKLY ALLOWANCE. The underlying
// unit is a weighted token cost, but on a subscription there is no dollar
// meter — showing API prices would be a number that means nothing here.
//
// An INFERRED limit ("heaviest week you've run + 15%") is good enough to pace
// against — allocation only needs the week's relative shape — but it is not a
// number you can report as "72% of your limit". So every percentage-of-limit
// readout resolves through here and reads '—' until a real /usage figure has
// been entered. The calendar still renders shape, spend and weights.
const isEstimated = (c) => !!c?.estimated
const capacityUnits = () =>
  isEstimated(state?.capacity) ? null : (state?.capacity?.weeklyUsd ?? null)

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
/**
 * Outcome of the most recent calibration, shown under the calibration fields.
 * Held here rather than painted directly so it survives the re-renders that a
 * refresh or a poll triggers.
 */
let calNote = null

async function patchPlan(patch) {
  const seq = ++postSeq
  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const next = await res.json()
  // Only a calibration patch may change the note — including clearing it on a
  // clean solve. Otherwise dragging the availability calendar, which posts every
  // 120ms, would wipe the message before it could be read.
  if ('calibratePct' in patch || 'calibrateClear' in patch) calNote = next.calibrationNote ?? null
  // Ignore responses that a newer in-flight save has already superseded.
  if (seq === postSeq) apply(next)
  return next
}

function apply(next) {
  all = next
  if (!all.pools[pool]) pool = 'all'
  state = { ...all.pools[pool], plan: all.plan, fileCount: all.fileCount }
  // Each section paints independently. A single bad element reference used to
  // throw inside paintSummary and take the whole calendar down with it, since
  // the week renders after it.
  for (const step of [paintPools, paintSummary, syncWeekDom, paintWeek, syncSetup]) {
    try {
      step()
    } catch (err) {
      console.error(`render step ${step.name} failed:`, err)
    }
  }
}

/** Tabs, each showing its own week % so both meters are visible at a glance. */
function paintPools() {
  const host = $('pools')
  host.textContent = ''
  for (const [id, meta] of Object.entries(all.poolMeta)) {
    const s = all.pools[id]
    const cap = isEstimated(s.capacity) ? null : s.capacity.weeklyUsd
    const used = cap ? (s.week.spent / cap) * 100 : null

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'pool' + (id === pool ? ' active' : '')
    btn.setAttribute('role', 'tab')
    btn.setAttribute('aria-selected', String(id === pool))

    const name = document.createElement('span')
    name.className = 'pool-name'
    name.textContent = meta.label

    const val = document.createElement('span')
    val.className = 'pool-val'
    val.textContent = used == null ? '—' : `${Math.round(used)}%`
    if (used != null && used >= 90) val.classList.add('bad')
    else if (used != null && used >= 75) val.classList.add('warn')

    const sub = document.createElement('span')
    sub.className = 'pool-sub'
    if (meta.kind === 'sublimit') {
      // Show the share this cap ACTUALLY represents. Once calibrated it can
      // differ from the assumed default, and printing the assumption would
      // contradict the number right above it.
      const overallCap = s.overall?.capacity
      const share = overallCap && cap ? cap / overallCap : (s.overall?.share ?? null)
      sub.textContent = share
        ? `capped at ${Math.round(share * 100)}% of the week`
        : 'sub-limit of the weekly total'
    } else {
      sub.textContent = 'full weekly limit'
    }

    btn.append(name, val, sub)
    btn.addEventListener('click', () => {
      pool = id
      apply(all)
    })
    host.append(btn)
  }
}

const NEEDS_CAL = 'Enter your /usage % below to turn history into real percentages.'

function verdictFor(pct) {
  if (pct == null) return [isEstimated(state.capacity) ? NEEDS_CAL : 'Not enough history to pace yet.', '']
  if (pct >= 99) return ["Today's allocation is exhausted.", 'bad']
  const p = Math.round(pct * 100)
  if (pct < 0.6) return [`${p}% of today's share used — comfortable.`, 'good']
  if (pct < 0.95) return [`${p}% of today's share used — on pace.`, 'warn']
  if (pct < 1.4) return [`${p}% of today's share — borrowing from later in the week.`, 'warn']
  return [`${p}% of today's share — well over.`, 'bad']
}

/** Weekly gauge — same shape as the daily one, but paced against the plan. */
function paintWeekGauge() {
  const cap = capacityUnits()
  const used = cap ? state.week.spent / cap : null

  $('week-value').textContent = used == null ? '—' : `${Math.min(999, Math.round(used * 100))}%`

  const reset = new Date(state.week.end)
  const resetLabel = reset.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
  // The reset moment is a fact about the window, not about the limit — keep it
  // visible even when the percentage can't be shown.
  $('week-sub').textContent =
    used == null ? `resets ${resetLabel}` : `of weekly allowance · resets ${resetLabel}`

  const meter = $('week-meter')
  meter.style.width = `${Math.min(100, (used ?? 0) * 100)}%`

  // Where the plan says you should be right now. The gap between the fill and
  // this mark IS the running balance, made visual.
  const expected = cap && state.week.expected != null ? state.week.expected / cap : null
  const mark = $('week-pace')
  if (expected == null) {
    mark.hidden = true
  } else {
    mark.hidden = false
    mark.style.left = `${Math.min(100, expected * 100)}%`
  }

  const ratio = expected > 0 ? used / expected : null
  meter.style.background =
    ratio == null
      ? 'var(--muted)'
      : ratio <= 1.02
        ? 'var(--good)'
        : ratio <= 1.25
          ? 'var(--warn)'
          : 'var(--bad)'

  const el = $('week-verdict')
  if (used == null || ratio == null) {
    el.textContent = isEstimated(state.capacity) ? NEEDS_CAL : 'Not enough history to pace yet.'
    el.className = 'verdict'
    return
  }
  const left = Math.max(0, 100 - used * 100)
  const dl = state.week.daysLeft
  const dayWord = dl === 1 ? 'day' : 'days'
  // Language is deliberately consistent with the Running balance stat:
  // burning faster than planned is always "over plan", never "ahead".
  // Colour still keys off the RATIO (being 2% over on day one matters more than
  // on day six), but the printed figure is points of the weekly limit — the same
  // basis as the Running balance stat. Printing a relative overshoot here and an
  // absolute one there is why the two lines never matched.
  const off = pct(Math.abs(state.balance ?? 0))
  if (ratio <= 1.02) {
    el.textContent =
      ratio < 0.9
        ? `${off} under plan — ${left.toFixed(0)}% left for the final ${dl} ${dayWord}.`
        : `On plan — ${left.toFixed(0)}% left for the final ${dl} ${dayWord}.`
    el.className = 'verdict good'
  } else if (ratio <= 1.25) {
    el.textContent = `${off} over plan — ${left.toFixed(0)}% left for ${dl} ${dayWord}.`
    el.className = 'verdict warn'
  } else {
    el.textContent = `${off} over plan — only ${left.toFixed(0)}% left for ${dl} ${dayWord}.`
    el.className = 'verdict bad'
  }
}

/** Show a meter's current % in its calibration box (unless being edited). */
function paintCalField(id, s) {
  const el = $(id)
  if (document.activeElement === el) return
  // Pre-fill only a number that means something. Seeding the box with a reading
  // derived from a guessed limit invites confirming the guess back to itself.
  const cap = isEstimated(s?.capacity) ? null : s?.capacity?.weeklyUsd
  el.value = cap ? String(Math.round((s.week.spent / cap) * 100)) : ''
  el.classList.toggle('calibrated', ['manual', 'calibrated-share'].includes(s?.capacity?.source))
}

function paintBlockCalField() {
  const el = $('cal-block')
  if (document.activeElement === el) return
  const b = all.pools.all.block
  el.value = b?.open && b.pct != null && !b.estimated ? String(Math.round(b.pct * 100)) : ''
  el.classList.toggle('calibrated', b?.source === 'manual')
}

/**
 * Say what the last calibration did. A solve can succeed and still be worth
 * explaining — a 0% Fable reading calibrates the weekly limit but leaves the
 * Fable weight unmeasured — so `level` decides whether this reads as a
 * confirmation or a problem, rather than everything looking like an error.
 */
function paintCalNote() {
  const el = $('cal-note')
  const txt = $('cal-note-text')
  if (!calNote || !calNote.text) {
    el.hidden = true
    txt.textContent = ''
    return
  }
  txt.textContent = calNote.text
  el.className = `cal-note ${calNote.level === 'warn' ? 'warn' : 'info'}`
  el.hidden = false
}

function paintSummary() {
  const wStart = new Date(state.week.start)
  const wEnd = new Date(state.week.end)
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  $('window-label').textContent =
    `Week of ${fmt(wStart)} – ${fmt(new Date(wEnd - 1))} · ${state.fileCount} transcripts scanned`

  // Headline is "how much of today's share is gone", which is the number that
  // actually decides whether to keep working.
  // Today's share is a slice of the weekly limit, so an uncalibrated limit makes
  // this percentage just as invented as the weekly one.
  const used = isEstimated(state.capacity) ? null : state.today.pct
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

  paintWeekGauge()

  // Debt / reserve — the two halves of the hybrid policy, stated explicitly.
  // Same number as the weekly gauge's verdict, in the same units (points of the
  // weekly limit) — they are two renderings of `balance`, so they cannot drift.
  const debtEl = $('debt')
  if (state.balance == null || capacityUnits() == null) {
    debtEl.textContent = '—'
    debtEl.className = ''
  } else if (state.balance > 0) {
    debtEl.textContent = `${pct(state.balance)} over plan`
    debtEl.className = 'bad'
  } else {
    debtEl.textContent = `${pct(-state.balance)} under plan`
    debtEl.className = 'good'
  }

  $('reserve').textContent = state.reserve
    ? `${pct(state.reserve.total)} ${state.reserve.released ? 'released' : 'held back'}`
    : '—'

  // The 5-hour limit has its OWN capacity — showing it as a slice of the
  // weekly allowance would be a different limit's number.
  const blk = state.block
  if (!blk?.open) {
    $('block-spent').textContent = 'none open'
    $('block-spent').className = ''
  } else {
    const bp = blk.pct == null || blk.estimated ? null : blk.pct * 100
    const ends = new Date(blk.endsAt)
    const mins = Math.max(0, Math.round((ends - new Date()) / 60000))
    const rem = mins >= 60 ? `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m` : `${mins}m`
    $('block-spent').textContent =
      `${bp == null ? '—' : Math.round(bp) + '%'} · resets in ${rem}${blk.anchored ? '' : ' (est)'}`
    $('block-spent').className = bp == null ? '' : bp >= 90 ? 'bad' : bp >= 75 ? 'warn' : ''
  }

  if (document.activeElement !== $('block-reset')) {
    $('block-reset').value = blk?.endsAt
      ? `${String(new Date(blk.endsAt).getHours()).padStart(2, '0')}:${String(new Date(blk.endsAt).getMinutes()).padStart(2, '0')}`
      : ''
  }

  const src = state.capacity.source
  $('capacity-source').textContent =
    src === 'limit-event'
      ? `pinned by ${state.capacity.pins} real limit hit${state.capacity.pins > 1 ? 's' : ''}`
      : src === 'manual'
        ? 'calibrated by you'
        : src === 'calibrated-share'
          ? `calibrated — ${Math.round(state.capacity.share * 100)}% of the week`
          : src === 'derived'
          ? `${Math.round((state.overall?.share ?? 0.5) * 100)}% of the overall limit`
          : src === 'history'
            ? 'not calibrated — estimated from history'
            : 'unknown — no history yet'

  // On the Fable meter, the week total is the other thing that can stop you.
  const bindEl = $('binding')
  if (state.overall && state.overall.capacity) {
    const overallUsed = (state.overall.spent / state.overall.capacity) * 100
    bindEl.parentElement.hidden = false
    bindEl.textContent = `${Math.round(overallUsed)}% of week used overall`
    bindEl.className = overallUsed >= 90 ? 'bad' : overallUsed >= 75 ? 'warn' : ''
  } else {
    bindEl.parentElement.hidden = true
  }

  // Each field shows the meter's CURRENT reading, so re-calibrating is just
  // correcting a number you can already see rather than recalling one.
  paintCalField('cal-all', all.pools.all)
  paintCalField('cal-fable', all.pools.fable)
  paintBlockCalField()
  paintCalNote()

  const rf = Math.round((state.plan.reserveFraction ?? 0) * 100)
  if (document.activeElement !== $('reserve-pct')) $('reserve-pct').value = String(rf)
  $('reserve-out').textContent = `${rf}%`
  if (document.activeElement !== $('reserve-days')) {
    $('reserve-days').value = String(state.plan.reserveReleaseDays ?? 2)
  }

  $('days-left').textContent = `${state.week.daysLeft}`

  $('week-dow').value = String(state.plan.weekStart.dow)
  const p2 = (n) => String(n).padStart(2, '0')
  if (document.activeElement !== $('week-time')) {
    $('week-time').value = `${p2(state.plan.weekStart.hour)}:${p2(state.plan.weekStart.minute || 0)}`
  }
}

/** Create day columns once. Rebuild only when the set of dates changes. */
function syncWeekDom() {
  const host = $('week')
  const wanted = state.perDay.map((d) => d.date).join(',')
  if (host.dataset.key === wanted) return
  host.dataset.key = wanted
  host.textContent = ''
  host.style.setProperty('--cols', state.perDay.length)
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

    // Past days are adjustable too — raising a day you overspent is a
    // deliberate re-plan: its baseline grows, the measured debt shrinks, and
    // the remaining days' shares tighten to keep the week at 100%. The dimmed
    // rendering still marks it as history.
    attachDrag(track, day.date)
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
    // Any spend on a zero-share (away) day is over by definition.
    const over = ref > 0 ? day.spent > ref : day.spent > 0

    c.el.className =
      'day' +
      (day.isPast ? ' past' : '') +
      (day.isToday ? ' today' : '') +
      (!day.isPast && weight === 0 ? ' away' : '') +
      (dragging?.date === day.date ? ' dragging' : '')

    // Card height is proportional to the hours the day has inside the window —
    // the boxes read as a day-granular time axis. The first day lost its
    // morning, so it shrinks from the top (bottom edge stays on the shared
    // baseline, which is the grid's natural end-alignment); the last day loses
    // its evening, so it shrinks from the bottom (a margin below re-anchors its
    // top edge to the full-day line while the name labels stay in their row).
    const frac = day.frac ?? 1
    c.track.style.height = `${frac * TRACK_PX}px`
    c.track.style.marginBottom = day.clip === 'bottom' ? `${(1 - frac) * TRACK_PX}px` : ''

    // Wide translucent fill = availability. This is what the drag manipulates,
    // so the gesture has a direct 1:1 visual it controls. Past days keep their
    // fill (dimmed by .past) — it's the reference the usage bar is read against.
    // Because fill height scales with the card and the card scales with hours,
    // fill AREA is proportional to the day's share of the week.
    const availH = (weight / MAX_WEIGHT) * 100
    c.avail.style.height = `${availH}%`

    // Narrow solid bar = usage, on the SAME scale as the fill: the fill's top
    // edge is 100% of that day's share, so a bar poking above the shading
    // reads as over-share at a glance. Zero-share day with spend gets a small
    // red stub — there is no scale to draw it on, only the fact of the spend.
    const barH = ref > 0 ? Math.min(100, (day.spent / ref) * availH) : day.spent > 0 ? 12 : 0
    c.spent.style.height = `${barH}%`
    c.spent.classList.toggle('over', over)

    // A stub card (e.g. a 6-hour reset day) has no headroom for the caption.
    c.label.textContent = frac < 0.5 ? '' : levelName(weight)
    // Past days show spent against their baseline share, which is still
    // adjustable — re-planning a day you overspent recomputes the debt.
    c.amt.textContent = `${pct(day.spent)} / ${ref == null ? '—' : pct(ref)}`
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

  // Double-click clears the override back to the weekday default.
  track.addEventListener('dblclick', () => {
    const next = { ...state.plan.dayOverrides }
    delete next[date]
    patchPlan({ dayOverrides: next })
  })
}

/**
 * Blocking setup gate.
 *
 * An uncalibrated dashboard has no percentages on it — the tool can see what you
 * spent but not what you're allowed, so it can only show dashes. Surfacing that
 * and trusting people to find the settings row is how you get a tool everyone
 * believes is broken, so the numbers are collected before anything else renders.
 *
 * `setupDismissed` is deliberately session-only and not persisted: the escape
 * hatch exists so a genuinely unsolvable week can't lock you out, not to become
 * a permanent way to run the tool blind.
 */
let setupDismissed = false

function syncSetup() {
  const needed = isEstimated(all.pools.all.capacity) && !setupDismissed
  $('setup').hidden = !needed
  if (!needed) return
  // Seed from the saved plan so the dialog agrees with the settings row.
  const ws = all.plan.weekStart
  const p2 = (n) => String(n).padStart(2, '0')
  if (document.activeElement !== $('setup-dow')) $('setup-dow').value = String(ws.dow)
  if (document.activeElement !== $('setup-time')) {
    $('setup-time').value = `${p2(ws.hour)}:${p2(ws.minute || 0)}`
  }
}

function wireSetup() {
  const err = $('setup-error')
  const fail = (msg, allowSkip) => {
    err.textContent = msg
    err.hidden = false
    if (allowSkip) $('setup-skip').hidden = false
  }

  $('setup-skip').addEventListener('click', () => {
    setupDismissed = true
    $('setup').hidden = true
  })

  $('setup-go').addEventListener('click', async () => {
    const weekRaw = $('setup-week').value.trim()
    const fableRaw = $('setup-fable').value.trim()
    const week = Number(weekRaw)
    const fable = Number(fableRaw)
    // Both or nothing — one reading leaves two unknowns and one equation.
    // "Both" means both FILLED IN, not both nonzero: Fable reads 0% for anyone
    // who doesn't use it, and rejecting that made calibration impossible for
    // them. Blank is the only invalid entry.
    const valid = (raw, n) => raw !== '' && Number.isFinite(n) && n >= 0 && n <= 100
    if (!valid(weekRaw, week) || !valid(fableRaw, fable)) {
      return fail('Enter both percentages, each between 0 and 100.', false)
    }

    const btn = $('setup-go')
    btn.disabled = true
    err.hidden = true
    try {
      const [h, m] = ($('setup-time').value || '00:00').split(':').map(Number)
      // Window first: the percentages describe that window, so solving before
      // it is set would solve against the wrong span of history.
      await patchPlan({
        weekStart: { dow: Number($('setup-dow').value), hour: h || 0, minute: m || 0 },
      })
      await patchPlan({ calibratePct: week, calibratePool: 'all' })
      const res = await patchPlan({ calibratePct: fable, calibratePool: 'fable' })

      // Whether it solved is the pass/fail test, NOT whether a note came back.
      // A successful solve can carry an advisory note (Fable at 0% calibrates
      // the weekly limit fine, it just can't measure the Fable weight), and
      // treating that note as an error kept the dialog up on a good result.
      // On success the note is left for the calibration row to show, so the
      // caveat survives the dialog closing instead of vanishing with it.
      if (!isEstimated(res.pools.all.capacity)) {
        $('setup').hidden = true
        return
      }
      return fail(
        res.calibrationNote?.text || 'Those readings could not be solved — check them against /usage.',
        true,
      )
    } catch (e) {
      fail(`Could not save: ${e.message}`, true)
    } finally {
      btn.disabled = false
    }
  })
}

$('refresh').addEventListener('click', () => load(true))

/**
 * Settings listeners are wired only AFTER the first state has loaded and the
 * controls have been populated from it.
 *
 * Wiring them at parse time is a data-loss bug: browsers restore previously
 * entered form values on reload and fire `change` for them. Those events are
 * indistinguishable from real input (they're trusted), so a plain reload would
 * silently POST stale values and rewrite the saved plan.
 */
function wireSettings() {
  $('week-dow').addEventListener('change', (e) =>
    patchPlan({ weekStart: { ...state.plan.weekStart, dow: Number(e.target.value) } }),
  )
  $('week-time').addEventListener('change', (e) => {
    const [h, m] = e.target.value.split(':').map(Number)
    if (Number.isNaN(h)) return
    patchPlan({ weekStart: { ...state.plan.weekStart, hour: h, minute: m || 0 } })
  })
  for (const [id, target] of [
    ['cal-all', 'all'],
    ['cal-fable', 'fable'],
    ['cal-block', 'block'],
  ]) {
    $(id).addEventListener('change', (e) => {
      // Blank is how you clear a calibration. 0 is a reading — Fable reads 0%
      // all week for anyone who doesn't use it, and every meter reads 0 right
      // after a reset — so it must reach the server as a number, not as a
      // request to wipe the calibration.
      const raw = e.target.value.trim()
      if (raw === '') return patchPlan({ calibrateClear: true, calibratePool: target })
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0 || n > 100) return
      patchPlan({ calibratePct: n, calibratePool: target })
    })
  }
  $('reserve-pct').addEventListener('input', (e) => {
    $('reserve-out').textContent = `${e.target.value}%`
  })
  $('reserve-pct').addEventListener('change', (e) =>
    patchPlan({ reserveFraction: Number(e.target.value) / 100 }),
  )
  $('reserve-days').addEventListener('change', (e) =>
    patchPlan({ reserveReleaseDays: Number(e.target.value) }),
  )
  $('block-reset').addEventListener('change', (e) => {
    if (!e.target.value) return patchPlan({ blockAnchor: null })
    const [h, m] = e.target.value.split(':').map(Number)
    // Interpret as the next occurrence of that clock time.
    const d = new Date()
    d.setHours(h, m || 0, 0, 0)
    if (d <= new Date()) d.setDate(d.getDate() + 1)
    patchPlan({ blockAnchor: d.toISOString() })
  })
}

load().then(() => {
  wireSettings()
  wireSetup()
})
setInterval(() => { if (!dragging) load() }, 60_000)
