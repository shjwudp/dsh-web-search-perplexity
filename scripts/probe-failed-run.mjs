/**
 * Probe: what exactly did a specific failed Agent run report?
 *
 * The error reached the caller as `Perplexity run failed (response <id>):
 * <message>`, which is the message the API attached. This retrieves the stored
 * response by id and dumps the whole error object plus usage, so a transient
 * orchestration failure can be told apart from a budget or configuration one
 * instead of guessed at.
 *
 * Usage: node scripts/probe-failed-run.mjs <response-id> [more-ids...]
 *
 * Read `created_at` carefully. For a retrieved `failed` snapshot it has been
 * observed to be stamped at *retrieval* time rather than at creation: five runs
 * whose failures had already been delivered to the caller up to 75 minutes
 * earlier all reported `created_at` inside the 12.7 s window of one sequential
 * five-id run of this script. It is therefore not a submission-time timeline.
 * The harness's own session logs are what date a run's failure; see
 * `scripts/probe-run-timeline.mjs` and `docs/model-stage-no-output.md` §5.
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

const ids = process.argv.slice(2)
if (ids.length === 0) {
  console.error('usage: node scripts/probe-failed-run.mjs <response-id> [more-ids...]')
  process.exit(2)
}
const key = apiKey()
if (key === undefined) {
  console.error('no PERPLEXITY_API_KEY in this shell or the User scope')
  process.exit(2)
}
const base = 'https://api.perplexity.ai'

for (const id of ids) {
  const response = await fetch(`${base}/v1/agent/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', connection: 'close' },
  })
  const text = await response.text()
  console.log(`\n=== ${id} -> HTTP ${response.status} ===`)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    console.log(text.slice(0, 400))
    continue
  }
  console.log(`status=${body.status} model=${body.model} object=${body.object}`)
  // NOT a submission time for a retrieved failed snapshot; see the note above.
  console.log(`created_at=${body.created_at} (${new Date((body.created_at ?? 0) * 1000).toISOString()})`)
  console.log(`store=${String(body.store)}`)
  console.log(`error=${JSON.stringify(body.error, null, 2)}`)
  console.log(`usage=${JSON.stringify(body.usage)}`)
  console.log(`output item types=${JSON.stringify((body.output ?? []).map((item) => item.type))}`)
  // The two counts that say which failure this is: retrieval items present and
  // no answer message at all is the model-stage fault, whatever `error.code`
  // says (`reasoning_only` and `invalid_request` are the two seen in practice).
  const items = body.output ?? []
  const messages = items.filter((item) => item.type === 'message').length
  const searches = items.filter((item) => item.type === 'search_results').length
  const fetches = items.filter((item) => item.type === 'fetch_url_results').length
  console.log(`message items=${messages} search_results batches=${searches} fetch_url batches=${fetches}`
    + ` -> ${messages === 0
      ? `the model stage produced no answer${searches + fetches > 0 ? ' after a completed retrieval' : ''}`
      : 'an answer message is present'}`)
  for (const item of body.output ?? []) {
    if (item.type === 'message') {
      const textParts = (item.content ?? [])
        .filter((block) => block.type === 'output_text')
        .map((block) => String(block.text ?? ''))
      console.log(`  message status=${item.status} textChars=${textParts.join('').length}`)
    }
    if (item.type === 'search_results') console.log(`  search_results count=${(item.results ?? []).length}`)
  }
}
