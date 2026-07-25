import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { costOf, poolFor } from './pricing.mjs'

export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
export const DATA_DIR = path.join(os.homedir(), '.claude', 'budget-data')
const CACHE_FILE = path.join(DATA_DIR, 'scan-cache.json')

const CACHE_VERSION = 5 // v5 adds firstTs/lastTs for exact 5h block boundaries

async function listJsonl(dir) {
  const out = []
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listJsonl(p)))
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

async function loadCache() {
  try {
    const c = JSON.parse(await fsp.readFile(CACHE_FILE, 'utf8'))
    if (c.version === CACHE_VERSION) return c
  } catch {}
  return { version: CACHE_VERSION, files: {} }
}

async function saveCache(cache) {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await fsp.writeFile(CACHE_FILE, JSON.stringify(cache))
}

function bucketKey(iso) {
  // Hour bucket in LOCAL time — the whole point is pacing a human's day.
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`
}

function emptyBucket() {
  // `pools` holds per-limit-pool cost; `cost` stays the total for convenience.
  // firstTs/lastTs keep minute precision inside the hour so the 5-hour block
  // boundary can be exact instead of rounded to the top of the hour.
  return {
    cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, msgs: 0, pools: {},
    firstTs: null, lastTs: null,
  }
}

function addToBucket(b, model, usage, ts) {
  const c = costOf(model, usage)
  const pool = poolFor(model)
  b.cost += c
  if (!b.pools) b.pools = {}
  b.pools[pool] = (b.pools[pool] || 0) + c
  if (ts) {
    if (b.firstTs == null || ts < b.firstTs) b.firstTs = ts
    if (b.lastTs == null || ts > b.lastTs) b.lastTs = ts
  }
  b.input += usage.input_tokens || 0
  b.output += usage.output_tokens || 0
  b.cacheWrite += usage.cache_creation_input_tokens || 0
  b.cacheRead += usage.cache_read_input_tokens || 0
  b.msgs += 1
}

/**
 * Parse the appended region of one transcript file.
 * Returns { buckets, offset, limitEvents }.
 */
async function parseFrom(file, startOffset, seen) {
  const buckets = {}
  const limitEvents = []
  const stat = await fsp.stat(file)
  if (stat.size <= startOffset) return { buckets, offset: stat.size, limitEvents }

  const stream = fs.createReadStream(file, { start: startOffset, encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  let consumed = startOffset
  let lastCompleteOffset = startOffset

  for await (const line of rl) {
    // +1 for the newline that readline stripped.
    consumed += Buffer.byteLength(line, 'utf8') + 1
    if (!line) {
      lastCompleteOffset = consumed
      continue
    }

    let o
    try {
      o = JSON.parse(line)
    } catch {
      // Partial trailing line (file still being written) — stop before it.
      break
    }
    lastCompleteOffset = consumed

    // Rate-limit ground truth: Claude Code logs an error object when a limit is hit.
    if (o.error && (o.error.rateLimits || /usage limit|rate limit/i.test(o.error.message || ''))) {
      if (o.timestamp) limitEvents.push({ at: o.timestamp, detail: o.error.rateLimits || null })
    }

    const m = o.message
    if (!m || !m.usage || m.model === '<synthetic>') continue

    const id = m.id || o.requestId
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }

    const key = bucketKey(o.timestamp)
    if (!key) continue
    if (!buckets[key]) buckets[key] = emptyBucket()
    addToBucket(buckets[key], m.model, m.usage, Date.parse(o.timestamp) || null)
  }

  rl.close()
  stream.destroy()
  return { buckets, offset: lastCompleteOffset, limitEvents }
}

function mergeBuckets(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (!target[k]) target[k] = emptyBucket()
    const t = target[k]
    for (const [f, val] of Object.entries(v)) {
      if (f === 'pools') {
        if (!t.pools) t.pools = {}
        for (const [p, c] of Object.entries(val || {})) t.pools[p] = (t.pools[p] || 0) + c
      } else if (f === 'firstTs') {
        if (val != null && (t.firstTs == null || val < t.firstTs)) t.firstTs = val
      } else if (f === 'lastTs') {
        if (val != null && (t.lastTs == null || val > t.lastTs)) t.lastTs = val
      } else {
        t[f] += val
      }
    }
  }
}

/**
 * Scan all transcripts, incrementally. Returns hourly buckets keyed
 * "YYYY-MM-DDTHH" in local time, plus any detected rate-limit events.
 */
export async function scan() {
  const cache = await loadCache()
  const files = await listJsonl(PROJECTS_DIR)
  const seen = new Set()
  const total = {}
  const limitEvents = []
  let rescanned = 0

  for (const file of files) {
    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      continue
    }
    const prev = cache.files[file]

    // A file that shrank was rewritten — re-read it from scratch.
    const reusable = prev && prev.size <= stat.size && prev.mtimeMs <= stat.mtimeMs
    const startOffset = reusable ? prev.offset : 0
    const baseBuckets = reusable ? prev.buckets : {}

    if (!reusable || stat.size > prev.offset) {
      rescanned++
      const { buckets, offset, limitEvents: le } = await parseFrom(file, startOffset, seen)
      const merged = { ...baseBuckets }
      mergeBuckets(merged, buckets)
      cache.files[file] = { size: stat.size, mtimeMs: stat.mtimeMs, offset, buckets: merged }
      limitEvents.push(...(prev?.limitEvents || []), ...le)
      cache.files[file].limitEvents = [...(prev?.limitEvents || []), ...le]
    } else {
      limitEvents.push(...(prev.limitEvents || []))
    }

    mergeBuckets(total, cache.files[file].buckets)
  }

  // Drop cache entries for files that no longer exist.
  for (const f of Object.keys(cache.files)) {
    if (!files.includes(f)) delete cache.files[f]
  }

  await saveCache(cache)
  return { buckets: total, limitEvents, fileCount: files.length, rescanned }
}
