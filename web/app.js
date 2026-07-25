const $ = (id) => document.getElementById(id)
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MAX_WEIGHT = 2

let state = null

const usd = (n) =>
  n == null ? '—' : n >= 100 ? `$${n.toFixed(0)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`

async function load(fresh = false) {
  const res = await fetch(`/api/state${fresh ? '?fresh=1' : ''}`)
  state = await res.json()
  render()
}

async function patchPlan(patch) {
  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  state = await res.json()
  render()
}

function verdictFor(pct) {
  if (pct == null) return ['Not enough history to pace yet.', '']
  if (pct < 0.6) return [`${Math.round(pct * 100)}% of today's share used — comfortable.`, 'good']
  if (pct < 0.95) return [`${Math.round(pct * 100)}% of today's share used — on pace.`, 'warn']
  if (pct < 1.4) return [`${Math.round(pct * 100)}% of today's share — you're borrowing from later in the week.`, 'warn']
  return [`${Math.round(pct * 100)}% of today's share — well over; later days just shrank.`, 'bad']
}

function render() {
  if (!state) return

  const wStart = new Date(state.week.start)
  const wEnd = new Date(state.week.end)
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  $('window-label').textContent = `Week of ${fmt(wStart)} – ${fmt(new Date(wEnd - 1))} · ${state.fileCount} transcripts scanned`

  $('today-spent').textContent = usd(state.today.spent)
  $('today-allow').textContent = state.today.allowance == null ? '' : `/ ${usd(state.today.allowance)}`

  const pct = state.today.pct
  const meter = $('today-meter')
  meter.style.width = `${Math.min(100, (pct ?? 0) * 100)}%`
  meter.style.background = pct == null ? 'var(--muted)' : pct < 0.6 ? 'var(--good)' : pct < 1 ? 'var(--warn)' : 'var(--bad)'

  const [text, cls] = verdictFor(pct)
  $('verdict').textContent = text
  $('verdict').className = `verdict ${cls}`

  $('week-spent').textContent = usd(state.week.spent)
  $('week-remaining').textContent = usd(state.remaining)
  $('block-spent').textContent = usd(state.block5h.spent)

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
  $('cap-mode').value = state.plan.capacity.mode
  $('cap-value').value = state.plan.capacity.weeklyUsd ?? ''
  $('cap-value').disabled = state.plan.capacity.mode !== 'manual'

  renderWeek()

  $('footnote').textContent =
    'Cost is a weighted proxy for subscription-limit consumption (output ≫ cache-write ≫ cache-read), not a bill. ' +
    'Absolute percentages drift; the relative split between days is what paces you.'
}

function renderWeek() {
  const host = $('week')
  host.innerHTML = ''

  const scale = Math.max(
    0.01,
    ...state.perDay.map((d) => Math.max(d.spent, d.planned || 0)),
  )

  for (const day of state.perDay) {
    const el = document.createElement('div')
    el.className = 'day' + (day.isPast ? ' past' : '') + (day.isToday ? ' today' : '') + (day.weight === 0 ? ' away' : '')
    el.dataset.date = day.date

    const track = document.createElement('div')
    track.className = 'track'

    const plannedH = day.planned == null ? 0 : (day.planned / scale) * 100
    const spentH = (day.spent / scale) * 100
    const over = day.planned != null && day.spent > day.planned

    track.innerHTML = `
      <div class="planned-bar" style="height:${Math.min(100, plannedH)}%"></div>
      <div class="spent-bar${over ? ' over' : ''}" style="height:${Math.min(100, spentH)}%"></div>
      ${day.planned == null ? '' : `<div class="cap-line" style="bottom:${Math.min(100, plannedH)}%"></div>`}
    `

    const name = document.createElement('div')
    name.className = 'name'
    const dowEl = document.createElement('b')
    dowEl.textContent = DOW[day.dow]
    name.append(dowEl, document.createTextNode(day.date.slice(5)))

    const amt = document.createElement('div')
    amt.className = 'amt'
    amt.textContent = day.isPast
      ? usd(day.spent)
      : `${usd(day.spent)} / ${day.planned == null ? '—' : usd(day.planned)}`

    el.append(track, name, amt)
    if (!day.isPast) attachDrag(el, track, day)
    host.append(el)
  }
}

function attachDrag(el, track, day) {
  let dragging = false
  let startY = 0
  let startWeight = day.weight

  const apply = (w) => {
    const clamped = Math.max(0, Math.min(MAX_WEIGHT, Math.round(w * 10) / 10))
    el.classList.toggle('away', clamped === 0)
    return clamped
  }

  const onMove = (e) => {
    if (!dragging) return
    e.preventDefault()
    const y = e.touches ? e.touches[0].clientY : e.clientY
    // 190px of track spans the full 0..MAX_WEIGHT range.
    const delta = ((startY - y) / 190) * MAX_WEIGHT
    day.weight = apply(startWeight + delta)
    track.querySelector('.planned-bar').style.opacity = 0.4 + day.weight * 0.25
  }

  const onUp = () => {
    if (!dragging) return
    dragging = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    patchPlan({
      dayOverrides: { ...state.plan.dayOverrides, [day.date]: day.weight },
    })
  }

  track.addEventListener('pointerdown', (e) => {
    dragging = true
    startY = e.clientY
    startWeight = day.weight
    track.setPointerCapture?.(e.pointerId)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })

  // Double-click clears the override back to the weekday default.
  track.addEventListener('dblclick', () => {
    const next = { ...state.plan.dayOverrides }
    delete next[day.date]
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
$('cap-mode').addEventListener('change', (e) =>
  patchPlan({ capacity: { ...state.plan.capacity, mode: e.target.value } }),
)
$('cap-value').addEventListener('change', (e) =>
  patchPlan({ capacity: { mode: 'manual', weeklyUsd: Number(e.target.value) || null } }),
)

load()
setInterval(() => load(), 60_000)
