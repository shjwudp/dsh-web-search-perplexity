/**
 * Probe (offline): when did a run id first reach this machine?
 *
 * A run's own `created_at` cannot answer that. For a retrieved `failed`
 * snapshot it has been observed to be stamped at *retrieval* time rather than at
 * creation: five runs whose failures had already been delivered to the caller up
 * to 75 minutes earlier all reported `created_at` inside the 12.7 s window of a
 * single sequential five-id run of `probe-failed-run.mjs`. Reading those values
 * as submission times produced a phantom "the server queued my calls for an hour
 * and drained the backlog at 22:47" theory, which this probe refutes.
 *
 * What does date a run is the harness's own session log: DSH writes one
 * timestamped event per tool result, and a failed provider call is recorded with
 * its message — which names the response id. So walking those logs answers "when
 * was this run's failure reported here", independently of the API.
 *
 * Read-only and fully offline: it never contacts Perplexity, needs no API key,
 * and consumes no quota.
 *
 * Requires Node 22.15+ for `zlib.createZstdDecompress`. DSH writes session logs
 * as *concatenated* zstd frames, and Node's stream decoder stops at the first
 * frame boundary, so every frame is located and decoded individually.
 *
 * Usage:
 *   node scripts/probe-run-timeline.mjs <response-id> [more-ids...]
 *   node scripts/probe-run-timeline.mjs --all <response-id>      # every event
 *   node scripts/probe-run-timeline.mjs --sessions <dir> <ids...>  # default ~/.dsh/sessions
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const args = process.argv.slice(2)
const showAll = args.includes('--all')
const sessionsFlag = args.indexOf('--sessions')
const sessionsRoot = sessionsFlag === -1
  ? join(homedir(), '.dsh', 'sessions')
  : args[sessionsFlag + 1]
// `--sessions`' own value is not an id, and with the flag absent nothing is
// excluded — `sessionsFlag + 1` would otherwise be `0` and swallow the first id.
const ids = args.filter((arg, index) => !arg.startsWith('--') && (sessionsFlag === -1 || index !== sessionsFlag + 1))

if (ids.length === 0 || sessionsRoot === undefined) {
  console.error('usage: node scripts/probe-run-timeline.mjs [--all] [--sessions <dir>] <response-id> [more-ids...]')
  process.exit(2)
}
if (typeof createZstdDecompress !== 'function') {
  console.error('this probe needs Node 22.15+ (zlib.createZstdDecompress) to read DSH session logs')
  process.exit(2)
}
if (!existsSync(sessionsRoot)) {
  console.error(`no session logs at ${sessionsRoot}; pass --sessions <dir> to point at another DSH home`)
  process.exit(2)
}

/** Every `.zstd` session log below `dir`. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith('.zstd')) out.push(path)
  }
  return out
}

/** One zstd frame, decoded; never rejects — a torn frame yields what it had. */
function decodeFrame(buffer) {
  return new Promise((resolve) => {
    const chunks = []
    const stream = createZstdDecompress()
    const settle = () => resolve(Buffer.concat(chunks).toString('utf8'))
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', settle)
    stream.on('end', settle)
    stream.end(buffer)
  })
}

/** Every concatenated frame in one session log, decoded and joined. */
async function decodeLog(buffer) {
  const offsets = []
  let at = 0
  while ((at = buffer.indexOf(MAGIC, at)) !== -1) {
    offsets.push(at)
    at += 1
  }
  let text = ''
  for (const offset of offsets) text += await decodeFrame(buffer.subarray(offset))
  return text
}

const local = (time) => new Date(time).toLocaleString('sv-SE')
const events = []
const logs = walk(sessionsRoot)

for (const log of logs) {
  const text = await decodeLog(readFileSync(log))
  if (!ids.some((id) => text.includes(id))) continue
  const session = log.slice(sessionsRoot.length + 1)
  for (const line of text.split('\n')) {
    const matched = ids.filter((id) => line.includes(id))
    if (matched.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // A frame boundary can split a line; the excerpt is still worth reporting.
      events.push({ session, time: undefined, seq: undefined, type: '(unparseable)', matched, excerpt: line.slice(0, 200) })
      continue
    }
    events.push({
      session,
      time: typeof event.time === 'number' ? event.time : undefined,
      seq: event.seq,
      type: event.type,
      matched,
      excerpt: JSON.stringify(event.data ?? event).slice(0, 240),
    })
  }
}

events.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
console.log(`searched ${logs.length} session logs under ${sessionsRoot}`)
console.log(`${events.length} event(s) mention the requested id(s)\n`)

if (showAll) {
  for (const event of events) {
    console.log(`--- ${event.time === undefined ? '(no time)' : local(event.time)} | seq=${event.seq} type=${event.type}`)
    console.log(`    session=${event.session}`)
    console.log(`    ids=${event.matched.join(',')}`)
    console.log(`    ${event.excerpt.replace(/\s+/g, ' ')}`)
  }
  console.log('')
}

for (const id of ids) {
  const times = events
    .filter((event) => event.matched.includes(id) && event.time !== undefined)
    .map((event) => event.time)
    .sort((a, b) => a - b)
  if (times.length === 0) {
    console.log(`${id}\n    never appeared in a session log under this root`)
    continue
  }
  console.log(`${id}`)
  console.log(`    first reported here: ${local(times[0])} (${new Date(times[0]).toISOString()})`)
  console.log(`    last  reported here: ${local(times[times.length - 1])} (${new Date(times[times.length - 1]).toISOString()})`)
  console.log(`    events with a timestamp: ${times.length}`)
}
console.log('\nCompare the "first reported here" values with the run\'s own created_at from')
console.log('scripts/probe-failed-run.mjs. A created_at later than the first report means the')
console.log('snapshot was stamped at retrieval, not at creation.')
