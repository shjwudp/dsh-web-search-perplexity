/**
 * Probe: is a `reasoning_only` failure caused by the output-token cap?
 *
 * A real `high` research call failed with
 *   `echolot: model produced no usable answer: no usable answer (reasoning_only)`
 * after the search path moved to background submit + poll. That message usually
 * means the model spent its whole output budget on reasoning and emitted no
 * answer — which would make it a `maxTokens` question, not a transport one.
 *
 * This runs the same input once per cap through the documented background flow,
 * so the cause is measured rather than assumed. It never prints the key (only
 * its length).
 *
 * Usage:
 *   node scripts/probe-reasoning-only.mjs
 *       the original comparison: the fixed input below, preset `high`,
 *       `max_output_tokens` 2048 and 8192.
 *   node scripts/probe-reasoning-only.mjs --input-file q.txt --preset medium --caps 2048,none
 *       an A/B of one real question: the cap this plugin actually sends (2048)
 *       against no `max_output_tokens` field at all, so the preset's own budget
 *       (128000 for medium/high) applies.
 *   node scripts/probe-reasoning-only.mjs --input "…" --caps none
 *
 * `none` omits the field. Every arm reports the answer size, the item counts and
 * the usage breakdown, so "the cap was not binding" is visible as
 * `output_tokens > cap` rather than inferred.
 *
 * This is a LIVE probe: each arm is a real, billable research run. It is not
 * part of `npm test` and must never be wired into it.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function apiKey() {
  if (typeof process.env.PERPLEXITY_API_KEY === 'string' && process.env.PERPLEXITY_API_KEY.length > 0) {
    return process.env.PERPLEXITY_API_KEY
  }
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

/** One `--flag value` argument, or `undefined` when absent. */
function flag(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const key = apiKey()
if (key === undefined) {
  console.error('no PERPLEXITY_API_KEY in this shell or the User scope')
  process.exit(2)
}
const base = 'https://api.perplexity.ai'
console.log(`key length=${key.length} | base=${base}`)

/** The exact input the original probe used, so its comparison is apples to apples. */
const DEFAULT_INPUT = 'Compare HTTP/1.1 keep-alive connection reuse with HTTP/2 multiplexing: what are the '
  + 'tradeoffs, how do idle connection timeouts on servers and CDNs affect clients that pool connections, '
  + 'and what client-side strategies reduce failures from reusing a connection the server has already closed?'

const inputFile = flag('input-file')
const input = flag('input')
  ?? (inputFile !== undefined ? readFileSync(inputFile, 'utf8').trim() : DEFAULT_INPUT)
const preset = flag('preset') ?? 'high'
const caps = (flag('caps') ?? '2048,8192').split(',').map((value) => value.trim())
/** Default matches the original probe's 300 s ceiling. */
const maxWaitMs = Number(flag('max-wait') ?? 300) * 1000

console.log(`preset=${preset} caps=${caps.join(',')} inputChars=${input.length} maxWait=${maxWaitMs / 1000}s\n`)

/** One request; reports a transport failure instead of throwing on it. */
async function call(method, url, body) {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        accept: 'application/json',
        'user-agent': 'dsh-web-search-perplexity/probe-reasoning-only',
        connection: 'close',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    try {
      return { status: response.status, body: JSON.parse(text) }
    } catch {
      return { status: response.status, body: undefined, text: text.slice(0, 200) }
    }
  } catch (error) {
    // Deliberately not a throw. A DNS or socket blip used to kill the whole
    // probe, which lost the results of arms that had already run *and* abandoned
    // a run that had already been submitted and paid for, its id unretrieved.
    const cause = error?.cause ?? error
    return {
      status: 0,
      body: undefined,
      transportError: `${error?.message ?? error}${cause?.code !== undefined ? ` (${cause.code})` : ''}`,
    }
  }
}

const items = (snapshot) => (Array.isArray(snapshot?.output) ? snapshot.output : [])
const countOf = (snapshot, type) => items(snapshot).filter((item) => item?.type === type).length
const answerChars = (snapshot) => items(snapshot)
  .filter((item) => item.type === 'message')
  .flatMap((item) => item.content ?? [])
  .filter((block) => block.type === 'output_text')
  .reduce((total, block) => total + String(block.text ?? '').length, 0)

const results = []

/** Submit one arm in the background and poll it to a terminal status. */
async function run(label, cap) {
  const started = Date.now()
  const request = cap === 'none'
    ? { preset, background: true, input }
    : { preset, background: true, input, max_output_tokens: Number(cap) }
  const submit = await call('POST', `${base}/v1/agent`, request)
  const id = submit.body?.id
  console.log(`[${label}] submit HTTP ${submit.status} id=${String(id)}`
    + `${submit.body?.error !== undefined ? ` error=${JSON.stringify(submit.body.error)}` : ''}`
    + `${submit.transportError !== undefined ? ` transport=${submit.transportError}` : ''}`)
  if (typeof id !== 'string') {
    results.push({
      label,
      cap,
      http: submit.status,
      status: submit.transportError !== undefined ? '(transport failure)' : '(no id)',
      answerChars: 0,
      messages: 0,
      usage: undefined,
    })
    return
  }
  let snapshot = submit.body
  let lastStatus
  let transportFailures = 0
  const terminal = ['completed', 'failed', 'cancelled', 'incomplete']
  while (!terminal.includes(snapshot?.status) && Date.now() - started < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const poll = await call('GET', `${base}/v1/agent/${id}`)
    // A failed poll says nothing about the run, so it keeps its id and the loop
    // keeps going; the run is only lost if the whole wait is spent failing.
    if (poll.body !== undefined) snapshot = poll.body
    else {
      transportFailures += 1
      if (transportFailures === 1) console.log(`[${label}] poll transport failure: ${poll.transportError}`)
    }
    if (snapshot?.status !== lastStatus) {
      lastStatus = snapshot?.status
      console.log(`[${label}] ${lastStatus} at ${((Date.now() - started) / 1000).toFixed(1)}s`)
    }
  }
  const usage = snapshot?.usage ?? undefined
  const summary = {
    label,
    cap,
    id,
    http: 200,
    status: snapshot?.status,
    errorCode: snapshot?.error?.code,
    errorMessage: snapshot?.error?.message,
    answerChars: answerChars(snapshot),
    messages: countOf(snapshot, 'message'),
    searches: countOf(snapshot, 'search_results'),
    fetches: countOf(snapshot, 'fetch_url_results'),
    usage,
    transportFailures,
    elapsedS: (Date.now() - started) / 1000,
    snapshot,
  }
  console.log(`[${label}] status=${summary.status} in ${summary.elapsedS.toFixed(1)}s`
    + ` answerChars=${summary.answerChars} messages=${summary.messages}`
    + ` searches=${summary.searches} fetches=${summary.fetches}`
    + ` output_tokens=${usage?.output_tokens ?? '?'}`
    + ` reasoning_tokens=${usage?.output_tokens_details?.reasoning_tokens ?? '?'}`
    + `${transportFailures > 0 ? ` pollTransportFailures=${transportFailures}` : ''}`
    + `${summary.errorCode !== undefined ? ` error=${summary.errorCode}` : ''}`)
  if (summary.errorMessage !== undefined) console.log(`[${label}] upstream said: ${summary.errorMessage}`)
  results.push(summary)
}

for (const cap of caps) await run(cap === 'none' ? 'no cap' : `cap ${cap}`, cap)

console.log('\n=== comparison ===')
for (const result of results) {
  const capped = result.cap !== 'none'
  const outputTokens = result.usage?.output_tokens
  console.log(`${result.label.padEnd(10)} status=${String(result.status).padEnd(10)}`
    + ` answered=${result.answerChars > 0 ? 'yes' : 'NO '}`
    + ` answerChars=${String(result.answerChars).padStart(6)}`
    + ` output_tokens=${String(outputTokens ?? '?').padStart(6)}`
    + `${capped && typeof outputTokens === 'number' ? ` (cap ${result.cap}${outputTokens > Number(result.cap) ? ' — cap NOT enforced' : ' — under cap'})` : ''}`
    + `${result.errorCode !== undefined ? ` ${result.errorCode}` : ''}`)
}
// A run is billable whether or not this probe managed to poll it, so every id is
// named at the end: `scripts/probe-failed-run.mjs <id>` still retrieves a
// snapshot for any of them, including one this process left mid-flight.
const ids = results.map((result) => result.id).filter((id) => typeof id === 'string')
if (ids.length > 0) {
  console.log(`\nrun ids (retrievable with scripts/probe-failed-run.mjs):\n  ${ids.join('\n  ')}`)
}
const withCap = results.find((result) => result.cap !== 'none')
const withoutCap = results.find((result) => result.cap === 'none')
if (withCap !== undefined && withoutCap !== undefined) {
  console.log('\nreading: '
    + (withCap.answerChars > 0 && withoutCap.answerChars > 0
      ? 'both arms answered — the cap is not what produces a no-answer run'
      : withCap.answerChars === 0 && withoutCap.answerChars === 0
        ? 'neither arm answered — removing the cap does not fix it; the fault is upstream of the cap'
        : withCap.answerChars === 0
          ? 'only the capped arm failed — the cap is implicated, re-run before concluding'
          : 'only the uncapped arm failed — treat as noise, re-run before concluding'))
}
