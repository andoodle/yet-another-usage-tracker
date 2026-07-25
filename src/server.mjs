import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from './scan.mjs'
import { loadPlan, savePlan, computeState } from './budget.mjs'
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
      const next = { ...(await loadPlan()), ...body }

      // Calibration in the user's own units: they read a "% used this week"
      // off /usage for one pool, and we solve for the capacity that makes it
      // true. No dollars involved — the subscription has no dollar meter.
      if (body.calibratePct != null) {
        delete next.calibratePct
        delete next.calibratePool
        const target = body.calibratePool || 'all'
        const p = Number(body.calibratePct)
        const { buckets: b2, limitEvents: l2 } = await getScan()
        // The block meter calibrates against the CURRENT 5h block, not the week.
        const basisPool = target === 'block' ? 'all' : target
        const st = computeState({ buckets: b2, limitEvents: l2, plan: next, pool: basisPool })
        const observed = target === 'block' ? st.block.spent : st.week.spent

        next.capacity = { ...next.capacity }
        if (p === 0) {
          next.capacity[target] = { mode: 'auto', weeklyUsd: null }
        } else if (p > 0 && p <= 100 && observed > 0) {
          const implied = observed / (p / 100)
          if (target === 'fable') {
            // Store the sub-limit as a share so it tracks the weekly limit.
            const overall = st.overall?.capacity
            next.capacity.fable = overall
              ? { mode: 'share', share: implied / overall }
              : { mode: 'manual', weeklyUsd: implied }
          } else {
            next.capacity[target] = { mode: 'manual', weeklyUsd: implied }
          }
        }
      }

      const plan = await savePlan(next)
      const { buckets, limitEvents, fileCount } = await getScan()
      return json(res, 200, buildState(buckets, limitEvents, plan, fileCount))
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
