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
  console.log(`created_at=${body.created_at} (${new Date((body.created_at ?? 0) * 1000).toISOString()})`)
  console.log(`store=${String(body.store)}`)
  console.log(`error=${JSON.stringify(body.error, null, 2)}`)
  console.log(`usage=${JSON.stringify(body.usage)}`)
  console.log(`output item types=${JSON.stringify((body.output ?? []).map((item) => item.type))}`)
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
