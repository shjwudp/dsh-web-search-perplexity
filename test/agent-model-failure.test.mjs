/**
 * Tests for the model-stage no-output failure class in the shared Agent runner.
 *
 * The bug these pin: a run that finished its whole retrieval stage and then
 * returned no answer at all — the shape Perplexity reports as
 * `model_error: ... (reasoning_only)`, with `usage: null` and zero `message`
 * items in `output` — reached the caller as one sentence of upstream prose.
 * Nothing in that sentence said the request had been accepted, that the research
 * had completed, or that the model stage was what failed, so the failure could
 * not be told apart from a rate limit (HTTP 429) or a connection failure, and a
 * reader could not decide whether to wait, retry, or go upstream.
 *
 * These pin three things, all offline:
 *   1. the class and the facts it carries (upstream `error.code`, run id(s),
 *      retrieval counts, zero answer messages, billed/not-billed),
 *   2. that it is *not* conflated with a 429 or a connection failure,
 *   3. that the two independent axes are right: retry safety is decided by
 *      `usage` (`isUnbilledFailure`), classification by the missing answer
 *      (`isModelNoOutputFailure`) — a billed run is classified and reported but
 *      never repeated.
 *
 * Everything here is deterministic: `globalThis.fetch` is stubbed and the poll
 * interval is a few milliseconds, so no test touches the network or consumes
 * Perplexity quota. A run's *stored* snapshot is what the poll gets, which is
 * exactly what `scripts/probe-failed-run.mjs` retrieves from the live API.
 *
 * Run: npm test
 */

import { WebError } from '@deepseek-ai/dsh-web'
import {
  AgentModelNoOutputError,
  AgentRunError,
  MODEL_NO_OUTPUT,
  isModelNoOutputFailure,
  isUnbilledFailure,
  runAgentRequest,
  summarizeAgentOutput,
} from '../src/agent-run.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const BASE_URL = 'https://api.perplexity.ai'
const OPTIONS = { baseURL: BASE_URL }
/** Short enough that a whole scripted run costs milliseconds, never a second. */
const POLL_MS = 5
const noSignal = undefined

/** One stubbed HTTP response carrying `data` at `status`. */
function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  }
}

/**
 * Install a stub that answers in scripted order and records every request.
 *
 * @param responses - responses, or thunks for a request that must fail.
 * @returns the recorded `{ method, url }` list, so call counts are provable.
 */
function stubSequence(responses) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url) })
    const next = responses.shift()
    if (next === undefined) throw new Error(`unexpected extra request: ${init?.method} ${url}`)
    return typeof next === 'function' ? next() : next
  }
  return calls
}

const queued = (id) => jsonResponse({ id, status: 'queued', output: [] })

/** The live shape of the failure: retrieval complete, no message, nothing billed. */
function failedNoOutput(id, overrides = {}) {
  return jsonResponse({
    id,
    status: 'failed',
    error: {
      code: 'model_error',
      message: 'echolot: model produced no usable answer: no usable answer (reasoning_only)',
    },
    usage: null,
    output: [
      { type: 'search_results', results: [{ url: 'https://example.com/a' }] },
      { type: 'search_results', results: [{ url: 'https://example.com/b' }] },
      { type: 'fetch_url_results', contents: [{ url: 'https://example.com/c' }] },
    ],
    ...overrides,
  })
}

/** Run one scripted agent call and return `{ value }` or `{ error }`. */
async function run(responses, body = { input: 'q', preset: 'high' }) {
  const calls = stubSequence(responses)
  try {
    const value = await runAgentRequest(body, OPTIONS, 'test-key', noSignal, 60_000, POLL_MS)
    return { value, calls }
  } catch (error) {
    return { error, calls }
  }
}

// ── 1. The class and the facts it must carry ─────────────────────────────────
console.log('\n1. a model-stage no-output failure is its own class with the machine facts')
{
  const { error, calls } = await run([queued('resp_1'), failedNoOutput('resp_1'), queued('resp_2'), failedNoOutput('resp_2')])

  check('it is the model-no-output class',
    error?.name === 'AgentModelNoOutputError' && error instanceof AgentModelNoOutputError,
    `${error?.name}`)
  check('it is still an AgentRunError, so the retry decision can read its response',
    error instanceof AgentRunError && error?.response !== undefined, `${error?.name}`)
  check('it stays a provider error for the seam', error?.code === 'WEB_PROVIDER_ERROR', String(error?.code))
  check('it is a WebError', error instanceof WebError, String(error?.constructor?.name))
  check('it carries a machine-readable failure kind',
    error?.failureKind === MODEL_NO_OUTPUT, String(error?.failureKind))
  check('it names the upstream error code',
    error?.errorCode === 'model_error' && String(error?.message).includes('model_error'),
    `errorCode=${error?.errorCode}`)

  const message = String(error?.message)
  check('the message says the retrieval stage ran and how much of it did',
    message.includes('retrieval stage ran') && message.includes('2 search-result batches')
      && message.includes('1 URL-fetch batch'),
    message.slice(0, 200))
  check('the message says the model stage emitted nothing',
    message.includes('emitted nothing') && message.includes('0 message items'), message.slice(0, 200))
  check('the message states nothing was billed, and quotes usage: null',
    message.includes('Nothing was billed') && message.includes('usage: null'), message.slice(0, 240))
  check('the message says this is not a rate limit and not a connection failure',
    message.includes('not a rate limit') && message.includes('not a connection failure'), message.slice(0, 260))
  check('the message keeps the upstream sentence verbatim',
    message.includes('reasoning_only'), message.slice(-160))
  check('the message names every attempt and its run ids',
    error?.attempts === 2 && error?.responseIds?.join(',') === 'resp_1,resp_2'
      && message.includes('resp_1') && message.includes('resp_2'),
    `attempts=${error?.attempts} ids=${error?.responseIds}`)
  check('the message says how to retrieve the stored run',
    message.includes(`GET ${BASE_URL}/v1/agent/resp_2`), message.slice(0, 300))
  check('the message names the preset that was asked for',
    error?.preset === 'high' && message.includes('preset high'), String(error?.preset))
  check('the counts are exposed as fields too',
    error?.retrievalCompleted === true && error?.searchResultBatches === 2
      && error?.fetchUrlBatches === 1 && error?.messageItems === 0 && error?.answerChars === 0,
    JSON.stringify({
      retrievalCompleted: error?.retrievalCompleted,
      search: error?.searchResultBatches,
      fetch: error?.fetchUrlBatches,
      messages: error?.messageItems,
    }))
  check('it is not billed, so the run was safe to retry',
    error?.billed === false && isUnbilledFailure(error?.response) === true)
  check('the unbilled failure really was retried once (4 requests: 2 submits, 2 polls)',
    calls.length === 4 && calls[0].method === 'POST' && calls[2].method === 'POST',
    calls.map((call) => call.method).join(','))
  check('no placeholder leaked into the message', !/undefined|NaN|\[object/.test(message), message.slice(0, 200))
  // The failure this class exists to separate itself from. The only HTTP status
  // the message may mention is the 429 it explicitly rules out; it must not
  // present a status of its own the way the transport-level report does.
  check('it reports no HTTP status of its own',
    error?.status === undefined && !/HTTP \d+ after/.test(message),
    `status=${error?.status}`)
  check('its only HTTP mention is the rate limit it rules out',
    (message.match(/HTTP \d+/g) ?? []).join(',') === 'HTTP 429' && message.includes('no HTTP 429'),
    (message.match(/HTTP \d+/g) ?? []).join(','))

  // `invalid_request` is the same class: the run was accepted and retrieved, so
  // the code describes the model stage rather than our request body.
  const invalid = await run([
    queued('resp_i1'),
    failedNoOutput('resp_i1', { error: { code: 'invalid_request', message: 'invalid request' } }),
    queued('resp_i2'),
    failedNoOutput('resp_i2', { error: { code: 'invalid_request', message: 'invalid request' } }),
  ])
  check('an invalid_request failure with a completed retrieval is the same class',
    invalid.error?.failureKind === MODEL_NO_OUTPUT && invalid.error?.errorCode === 'invalid_request',
    `${invalid.error?.failureKind}/${invalid.error?.errorCode}`)
  check('and the message reports the code without blaming the request body',
    String(invalid.error?.message).includes('invalid_request')
      && String(invalid.error?.message).includes('retrieval stage ran')
      && invalid.error?.retrievalCompleted === true,
    String(invalid.error?.message).slice(0, 200))
}

// ── 2. Not conflated with the 429 rate-limit path ────────────────────────────
console.log('\n2. a 429 is still a 429, never a model-stage failure')
{
  const { error } = await run([jsonResponse({ error: { message: 'Request rate limit exceeded, please try again later.' } }, 429)])
  const message = String(error?.message)
  check('the HTTP status is named', /HTTP 429/.test(message), message.slice(0, 120))
  check('the status is a field', error?.status === 429, String(error?.status))
  check('it is not classified as a model-stage failure',
    error?.failureKind === undefined && !(error instanceof AgentRunError), String(error?.failureKind))
  check('its message does not mention the model stage', !message.includes('model stage'), message.slice(0, 160))
  check('its message keeps the upstream rate-limit prose',
    message.includes('rate limit exceeded'), message.slice(-120))
  check('a 429 is not reported as a WebError subclass of the runner',
    !(error instanceof AgentModelNoOutputError), String(error?.constructor?.name))
}

// ── 3. Not conflated with a connection failure ───────────────────────────────
console.log('\n3. a connection failure stays a connection failure')
{
  const { error } = await run([() => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:443')
    cause.code = 'ECONNREFUSED'
    throw new TypeError('fetch failed', { cause })
  }])
  const message = String(error?.message)
  check('the cause chain is reported', message.includes('fetch failed') && message.includes('ECONNREFUSED'),
    message.slice(0, 200))
  check('no HTTP status is invented', error?.status === undefined, String(error?.status))
  check('it is not classified as a model-stage failure',
    error?.failureKind === undefined && !(error instanceof AgentRunError), String(error?.failureKind))
  check('its message does not mention the model stage', !message.includes('model stage'), message.slice(0, 160))
}

// ── 4. Billing and classification are independent axes ───────────────────────
console.log('\n4. a billed no-output failure is classified and reported, but never repeated')
{
  const billed = { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
  const { error, calls } = await run([
    queued('resp_b'),
    failedNoOutput('resp_b', { usage: billed }),
  ])
  check('it is still the model-no-output class', error?.failureKind === MODEL_NO_OUTPUT, String(error?.failureKind))
  check('it is reported as billed', error?.billed === true && String(error?.message).includes('was billed'),
    `billed=${error?.billed}`)
  check('it was not retried (2 requests: 1 submit, 1 poll)', calls.length === 2, `requests=${calls.length}`)
  check('only one attempt is claimed', error?.attempts === 1 && error?.responseIds?.join(',') === 'resp_b',
    `attempts=${error?.attempts} ids=${error?.responseIds}`)
  check('the two axes are independent for this snapshot',
    isUnbilledFailure(error?.response) === false && isModelNoOutputFailure(error?.response) === true)
  check('the message does not tell the reader it was safe to retry',
    !String(error?.message).includes('Nothing was billed'), String(error?.message).slice(0, 200))

  // First attempt unbilled, retry billed: the retry happens (it was safe), and
  // the billed failure ends the call as the last word — attempts stays 1,
  // because only one attempt was *reported* as the failure.
  const mixed = await run([queued('resp_u'), failedNoOutput('resp_u'), queued('resp_b2'), failedNoOutput('resp_b2', { usage: billed })])
  check('a retry that is billed ends the call rather than being reported as an unpaid double failure',
    mixed.error?.billed === true && mixed.error?.attempts === 1 && mixed.calls.length === 4,
    `billed=${mixed.error?.billed} attempts=${mixed.error?.attempts} requests=${mixed.calls.length}`)
}

// ── 5. A successful run is untouched ─────────────────────────────────────────
console.log('\n5. the classifier does not touch a run that answered')
{
  const answered = jsonResponse({
    id: 'resp_ok',
    status: 'completed',
    output: [
      { type: 'search_results', results: [{ url: 'https://example.com/a' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'the answer' }] },
    ],
  })
  const { value, calls } = await run([queued('resp_ok'), answered])
  check('the completed snapshot is returned as-is',
    value?.status === 'completed' && value?.id === 'resp_ok' && calls.length === 2,
    `status=${value?.status} requests=${calls.length}`)
  check('a completed run is not a no-output failure', isModelNoOutputFailure(value) === false)
}

// ── 6. The predicates and the counts, on their own ───────────────────────────
console.log('\n6. the classification predicates are narrow')
{
  const withMessage = {
    status: 'failed',
    usage: null,
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
  }
  const withoutMessage = {
    status: 'failed',
    usage: null,
    output: [{ type: 'search_results', results: [] }, { type: 'finance_results', results: [] }],
  }
  check('a failed run with a message is not a no-output failure', isModelNoOutputFailure(withMessage) === false)
  check('a failed run without a message is one', isModelNoOutputFailure(withoutMessage) === true)
  check('a completed run is never one', isModelNoOutputFailure({ status: 'completed', output: [] }) === false)
  check('a cancelled run is never one', isModelNoOutputFailure({ status: 'cancelled', output: [] }) === false)
  check('a non-object is never one',
    isModelNoOutputFailure(null) === false && isModelNoOutputFailure(undefined) === false
      && isModelNoOutputFailure('failed') === false)

  const summary = summarizeAgentOutput({
    output: [
      { type: 'search_results', results: [] },
      { type: 'message', content: [{ type: 'output_text', text: 'abc' }, { type: 'output_text', text: 'de' }] },
      { type: 'message', content: [] },
      { type: 'sandbox_results', status: 'completed' },
    ],
  })
  check('the counts add up across every item type',
    summary.itemCount === 4 && summary.messageItems === 2 && summary.answerChars === 5
      && summary.searchResultBatches === 1 && summary.fetchUrlBatches === 0
      && summary.otherItemTypes.join(',') === 'sandbox_results',
    JSON.stringify(summary))
  check('a response with no output array counts as zero, not as a crash',
    JSON.stringify(summarizeAgentOutput({})) === JSON.stringify({
      itemCount: 0, messageItems: 0, answerChars: 0, searchResultBatches: 0, fetchUrlBatches: 0, otherItemTypes: [],
    }), JSON.stringify(summarizeAgentOutput({})))
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
