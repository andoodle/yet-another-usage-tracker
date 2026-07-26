import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { costOf, poolFor } from './pricing.mjs'

export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
export const DATA_DIR = path.join(os.homedir(), '.claude', 'budget-data')
const CACHE_FILE = path.join(DATA_DIR, 'scan-cache.json')

// v6 caches per-MESSAGE records instead of pre-aggregated buckets. Aggregating
// at scan time made cross-file de-duplication depend on which files happened to
// be re-parsed in that run: ~50% of usage-bearing messages appear in more than
// one transcript (a resumed or forked session copies its parent's history), and
// only a from-scratch scan saw them all at once. Warm scans re-counted them, so
// the same history totalled differently run to run. Keeping messages keyed by
// id lets the merge de-duplicate deterministically, cache state irrelevant.
const CACHE_VERSION = 6

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

/**
 * Write via temp file + rename. `writeFile` truncates first, so a concurrent
 * reader can observe a zero-length or half-written file — which is exactly how
 * plan.json used to reset itself back to defaults. `rename` is atomic within a
 * filesystem, so a reader sees either the old file or the new one, never both.
 */
export async function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await fsp.writeFile(tmp, contents)
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

async function saveCache(cache) {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await writeAtomic(CACHE_FILE, JSON.stringify(cache))
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

/** Fold one cached message record into its hour bucket. */
function addRecord(buckets, r) {
  if (!buckets[r.k]) buckets[r.k] = emptyBucket()
  const b = buckets[r.k]
  b.cost += r.c
  b.pools[r.p] = (b.pools[r.p] || 0) + r.c
  if (r.t != null) {
    if (b.firstTs == null || r.t < b.firstTs) b.firstTs = r.t
    if (b.lastTs == null || r.t > b.lastTs) b.lastTs = r.t
  }
  b.input += r.i || 0
  b.output += r.o || 0
  b.cacheWrite += r.w || 0
  b.cacheRead += r.r || 0
  b.msgs += 1
}

/**
 * Parse the appended region of one transcript file.
 * Returns { msgs, offset, limitEvents } — `msgs` is keyed by message id, so
 * de-duplication happens once at merge time rather than per scan.
 */
async function parseFrom(file, startOffset) {
  const msgs = {}
  const limitEvents = []
  const stat = await fsp.stat(file)
  if (stat.size <= startOffset) return { msgs, offset: stat.size, limitEvents }

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

    const key = bucketKey(o.timestamp)
    if (!key) continue

    const u = m.usage
    // No id means nothing can identify it as the same message seen elsewhere,
    // so give it a key unique to this file and position — never de-duplicated,
    // but never merged with an unrelated message either.
    const id = m.id || o.requestId || `~${file}#${consumed}`
    msgs[id] = {
      k: key,
      p: poolFor(m.model),
      c: costOf(m.model, u),
      t: Date.parse(o.timestamp) || null,
      i: u.input_tokens || 0,
      o: u.output_tokens || 0,
      w: u.cache_creation_input_tokens || 0,
      r: u.cache_read_input_tokens || 0,
    }
  }

  rl.close()
  stream.destroy()
  return { msgs, offset: lastCompleteOffset, limitEvents }
}

/**
 * Scan all transcripts, incrementally. Returns hourly buckets keyed
 * "YYYY-MM-DDTHH" in local time, plus any detected rate-limit events.
 */
export async function scan() {
  const cache = await loadCache()
  const files = (await listJsonl(PROJECTS_DIR)).sort()
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

    if (!reusable || stat.size > prev.offset) {
      rescanned++
      const { msgs, offset, limitEvents: le } = await parseFrom(file, startOffset)
      cache.files[file] = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        offset,
        msgs: { ...(reusable ? prev.msgs : null), ...msgs },
        limitEvents: [...((reusable && prev.limitEvents) || []), ...le],
      }
    }
    limitEvents.push(...(cache.files[file].limitEvents || []))
  }

  // Drop cache entries for files that no longer exist.
  for (const f of Object.keys(cache.files)) {
    if (!files.includes(f)) delete cache.files[f]
  }

  // De-duplicate ACROSS files here, not during parsing. Files are walked in a
  // fixed sorted order and every file's records are available whether or not it
  // was re-read this run, so a message shared by several transcripts is counted
  // exactly once and always by the same file — warm and cold scans agree.
  const seen = new Set()
  for (const file of files) {
    const entry = cache.files[file]
    if (!entry) continue
    for (const [id, r] of Object.entries(entry.msgs || {})) {
      if (seen.has(id)) continue
      seen.add(id)
      addRecord(total, r)
    }
  }

  await saveCache(cache)
  return { buckets: total, limitEvents, fileCount: files.length, rescanned }
}
