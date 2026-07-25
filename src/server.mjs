import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from './scan.mjs'
import { loadPlan, savePlan, computeState } from './budget.mjs'

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
      const state = computeState({ buckets, limitEvents, plan })
      return json(res, 200, { ...state, fileCount })
    }

    if (url.pathname === '/api/plan' && req.method === 'POST') {
      const body = await readBody(req)
      let next = { ...(await loadPlan()), ...body }

      // Calibration in the user's own units: they read a "% used this week"
      // off /usage, and we solve for the capacity that makes it true. No
      // dollars involved — the subscription has no dollar meter.
      if (body.calibratePct != null) {
        delete next.calibratePct
        const pct = Number(body.calibratePct)
        const { buckets: b2, limitEvents: l2 } = await getScan()
        const st = computeState({ buckets: b2, limitEvents: l2, plan: next })
        if (pct > 0 && pct <= 100 && st.week.spent > 0) {
          next.capacity = { mode: 'manual', weeklyUsd: st.week.spent / (pct / 100) }
        } else if (pct === 0) {
          next.capacity = { mode: 'auto', weeklyUsd: null }
        }
      }

      const plan = await savePlan(next)
      const { buckets, limitEvents, fileCount } = await getScan()
      return json(res, 200, { ...computeState({ buckets, limitEvents, plan }), fileCount })
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
