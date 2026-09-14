/**
 * Probe: does the Agent API's documented background flow behave as written?
 *
 * The research tool now submits with `background: true` and polls
 * `GET /v1/agent/{id}`, so this exercises exactly that against the live API with
 * the cheapest preset available, and prints the shape of every response. It
 * never prints the key (only its length).
 *
 * This exists because the failure that motivated the rewrite — `UND_ERR_SOCKET`
 * on a long synchronous run — was only ever observed on the real endpoint, and a
 * stubbed test cannot prove the real submit answers `queued` or that a
 * retrieval by id is permitted for a background run.
 *
 * Usage: node scripts/probe-background-flow.mjs   (PERPLEXITY_API_KEY from the
 * User scope is used automatically when the shell has none, since agent shells
 * run with secrets scrubbed.)
 */

import { execFileSync } from 'node:child_process'

function apiKey() {
  if (typeof process.env.PERPLEXITY_API_KEY === 'string' && process.env.PERPLEXITY_API_KEY.length > 0) {
    return process.env.PERPLEXITY_API_KEY
  }
  // Agent shells have secrets scrubbed from their environment, so fall back to
  // the User-scope store, which is still readable through the .NET API.
  try {
    const value = execFileSync(
      'pwsh',
      ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('PERPLEXITY_API_KEY','User')"],
      { encoding: 'utf8' },
    ).trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

const key = apiKey()
if (key === undefined) {
  console.error('no PERPLEXITY_API_KEY in this shell or the User scope')
  process.exit(2)
}
const base = 'https://api.perplexity.ai'
// `--long` repeats the exact shape that failed synchronously: a high-depth
// research prompt. A stub cannot show that a real run outlives the window the
// network used to allow a single connection, so that is the honest check.
const long = process.argv.includes('--long')
console.log(`key length=${key.length} | base=${base} | mode=${long ? 'long (high preset)' : 'quick (low preset)'}`)

/** One request, reporting status and a bounded slice of the body. */
async function call(method, url, body) {
  const started = Date.now()
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      accept: 'application/json',
      'user-agent': 'dsh-web-search-perplexity/probe-background-flow',
      connection: 'close',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  const elapsed = Date.now() - started
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  console.log(`\n${method} ${url.replace(base, '')} -> HTTP ${response.status} in ${elapsed}ms`)
  if (parsed === undefined) {
    console.log(`  (non-JSON body) ${text.slice(0, 200)}`)
  } else {
    console.log(`  id=${parsed.id ?? '(none)'} status=${parsed.status ?? '(none)'} object=${parsed.object ?? '(none)'}`)
    if (parsed.error != null) console.log(`  error=${JSON.stringify(parsed.error).slice(0, 200)}`)
    if (Array.isArray(parsed.output)) console.log(`  output items=${parsed.output.length}`)
  }
  return { status: response.status, body: parsed }
}

// 1. Submit in the background: the documented call must return immediately with
//    `queued`, not block for the whole run.
const submit = await call('POST', `${base}/v1/agent`, long
  ? {
    preset: 'high',
    background: true,
    input: 'Compare HTTP/1.1 keep-alive connection reuse with HTTP/2 multiplexing: the tradeoffs, how '
      + 'server and CDN idle timeouts affect clients that pool connections, and which client-side '
      + 'strategies reduce failures from reusing a connection the server has already closed.',
  }
  : {
    preset: 'low',
    background: true,
    input: 'Reply with exactly the word: ok',
  })
const id = submit.body?.id
if (typeof id !== 'string' || id.length === 0) {
  console.log('\nRESULT: no id returned — background submit did not behave as documented')
  process.exit(1)
}

// 2. Poll by id, the way the tool does, until terminal. The long mode is the
//    point of the exercise: it must survive well past the ~180s at which a
//    single synchronous connection was dropped.
const terminal = ['completed', 'failed', 'cancelled', 'incomplete']
let status = submit.body.status
const polls = []
const started = Date.now()
const maxPolls = long ? 400 : 40
const maxWaitMs = long ? 900_000 : 60_000
for (let i = 0; i < maxPolls && !terminal.includes(status); i += 1) {
  if (Date.now() - started > maxWaitMs) break
  await new Promise((resolve) => setTimeout(resolve, long ? 3000 : 1000))
  const poll = await call('GET', `${base}/v1/agent/${id}`)
  status = poll.body?.status
  polls.push(status)
  if (status === 'completed' || status === 'incomplete') {
    const texts = []
    let sources = 0
    for (const item of poll.body.output ?? []) {
      if (item.type === 'message') {
        for (const block of item.content ?? []) if (block.type === 'output_text') texts.push(block.text)
      }
      if (item.type === 'search_results') sources += (item.results ?? []).length
    }
    console.log(`  extracted answer: ${JSON.stringify(texts.join(' ').slice(0, 120))}`)
    console.log(`  answer chars=${texts.join(' ').length} sources=${sources}`)
    break
  }
}

const elapsedS = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\nRESULT: submit=${submit.body.status} polls=${polls.length} final=${status} waited=${elapsedS}s`)
console.log(`RESULT: polled past 60s (the old single-connection window) = ${Number(elapsedS) > 60}`)
process.exit(terminal.includes(status) && polls.length > 0 ? 0 : 1)
