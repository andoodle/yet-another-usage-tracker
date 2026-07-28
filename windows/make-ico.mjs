// Packs PNG files into a Windows .ico. No dependencies, in the same spirit as
// scripts/make-icon.mjs — the Vista-and-later ICO format lets each entry hold a
// raw PNG, so this is header assembly only. Nothing is decoded or re-encoded.
//
//   node windows/make-ico.mjs out.ico 16.png 32.png 48.png 256.png
//
// Ship several sizes: Explorer picks 16/32, alt-tab and the taskbar want 48,
// and 256 is what the large-icon views use. One size scaled badly looks worse
// than no custom icon at all.

import { readFileSync, writeFileSync } from 'node:fs'

const [out, ...pngs] = process.argv.slice(2)
if (!out || pngs.length === 0) {
  console.error('usage: node windows/make-ico.mjs out.ico in1.png [in2.png ...]')
  process.exit(1)
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Width and height live in the IHDR chunk, which is always the first one. */
function dimensions(buf, file) {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(file + ' is not a PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const entries = pngs.map((file) => {
  const data = readFileSync(file)
  const { width, height } = dimensions(data, file)
  if (width > 256 || height > 256) {
    throw new Error(`${file} is ${width}x${height}; ICO entries cap at 256x256`)
  }
  return { data, width, height }
})

// ICONDIR is 6 bytes, then one 16-byte ICONDIRENTRY per image, then the
// payloads. Offsets are absolute from the start of the file, so the whole
// directory has to be sized before any of them can be written.
const HEADER = 6
const ENTRY = 16
let offset = HEADER + ENTRY * entries.length

const dir = Buffer.alloc(HEADER + ENTRY * entries.length)
dir.writeUInt16LE(0, 0) // reserved
dir.writeUInt16LE(1, 2) // 1 = icon (2 would be cursor)
dir.writeUInt16LE(entries.length, 4)

entries.forEach((e, i) => {
  const at = HEADER + ENTRY * i
  // 256 is stored as 0 — the field is a single byte, so 256 doesn't fit and
  // the format spends the wrap-around on its largest legal size.
  dir[at] = e.width === 256 ? 0 : e.width
  dir[at + 1] = e.height === 256 ? 0 : e.height
  dir[at + 2] = 0 // palette size, 0 for truecolor
  dir[at + 3] = 0 // reserved
  dir.writeUInt16LE(1, at + 4) // color planes
  dir.writeUInt16LE(32, at + 6) // bits per pixel
  dir.writeUInt32LE(e.data.length, at + 8)
  dir.writeUInt32LE(offset, at + 12)
  offset += e.data.length
})

const ico = Buffer.concat([dir, ...entries.map((e) => e.data)])
writeFileSync(out, ico)
console.log(
  `wrote ${out} (${entries.map((e) => `${e.width}x${e.height}`).join(', ')}, ${ico.length} bytes)`,
)
