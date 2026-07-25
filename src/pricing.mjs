// Per-MTok rates. Input/output are Anthropic's published first-party API rates.
// Cache multipliers are fixed by the API contract, not per-model:
//   write 5m = 1.25x input, write 1h = 2x input, read = 0.1x input.
const RATES = {
  'claude-fable-5':   { input: 10, output: 50 },
  'claude-mythos-5':  { input: 10, output: 50 },
  'claude-opus-5':    { input: 5,  output: 25 },
  'claude-opus-4-8':  { input: 5,  output: 25 },
  'claude-opus-4-7':  { input: 5,  output: 25 },
  'claude-opus-4-6':  { input: 5,  output: 25 },
  'claude-opus-4-5':  { input: 5,  output: 25 },
  'claude-sonnet-5':  { input: 3,  output: 15 },
  'claude-sonnet-4-6':{ input: 3,  output: 15 },
  'claude-sonnet-4-5':{ input: 3,  output: 15 },
  'claude-haiku-4-5': { input: 1,  output: 5 },
}

const FALLBACK = { input: 5, output: 25 } // unknown model -> assume Opus tier

const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2.0
const CACHE_READ = 0.1

/**
 * Fable is NOT a separate allowance. On Max it draws from the same weekly
 * limit as everything else, and is additionally capped at a share of that
 * limit (50% at time of writing). So there are two meters over one budget:
 *
 *   all   — every model, measured against the full weekly limit
 *   fable — Fable/Mythos only, measured against `fableShare` × that limit
 *
 * Fable usage moves BOTH meters. Whichever runs out first is what stops you.
 * https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan
 */
export const POOLS = {
  all: { id: 'all', label: 'All models', kind: 'total' },
  fable: { id: 'fable', label: 'Fable 5', kind: 'sublimit' },
}

/** Tags a bucket contribution. 'other' is everything that isn't Fable/Mythos. */
export function poolFor(model) {
  const id = (model || '').replace(/^anthropic\./, '')
  return id.startsWith('claude-fable') || id.startsWith('claude-mythos') ? 'fable' : 'other'
}

export function rateFor(model) {
  if (!model) return FALLBACK
  // Strip provider prefixes ("anthropic.claude-opus-5") and date suffixes.
  const id = model.replace(/^anthropic\./, '')
  if (RATES[id]) return RATES[id]
  const base = Object.keys(RATES).find((k) => id.startsWith(k))
  return base ? RATES[base] : FALLBACK
}

/**
 * Weighted cost in USD for one assistant message's usage block.
 * This is a *proxy* for subscription-limit consumption, not a bill.
 */
export function costOf(model, usage) {
  if (!usage) return 0
  const r = rateFor(model)
  const M = 1e6

  const input = usage.input_tokens || 0
  const output = usage.output_tokens || 0
  const read = usage.cache_read_input_tokens || 0

  // Newer API responses break cache creation down by TTL. Older ones don't —
  // assume the 5m default in that case (the common Claude Code path).
  const cc = usage.cache_creation || null
  const write5m = cc ? cc.ephemeral_5m_input_tokens || 0 : usage.cache_creation_input_tokens || 0
  const write1h = cc ? cc.ephemeral_1h_input_tokens || 0 : 0

  return (
    (input * r.input) / M +
    (output * r.output) / M +
    (write5m * r.input * CACHE_WRITE_5M) / M +
    (write1h * r.input * CACHE_WRITE_1H) / M +
    (read * r.input * CACHE_READ) / M
  )
}
