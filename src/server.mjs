import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from './scan.mjs'
import { loadPlan, savePlan, computeState, solveFromObservations, costBetween, weekWindow } from './budget.mjs'
import { POOLS } from './pricing.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(HERE, '..', 'web')
const PORT = Number(process.env.BUDGET_PORT || 4478)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

let cached = null
let cachedAt = 0
const TTL = 15_000

/**
 * Every plan mutation is a read-modify-write, and the drag handler fires one
 * every 120ms. Run them one at a time so two in-flight saves can't both read
 * the same "before" state and have the later write silently drop the earlier
 * edit. Atomic writes prevent a torn file; this prevents a lost update.
 */
let planQueue = Promise.resolve()
function withPlanLock(fn) {
  const run = planQueue.then(fn, fn)
  planQueue = run.then(
    () => {},
    () => {},
  )
  return run
}

async function getScan(force = false) {
  if (!force && cached && Date.now() - cachedAt < TTL) return cached
  cached = await scan()
  cachedAt = Date.now()
  return cached
}

/** Every pool gets its own independent view; the plan (weights, reserve) is shared. */
function buildState(buckets, limitEvents, plan, fileCount) {
  const pools = {}
  for (const id of Object.keys(POOLS)) {
    pools[id] = computeState({ buckets, limitEvents, plan, pool: id })
  }
  return { pools, poolMeta: POOLS, plan, fileCount }
}

function json(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(s)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

/**
 * Calibration feedback carries its severity rather than leaving the client to
 * infer it. "Fable weight couldn't be measured" and "those readings don't solve"
 * are different outcomes — the first happened alongside a successful calibration
 * — and a bare string made the dialog treat every note as a failure.
 */
const info = (text) => ({ level: 'info', text })
const warn = (text) => ({ level: 'warn', text })

/**
 * Apply one plan patch and persist it. MUST run under `withPlanLock` — it reads
 * the plan, derives from it, and writes it back.
 */
async function applyPlanPatch(body) {
  const next = { ...(await loadPlan()), ...body }
  let calibrationNote = null

  // Calibration in the user's own units: they read a "% used this week"
  // off /usage for one pool, and we solve for the capacity that makes it
  // true. No dollars involved — the subscription has no dollar meter.
  // Clearing is its own signal, never a magic value. 0% is a reading someone
  // can genuinely see on /usage — Fable sits at 0 all week for anyone who
  // doesn't use it, and every meter reads 0 right after a reset. Overloading 0
  // as "clear" made those readings unenterable, which locked non-Fable users
  // out of calibration entirely.
  if (body.calibrateClear) {
    delete next.calibrateClear
    delete next.calibratePool
    const target = body.calibratePool || 'all'
    next.capacity = { ...next.capacity }

    calibrationNote = info(
      target === 'block'
        ? 'Block calibration cleared — back to inferring.'
        : 'Week and Fable calibration cleared — back to inferring from history.',
    )

    if (target === 'block') {
      next.capacity.block = { mode: 'auto', weeklyUsd: null }
    } else {
      // Clearing one of the pair resets BOTH capacities and the Fable weight —
      // they were solved jointly, so a half-reset leaves the surviving reading
      // to be re-solved against a weight it never produced. Reset means reset.
      const { start: wkStart } = weekWindow(new Date(), next.weekStart)
      next.observed = { weekPct: null, fablePct: null, weekOf: wkStart.toISOString() }
      next.capacity.all = { mode: 'auto', weeklyUsd: null }
      next.capacity.fable = { mode: 'auto', weeklyUsd: null }
      next.fableWeight = 1
    }

    return { plan: await savePlan(next), calibrationNote }
  }

  if (body.calibratePct != null) {
    delete next.calibratePct
    delete next.calibratePool
    const target = body.calibratePool || 'all'
    const p = Number(body.calibratePct)
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      return { plan: next, calibrationNote: warn('Percentages must be between 0 and 100.') }
    }
    const { buckets: b2, limitEvents: l2 } = await getScan()
    // The block meter calibrates against the CURRENT 5h block, not the week.
    const basisPool = target === 'block' ? 'all' : target
    const st = computeState({ buckets: b2, limitEvents: l2, plan: next, pool: basisPool })
    const observed = target === 'block' ? st.block.spent : st.week.spent

    next.capacity = { ...next.capacity }
    next.observed = { ...(next.observed || {}) }

    if (target === 'block') {
      // The 5h limit is independent of the weekly one — solve it alone.
      if (p === 0) {
        // Valid but unsolvable: the limit would be observed / 0. A block that
        // reads 0% has just rolled over, so there is nothing to divide by yet.
        calibrationNote = warn(
          observed > 0
            ? 'Block reads 0% but usage was recorded in it — likely rounding; recalibrate once it shows 1% or more.'
            : 'Block reads 0% with no usage in it yet — nothing to solve against.',
        )
      } else if (observed > 0) {
        next.capacity.block = { mode: 'manual', weeklyUsd: observed / (p / 100) }
        calibrationNote = info('5-hour block limit calibrated.')
      } else {
        calibrationNote = warn('No usage recorded in the current block yet, so its limit could not be solved.')
      }
    } else {
      // Week and Fable share two unknowns (weekly limit + Fable weight), so
      // one reading alone can't determine either. Remember it, and solve
      // jointly as soon as both are known.
      const { start: wkStart } = weekWindow(new Date(), next.weekStart)
      const wkKey = wkStart.toISOString()

      // Both readings must describe the SAME week. `fableUnits`/`otherUnits`
      // below are measured over the current window, so pairing today's week %
      // with a Fable % read last week solves the weight against usage that
      // reading never saw — which is how the Fable meter drifts. Drop stale
      // readings instead of silently mixing windows.
      if (next.observed.weekOf !== wkKey) {
        next.observed = { weekPct: null, fablePct: null, weekOf: wkKey }
      }

      next.observed[target === 'fable' ? 'fablePct' : 'weekPct'] = p

      const { weekPct, fablePct } = next.observed
      // Measure the two pools DIRECTLY at weight 1. Deriving them from a
      // computeState total is fragile — it silently returned zero when the
      // default pool name went stale, and a zero here quietly degrades the
      // solve to "no correction" instead of failing loudly.
      const nowD = new Date()
      const fableUnits = costBetween(b2, wkStart, nowD, 'fable', 1)
      const otherUnits = costBetween(b2, wkStart, nowD, 'other', 1)

      if (weekPct != null && fablePct != null) {
        const sol = solveFromObservations({
          weekPct, fablePct,
          fableShare: next.fableShare ?? 0.5,
          fableUnits, otherUnits,
          currentFableWeight: next.fableWeight ?? 1,
        })
        if (sol.error) {
          calibrationNote = warn(sol.error)
        } else {
          next.fableWeight = sol.fableWeight
          next.capacity.all = { mode: 'manual', weeklyUsd: sol.weeklyUsd }
          next.capacity.fable = { mode: 'auto', weeklyUsd: null } // derived from share
          calibrationNote = info(sol.note || 'Calibrated from both readings.')
        }
      } else if (weekPct != null) {
        // Only the week is known — solve the limit at the current weight.
        // A 0% week has nothing to divide by; keep the reading, skip the solve.
        if (weekPct === 0) {
          calibrationNote = warn(
            'Week reads 0% — nothing to solve against yet. Enter the Fable % too, or recalibrate later in the week.',
          )
        } else {
          const total = fableUnits * (next.fableWeight ?? 1) + otherUnits
          next.capacity.all = { mode: 'manual', weeklyUsd: total / (weekPct / 100) }
          calibrationNote = info('Weekly limit calibrated. Enter the Fable % too — both are needed to solve the Fable weight.')
        }
      } else {
        calibrationNote = warn('Enter the week % too — both are needed to solve the Fable weight.')
      }
    }
  }

  return { plan: await savePlan(next), calibrationNote }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  try {
    if (url.pathname === '/api/state') {
      const { buckets, limitEvents, fileCount } = await getScan(url.searchParams.has('fresh'))
      const plan = await loadPlan()
      return json(res, 200, buildState(buckets, limitEvents, plan, fileCount))
    }

    if (url.pathname === '/api/plan' && req.method === 'POST') {
      const body = await readBody(req)
      const { plan, calibrationNote } = await withPlanLock(() => applyPlanPatch(body))
      const { buckets, limitEvents, fileCount } = await getScan()
      return json(res, 200, { ...buildState(buckets, limitEvents, plan, fileCount), calibrationNote })
    }

    // Static files. Only ever serve out of web/.
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
    const file = path.join(WEB, rel)
    if (!file.startsWith(WEB + path.sep)) {
      res.writeHead(403).end('forbidden')
      return
    }
    const buf = await fsp.readFile(file)
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404).end('not found')
      return
    }
    console.error(err)
    json(res, 500, { error: String(err && err.message) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`claude-budget listening on http://localhost:${PORT}`)
})
