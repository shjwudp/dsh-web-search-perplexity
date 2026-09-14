/**
 * Probe: is a `reasoning_only` failure caused by the output-token cap?
 *
 * A real `high` research call failed with
 *   `echolot: model produced no usable answer: no usable answer (reasoning_only)`
 * after the search path moved to background submit + poll. That message usually
 * means the model spent its whole output budget on reasoning and emitted no
 * answer — which would make it a `maxTokens` question, not a transport one.
 *
 * This runs the same input twice through the documented background flow, with
 * and without the configured cap, so the cause is measured rather than assumed.
 * It never prints the key (only its length).
 *
 * Usage: node scripts/probe-reasoning-only.mjs
 */

import { execFileSync } from 'node:child_process'

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

const key = apiKey()
if (key === undefined) {
  console.error('no PERPLEXITY_API_KEY in this shell or the User scope')
  process.exit(2)
}
const base = 'https://api.perplexity.ai'
console.log(`key length=${key.length} | base=${base}`)

/** The exact input that failed, so the comparison is apples to apples. */
const INPUT = 'Compare HTTP/1.1 keep-alive connection reuse with HTTP/2 multiplexing: what are the '
  + 'tradeoffs, how do idle connection timeouts on servers and CDNs affect clients that pool connections, '
  + 'and what client-side strategies reduce failures from reusing a connection the server has already closed?'

/** One request; returns the parsed body. */
async function call(method, url, body) {
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
}

/** Submit in the background and poll to a terminal status. */
async function run(label, body) {
  const started = Date.now()
  const submit = await call('POST', `${base}/v1/agent`, { preset: 'high', background: true, ...body })
  const id = submit.body?.id
  if (typeof id !== 'string') {
    console.log(`${label}: submit failed HTTP ${submit.status} ${JSON.stringify(submit.body).slice(0, 160)}`)
    return
  }
  let snapshot = submit.body
  const terminal = ['completed', 'failed', 'cancelled', 'incomplete']
  while (!terminal.includes(snapshot.status) && Date.now() - started < 300_000) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    snapshot = (await call('GET', `${base}/v1/agent/${id}`)).body ?? snapshot
  }
  const answerChars = (snapshot.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((block) => block.type === 'output_text')
    .reduce((total, block) => total + String(block.text ?? '').length, 0)
  const usage = snapshot.usage ?? {}
  console.log(`${label}: status=${snapshot.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`
    + ` answerChars=${answerChars}`
    + ` output_tokens=${usage.output_tokens ?? '?'}`
    + `${snapshot.error !== undefined && snapshot.error !== null ? ` error=${JSON.stringify(snapshot.error)}` : ''}`)
}

// The plugin caps output at its configured maxTokens (2048 in the live settings).
await run('with cap 2048   ', { max_output_tokens: 2048, input: INPUT })
await run('with cap 8192   ', { max_output_tokens: 8192, input: INPUT })
