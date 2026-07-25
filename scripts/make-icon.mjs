// Generates a 1024x1024 PNG app icon with no dependencies (Node zlib only).
// Draws the dashboard's own palette: warm-dark plate, accent bars rising like
// the availability calendar, with the last bar in the "over" red.
//
//   node scripts/make-icon.mjs out.png
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const S = 1024
const px = Buffer.alloc(S * S * 4) // RGBA

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
]
const PLATE = hex('#1c1b16')
const ACCENT = hex('#d8a657')
const DIM = hex('#4a4234')
const RED = hex('#d16a5a')

function set(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const i = (y * S + x) * 4
  // Simple source-over so anti-aliased edges blend into what's beneath.
  const sa = a / 255
  px[i] = Math.round(px[i] * (1 - sa) + r * sa)
  px[i + 1] = Math.round(px[i + 1] * (1 - sa) + g * sa)
  px[i + 2] = Math.round(px[i + 2] * (1 - sa) + b * sa)
  px[i + 3] = Math.max(px[i + 3], a)
}

/** Rounded rectangle with a 1px-ish analytic AA edge. */
function roundRect(x0, y0, w, h, r, color) {
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
      // distance outside the rounded rect
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x0 + w - r)
      const cy = Math.min(Math.max(y + 0.5, y0 + r), y0 + h - r)
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r
      if (d <= -0.5) set(x, y, color, 255)
      else if (d < 0.5) set(x, y, color, Math.round((0.5 - d) * 255))
    }
  }
}

// Plate
roundRect(0, 0, S, S, 224, PLATE)

// Bar chart — five columns, last one "over budget" in red.
const heights = [0.30, 0.46, 0.62, 0.40, 0.80]
const colors = [DIM, ACCENT, ACCENT, DIM, RED]
const n = heights.length
const gap = 34
const marginX = 168
const barW = (S - marginX * 2 - gap * (n - 1)) / n
const baseY = S - 250
const maxH = 470

for (let i = 0; i < n; i++) {
  const h = heights[i] * maxH
  roundRect(marginX + i * (barW + gap), baseY - h, barW, h, barW * 0.22, colors[i])
}

// Baseline rule
roundRect(marginX, baseY + 34, S - marginX * 2, 12, 6, DIM)

// --- encode PNG ---
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
// 10,11,12 = compression/filter/interlace = 0

// Raw scanlines, each prefixed with filter byte 0.
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

writeFileSync(process.argv[2] || 'icon.png', png)
console.log(`wrote ${process.argv[2] || 'icon.png'} (${S}x${S}, ${png.length} bytes)`)
