/**
 * Read a compressed DSH session log and report any `perplexity_research` call
 * plus the error the tool returned.
 *
 * The session log is `session.v3.jsonl.zstd`: a zstd-compressed JSONL stream
 * (Node 24 decodes zstd natively). This exists because a tool failure is
 * recorded in the log, which is the only place the real error a *host* process
 * produced can be read from outside that process.
 *
 * Usage: node scripts/read-session-failure.mjs <session.v3.jsonl.zstd> [needle]
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
if (path === undefined) {
  console.error('usage: node read-session-failure.mjs <session.v3.jsonl.zstd> [needle]')
  process.exit(2)
}
const needle = process.argv[3] ?? 'perplexity_research'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress every frame in the file.
 *
 * The log is thousands of independent zstd frames concatenated (one per append),
 * and Node's stream decoder stops after the first. Frames are delimited by the
 * zstd magic number, so the file is split on it and each candidate is decoded
 * individually; a frame that fails to decode (the magic appeared inside compressed
 * bytes) is absorbed into the previous segment.
 *
 * @param buffer - the raw file bytes.
 * @returns the concatenated decompressed text.
 */
function decompressAllFrames(buffer) {
  const offsets = []
  let at = buffer.indexOf(ZSTD_MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)
  }
  const out = []
  let start = offsets[0] ?? 0
  for (let i = 1; i <= offsets.length; i += 1) {
    const end = i < offsets.length ? offsets[i] : buffer.length
    try {
      out.push(zstdDecompressSync(buffer.subarray(start, end)))
      start = end
    } catch {
      // Not a real frame boundary: extend the current segment and retry.
    }
  }
  if (start < buffer.length) {
    try {
      out.push(zstdDecompressSync(buffer.subarray(start)))
    } catch {
      // Trailing partial frame: nothing more to read.
    }
  }
  return Buffer.concat(out).toString('utf8')
}

let text
try {
  text = decompressAllFrames(readFileSync(path))
} catch (error) {
  console.error(`could not decompress ${path}: ${String(error).slice(0, 200)}`)
  process.exit(1)
}
const lines = text.split('\n').filter((line) => line.length > 0)
console.log(`${path}\n  ${lines.length} events, ${text.length} bytes decompressed\n`)

/** Pull every string out of a value, to search nested tool payloads. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) strings(item, out)
  return out
}

let hits = 0
for (const [index, line] of lines.entries()) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  const all = strings(event)
  if (!all.some((value) => value.includes(needle))) continue
  hits += 1
  const type = event.type ?? event.kind ?? Object.keys(event).slice(0, 4).join(',')
  console.log(`--- event ${index} (${type}) ---`)
  for (const value of all) {
    if (value.length < 8) continue
    if (value.includes(needle) || /fetch failed|WEB_PROVIDER_ERROR|Error:|timed out/.test(value)) {
      console.log(value.slice(0, 1200))
      console.log('···')
    }
  }
}
console.log(`\n${hits} event(s) mentioning ${needle}`)
