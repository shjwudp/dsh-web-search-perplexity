/**
 * Tests for 429 (and other rejected-response) diagnostics in the shared transport.
 *
 * The bug these pin: after a 429 exhausted its retry budget, the error message
 * was *replaced* by the upstream body's own prose, so the HTTP status, the fact
 * that it was a 429, how many retries had been spent, and whether a
 * `Retry-After` was sent all disappeared. Every rate-limited call therefore
 * reported `"Request rate limit exceeded, please try again later."` — a sentence
 * that is identical for a 429, a 400, and a 403, and that says nothing about
 * whether a retry is worth attempting next.
 *
 * Everything here is offline and deterministic: `globalThis.fetch` is stubbed,
 * so no test in this file touches the network or consumes Perplexity quota.
 * `shared.js` imports nothing (its dependencies are all injected), so it is
 * driven directly, with no plugin context and no peers to resolve.
 *
 * The stub must provide `headers.get()` and `json()`, because both the backoff
 * path (`retry-after`) and the reporting path (the body) use them.
 *
 * Run: npm test
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { MAX_RETRY_WAIT_MS, requestJson } from '../src/shared.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const ENDPOINT = 'https://api.perplexity.ai/v1/agent'
/** The sentence Perplexity actually returns when the account is rate-limited. */
const RATE_LIMIT_PROSE = 'Request rate limit exceeded, please try again later.'

/**
 * Install a stub that answers every request with one fixed rejection.
 *
 * @param status - HTTP status to answer with.
 * @param options - `retryAfter` header value, and how to produce the body.
 * @returns the list of requests the stub received, so call counts are provable.
 */
function stubRejection(status, options = {}) {
  const {
    retryAfter = null,
    // `body` is a value, `bodyThrows` is a message, and `bodyAbsent` removes
    // `json` entirely — the three ways "the body cannot be parsed" happens.
    body = undefined,
    bodyThrows = undefined,
    bodyAbsent = false,
  } = options
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    return {
      ok: false,
      status,
      headers: {
        get: (name) => {
          // Case-insensitive, as a real Headers object is; a stub that only
          // matched one casing would let a regression through.
          if (name.toLowerCase() !== 'retry-after') return null
          return retryAfter
        },
      },
      ...(bodyAbsent
        ? {}
        : {
          json: async () => {
            if (bodyThrows !== undefined) throw new TypeError(bodyThrows)
            return body
          },
        }),
    }
  }
  return calls
}

/** Call `requestJson` and return the rejection, or the value on success. */
async function reject(retries, extra = {}) {
  try {
    return { value: await requestJson(ENDPOINT, 'test-key', { query: 'x' }, undefined, WebError, 'Perplexity search', retries, extra.method ?? 'POST') }
  } catch (error) {
    return { error }
  }
}

// ── 1. Accepting the task's repro form: status and retry count are named ──────
// The two assertions from the task's offline repro, which were `false` before
// the fix and must be `true` after it. `Retry-After: 0` keeps the run instant
// without removing the header, so the header path is exercised too.
console.log('\n1. an exhausted 429 names the status, the retry count, and the upstream text')
{
  for (const retries of [0, 2]) {
    const calls = stubRejection(429, {
      retryAfter: '0',
      body: { error: { message: RATE_LIMIT_PROSE } },
    })
    const started = Date.now()
    const { error } = await reject(retries)
    const elapsed = Date.now() - started

    const label = `retries=${retries}`
    check(`${label}: it rejected`, error !== undefined)
    check(`${label}: it stays a provider error`, error?.code === 'WEB_PROVIDER_ERROR', String(error?.code))
    check(`${label}: message names the HTTP status`, /HTTP 429/.test(String(error?.message)), String(error?.message))
    check(`${label}: message names the retry count`, /retr/i.test(String(error?.message)), String(error?.message))
    check(`${label}: the upstream sentence is still visible`,
      String(error?.message).includes(RATE_LIMIT_PROSE), String(error?.message))
    check(`${label}: the retry budget really was spent`,
      calls.length === retries + 1, `calls=${calls.length} elapsed=${elapsed}ms`)
    check(`${label}: the status is machine-readable too`,
      error?.status === 429 && error?.attempts === retries + 1 && error?.retries === retries,
      `status=${error?.status} attempts=${error?.attempts} retries=${error?.retries}`)
    check(`${label}: it reports whether the server sent Retry-After`,
      error?.retryAfterSupplied === true && error?.retryAfterMs === 0,
      `supplied=${error?.retryAfterSupplied} retryAfterMs=${error?.retryAfterMs}`)
    check(`${label}: no placeholder leaked into the message`,
      !/undefined|NaN|\[object/.test(String(error?.message)), String(error?.message))
  }

  // The discriminating regression: `retries=0` and `retries=2` must no longer
  // produce the same sentence. The anti-verification for this bug is precisely
  // that both said the same thing, word for word.
  const none = (await reject(0)).error?.message
  const two = (await reject(2)).error?.message
  check('a spent budget and a zero budget do not read the same', none !== two,
    `retries=0 vs retries=2 both: ${String(none)}`)
  check('a zero budget says it did not retry rather than that its budget ran out',
    String(none).includes('no retries attempted') && !String(none).includes('budget of 0 exhausted'),
    String(none))
  check('a spent budget says so, and names the cap that cannot outlast a quota window',
    String(two).includes('retry budget of 2 exhausted') && String(two).includes(`${MAX_RETRY_WAIT_MS}ms`),
    String(two))
}

// ── 2. The status, not just the number, still separates the failure classes ───
// The reported symptom was that a 429 could not be told apart from a 400 or a
// 403, because the upstream sentence is the same for all three.
console.log('\n2. the same upstream sentence stays distinguishable across statuses')
{
  const seen = []
  for (const status of [400, 403, 429]) {
    stubRejection(status, { body: { error: { message: RATE_LIMIT_PROSE } } })
    const { error } = await reject(2)
    seen.push(String(error?.message))
    check(`HTTP ${status} is named in the message`, String(error?.message).includes(`HTTP ${status}`), String(error?.message))
    check(`HTTP ${status} carries its status field`, error?.status === status, `status=${error?.status}`)
  }
  check('the three messages are all different', new Set(seen).size === 3, seen.join('\n    '))
  check('a non-429 did not consume a retry budget', /no retries attempted|0 of 2 retries spent/.test(seen[0]), seen[0])
}

// ── 3. An unreadable body costs the prose, never the real error ───────────────
// Acceptance criterion 2. Before the fix this path was not covered, and the
// coverage that existed asserted the inverse of the intent: the status survived
// only when parsing *failed*.
console.log('\n3. no body, a throwing body, and an empty body all keep the diagnostic')
{
  const cases = [
    { name: 'no json() at all', options: { bodyAbsent: true } },
    { name: 'json() throws', options: { bodyThrows: 'Unexpected end of JSON input' } },
    { name: 'an empty object', options: { body: {} } },
    { name: 'an empty error string', options: { body: { error: '' } } },
    { name: 'a null body', options: { body: null } },
  ]
  for (const testCase of cases) {
    stubRejection(429, { retryAfter: '0', ...testCase.options })
    let error
    let secondary
    try {
      await requestJson(ENDPOINT, 'test-key', { query: 'x' }, undefined, WebError, 'Perplexity search', 1)
    } catch (caught) {
      error = caught
    }
    // A diagnostic that throws while being built would replace the real failure
    // with a confusing second one, so the message is touched explicitly.
    try {
      String(error?.message)
    } catch (caught) {
      secondary = caught
    }
    check(`${testCase.name}: it rejected with a provider error`,
      error?.code === 'WEB_PROVIDER_ERROR', String(error?.code))
    check(`${testCase.name}: the HTTP status survives`,
      /HTTP 429/.test(String(error?.message)), String(error?.message))
    check(`${testCase.name}: the retry count survives`,
      /retr/i.test(String(error?.message)), String(error?.message))
    check(`${testCase.name}: it says no readable upstream text was available`,
      String(error?.message).includes('no readable error text'), String(error?.message))
    check(`${testCase.name}: building the message did not throw a second error`,
      secondary === undefined, String(secondary))
  }
}

// ── 4. Retry-After is reported whether honored, clamped, or missing ──────────
// The 10s per-wait cap is a decision, not an accident, and the message has to
// disclose when it shortened what the server asked for — otherwise "we retried"
// hides "we came back earlier than we were told to".
console.log('\n4. Retry-After: honored, clamped, unparseable, and absent are distinguished')
{
  // Honored: a short Retry-After is waited out exactly as sent.
  stubRejection(429, { retryAfter: '0.01' })
  const honored = (await reject(1)).error
  check('an honored Retry-After is quoted and its backoff reported',
    String(honored?.message).includes('Retry-After: 0.01') && honored?.backoffTotalMs === 10,
    `message=${String(honored?.message)} backoff=${honored?.backoffTotalMs}`)
  check('an honored Retry-After is not reported as capped', honored?.clampedBackoffs === 0,
    `clamped=${honored?.clampedBackoffs}`)

  // Clamped: the server asked for far longer than the cap, so the retry came
  // back early and the message must say so.
  stubRejection(429, { retryAfter: '120' })
  const clamped = (await reject(1)).error
  check('a clamped Retry-After keeps the value the server sent',
    String(clamped?.message).includes('Retry-After: 120'), String(clamped?.message))
  check('a clamped Retry-After is reported as capped, not silently shortened',
    clamped?.clampedBackoffs === 1 && String(clamped?.message).includes('capped at 10000ms'),
    `clamped=${clamped?.clampedBackoffs} message=${String(clamped?.message)}`)
  check('the wait actually taken was the cap, not the requested 120s',
    clamped?.backoffTotalMs === MAX_RETRY_WAIT_MS, `backoff=${clamped?.backoffTotalMs}`)

  // Unparseable: present but meaningless. Absent: not sent at all.
  stubRejection(429, { retryAfter: 'soon' })
  const unparseable = (await reject(1)).error
  check('an unparseable Retry-After is named as unparseable',
    String(unparseable?.message).includes('unparseable Retry-After: soon'), String(unparseable?.message))
  check('an unparseable Retry-After falls back to the doubling backoff',
    unparseable?.backoffTotalMs === 1000, `backoff=${unparseable?.backoffTotalMs}`)

  stubRejection(429, { retryAfter: null })
  const absent = (await reject(1)).error
  check('a missing Retry-After is stated, not omitted',
    String(absent?.message).includes('no Retry-After header'), String(absent?.message))
  check('a missing Retry-After is reported as unsupplied',
    absent?.retryAfterSupplied === false && absent?.retryAfterMs === undefined,
    `supplied=${absent?.retryAfterSupplied} retryAfterMs=${absent?.retryAfterMs}`)

  // Backoff history must be visible for a multi-retry call: with no
  // Retry-After the waits double (1s, 2s), and both must be accounted for.
  stubRejection(429, { retryAfter: null })
  const doubled = (await reject(2)).error
  check('the whole backoff history is reported, not just the last wait',
    doubled?.backoffTotalMs === 3000 && String(doubled?.message).includes('waiting 3000ms'),
    `backoff=${doubled?.backoffTotalMs} message=${String(doubled?.message)}`)
}

// ── 4b. The header quoted is the one from the response that ended the call ───
// A 429 is retried; if the response that finally ends the call is a *different*
// status, that response never sent a `Retry-After`. Quoting the earlier 429's
// header would attach it to a status it did not come with — a diagnostic that
// reads perfectly and is wrong, which is the failure mode this whole file exists
// to prevent.
console.log('\n4b. a retried 429 does not donate its Retry-After to the next status')
{
  const sequence = [
    { status: 429, retryAfter: '0.01' },
    { status: 500, retryAfter: null },
  ]
  const seen = []
  let index = 0
  globalThis.fetch = async () => {
    const step = sequence[index] ?? sequence[sequence.length - 1]
    index += 1
    seen.push(step.status)
    return {
      ok: false,
      status: step.status,
      headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? step.retryAfter : null) },
      json: async () => ({ error: { message: 'upstream prose' } }),
    }
  }
  const { error } = await reject(2)
  check('the retried 429 was followed by the second status', seen.join(',') === '429,500', seen.join(','))
  check('the message names the status that ended the call',
    String(error?.message).includes('HTTP 500'), String(error?.message))
  check('it does not quote the earlier 429 header as this status\'s own',
    !String(error?.message).includes('Retry-After: 0.01'), String(error?.message))
  check('it states that this response sent no Retry-After',
    String(error?.message).includes('no Retry-After header'), String(error?.message))
  check('the backoff that was really spent is still reported',
    error?.backoffTotalMs === 10 && String(error?.message).includes('waiting 10ms'),
    `backoff=${error?.backoffTotalMs} message=${String(error?.message)}`)
  check('the structured fields agree with the message',
    error?.retryAfterSupplied === false && error?.retryAfterMs === undefined,
    `supplied=${error?.retryAfterSupplied} retryAfterMs=${error?.retryAfterMs}`)
}

// ── 5. A cancellation still wins over a 429 report, including mid-body ───────
// The retry/report rewrite must not swallow the abort classification that
// `soft-deadline.test.mjs` block 7 and the providers rely on.
console.log('\n5. an abort is still an abort, not a rate-limit report')
{
  // Aborted before the call: `sleep` must reject immediately instead of waiting
  // out the backoff, and the error must be WEB_ABORTED.
  stubRejection(429, { retryAfter: '5' })
  const outer = new AbortController()
  outer.abort()
  let error
  const started = Date.now()
  try {
    await requestJson(ENDPOINT, 'test-key', { query: 'x' }, outer.signal, WebError, 'Perplexity search', 2)
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - started
  check('an already-aborted signal rejects as WEB_ABORTED', error?.code === 'WEB_ABORTED', String(error?.code))
  check('and it does not wait out the 5s backoff', elapsed < 5000, `elapsed=${elapsed}ms`)

  // Aborted while the error body is being read: the abort must be reported as a
  // cancellation, not absorbed into the HTTP-error message.
  const midBody = new AbortController()
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    json: async () => {
      midBody.abort()
      const abort = new Error('This operation was aborted')
      abort.name = 'AbortError'
      throw abort
    },
  })
  let midError
  try {
    await requestJson(ENDPOINT, 'test-key', { query: 'x' }, midBody.signal, WebError, 'Perplexity search', 0)
  } catch (caught) {
    midError = caught
  }
  check('an abort mid-body is still WEB_ABORTED', midError?.code === 'WEB_ABORTED', String(midError?.code))
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
