/**
 * Deterministic tests for the Agent-mode soft deadline and its degraded retry.
 *
 * `globalThis.fetch` is stubbed, so these tests never touch the network and
 * never consume Perplexity quota. They drive the plugin's registered search
 * provider through a minimal fake cordis context.
 *
 * Run: npm test
 *
 * The host module imports the `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-web`
 * peers, which a plain checkout of this repository does not install. The entry is
 * therefore chosen in this order, so that a test run is never silently checking a
 * different (possibly stale) copy than the one under review:
 *
 * 1. `PPLX_PLUGIN_ENTRY` — an explicit absolute module specifier, e.g. a
 *    `file:///...` URL or a path to any built copy.
 * 2. This repository's own `src/index.js`, when Node can also resolve its peers
 *    from here (a DSH profile install, or a checkout with the peers linked in).
 * 3. The plugin installed into a DSH profile, which does resolve the peers but
 *    may lag the working tree.
 *
 * The chosen entry is printed so a surprising result is visible, not implied.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoEntry = resolve(repoRoot, 'src/index.js')

/**
 * Machine-specific fallback: a DSH profile install on the author's machine. On
 * any other machine this path does not exist, the import fails loudly with
 * `ERR_MODULE_NOT_FOUND`, and `PPLX_PLUGIN_ENTRY` is the supported way in.
 */
const PROFILE_ENTRY =
  'file:///C:/Users/Administrator/.dsh/profiles/web/node_modules/@shjwudp/dsh-web-search-perplexity/src/index.js'

/** True when `specifier` imports without a module-resolution failure. */
async function isImportable(specifier) {
  try {
    await import(specifier)
    return true
  } catch (error) {
    const unresolved = error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT'
    if (unresolved) return false
    // The module loaded and threw while being evaluated: it is resolvable.
    return true
  }
}

async function chooseEntry() {
  const override = process.env.PPLX_PLUGIN_ENTRY
  if (override !== undefined && override !== '') return override
  if (existsSync(repoEntry) && await isImportable(pathToFileURL(repoEntry).href)) {
    return pathToFileURL(repoEntry).href
  }
  return PROFILE_ENTRY
}

const MODULE = await chooseEntry()
if (process.env.PPLX_PLUGIN_ENTRY === undefined) {
  const fromWorkingTree = MODULE.includes(repoRoot.replace(/\\/g, '/'))
  console.log(`\nentry: ${MODULE}`)
  if (fromWorkingTree) {
    console.log('       (this repository\'s working tree — tests the code under review)')
  } else {
    console.log('       (installed profile copy — NOT the working tree)')
    console.log('       The peers are unreachable from this checkout, so these results describe the')
    console.log('       installed copy. Set PPLX_PLUGIN_ENTRY to test a different one.')
  }
}

const {
  apply,
  defaultSoftTimeoutMsFor,
  PRESET_SOFT_TIMEOUT_MS,
  FALLBACK_TIMEOUT_MS,
  TOOL_BUDGET_MS,
  COMPONENT_TOOL_BUDGET_MS,
  FAST_DEADLINE_MARGIN_MS,
  FAST_PRESET_SOFT_TIMEOUT_MS,
  MAX_SOFT_TIMEOUT_MS,
  SOFT_DEADLINE_MARGIN_MS,
  DEGRADED_MARKER_PREFIX,
} = await import(MODULE)

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Register the provider with a minimal fake cordis context. */
function makeProvider(config) {
  let provider
  const ctx = {
    on() {},
    get() { return undefined },
    inject() {},
    web: { registerSearchProvider(p) { provider = p } },
  }
  apply(ctx, config)
  if (provider === undefined) throw new Error('provider was not registered')
  return provider
}

/** A fetch stub whose behavior is decided per call index. */
function stubFetch(handlers) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = init?.body !== undefined ? JSON.parse(init.body) : undefined
    const index = calls.length
    calls.push({ url, body, signal: init?.signal })
    return handlers[index](init?.signal, body)
  }
  return calls
}

/** A fetch stub that only settles when its signal aborts, like a slow backend. */
function neverSettles(signal) {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal === undefined) return
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function agentOk(text) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text }] },
        { type: 'search_results', results: [{ url: 'https://example.com/a', title: 'A' }] },
      ],
    }),
  }
}

const baseConfig = {
  apiKey: 'test-key',
  apiMode: 'agent',
  preset: 'medium',
  baseURL: 'https://api.perplexity.ai',
  maxTokens: 100,
}

// ── 1. Soft deadline fires, the fast fallback answers, the result is labelled ──
console.log('\n1. soft deadline -> degraded fast fallback')
{
  const calls = stubFetch([(s) => neverSettles(s), () => agentOk('fast answer')])
  const provider = makeProvider({ ...baseConfig, softTimeoutMs: 300, fallbackPreset: 'fast' })
  const started = Date.now()
  const result = await provider.search({ query: 'broad question', maxResults: 5 }, new AbortController().signal)
  const elapsed = Date.now() - started

  check('two attempts were made', calls.length === 2, `calls=${calls.length}`)
  check('primary used the configured preset', calls[0]?.body?.preset === 'medium', JSON.stringify(calls[0]?.body?.preset))
  check('retry used the fallback preset', calls[1]?.body?.preset === 'fast', JSON.stringify(calls[1]?.body?.preset))
  check('answer is labelled degraded', String(result.content).includes('Degraded result'))
  check('fallback text is returned', String(result.content).includes('fast answer'))
  check('sources survive the fallback', result.sources.length === 1 && result.sources[0].url === 'https://example.com/a')
  check('returned well inside the 60s budget', elapsed >= 300 && elapsed < 2000, `elapsed=${elapsed}ms`)

  // ── the machine-readable degradation contract (marker + seam field) ──
  const markerLine = String(result.content).split('\n', 1)[0]
  check('the degraded marker is the first line of content',
    markerLine.startsWith(DEGRADED_MARKER_PREFIX), markerLine.slice(0, 90))
  let markerStatus
  try {
    markerStatus = JSON.parse(markerLine.slice(DEGRADED_MARKER_PREFIX.length))
  } catch {
    markerStatus = undefined
  }
  check('the marker payload is one JSON object', markerStatus !== undefined, markerLine.slice(0, 120))
  check('the seam result carries the same status as the marker',
    JSON.stringify(result.degradation) === JSON.stringify(markerStatus),
    `${JSON.stringify(result.degradation)} vs ${JSON.stringify(markerStatus)}`)
  check('the status says the answer degraded', markerStatus?.degraded === true, JSON.stringify(markerStatus))
  check('the status names the requested preset', markerStatus?.requestedPreset === 'medium', JSON.stringify(markerStatus))
  check('the status names the preset that actually answered', markerStatus?.actualPreset === 'fast', JSON.stringify(markerStatus))
  check('the status reports the deadline that was in force', markerStatus?.softTimeoutMs === 300, JSON.stringify(markerStatus))
}

// ── 2. An outer cancellation never retries: no budget is left ──────────────────
console.log('\n2. outer (harness) cancellation -> no fallback')
{
  const calls = stubFetch([(s) => neverSettles(s), () => agentOk('must not happen')])
  const provider = makeProvider({ ...baseConfig, softTimeoutMs: 5000 })
  const outer = new AbortController()
  setTimeout(() => outer.abort(), 120)
  let error
  try {
    await provider.search({ query: 'slow question', maxResults: 5 }, outer.signal)
  } catch (caught) {
    error = caught
  }
  check('the call rejected', error !== undefined)
  check('only the primary attempt ran', calls.length === 1, `calls=${calls.length}`)
  check('rejection is the abort, not a timeout rewrite', error?.code === 'WEB_ABORTED', `code=${error?.code}`)
}

// ── 3. softTimeoutMs = 0 keeps the original single-request behavior ─────────────
console.log('\n3. softTimeoutMs = 0 -> single request, no label')
{
  const calls = stubFetch([() => agentOk('plain answer')])
  const provider = makeProvider({ ...baseConfig, softTimeoutMs: 0 })
  const result = await provider.search({ query: 'quick question', maxResults: 5 })
  check('exactly one attempt', calls.length === 1, `calls=${calls.length}`)
  check('no degradation label', !String(result.content).includes('Degraded result'))
  check('answer passes through', String(result.content).includes('plain answer'))
}

// ── 4. Both attempts over budget -> actionable error, not an opaque timeout ────
console.log('\n4. primary and fallback both stall -> actionable error')
{
  const calls = stubFetch([(s) => neverSettles(s), (s) => neverSettles(s)])
  const provider = makeProvider({ ...baseConfig, softTimeoutMs: 200 })
  let error
  try {
    await provider.search({ query: 'hopeless question', maxResults: 5 }, new AbortController().signal)
  } catch (caught) {
    error = caught
  }
  check('two attempts were made', calls.length === 2, `calls=${calls.length}`)
  check('error names the soft deadline', String(error?.message).includes('soft deadline'), String(error?.message))
  check('error suggests a remedy', String(error?.message).includes('narrower'), String(error?.message))
  check('error is a provider error', error?.code === 'WEB_PROVIDER_ERROR', `code=${error?.code}`)
}

// ── 5. An unset soft deadline follows the preset, not one flat constant ────────
// The previous flat 25 s default sat *below* the `medium` preset's own measured
// 25.3 s narrow-query latency, so every `medium` narrow query spent the full
// 25 s and was then answered by a `fast` retry: the degraded path stopped being
// a boundary case and became the default outcome. The default is now derived
// per preset, and every value must still leave room for the retry inside the
// tool budget the session actually runs under.
console.log('\n5. an unset soft deadline is derived from the preset')
// Resolved once here, reused by block 6.
const FAST_TIER_MS = defaultSoftTimeoutMsFor('fast')
const MEDIUM_TIER_MS = defaultSoftTimeoutMsFor('medium')
{
  const MEASURED_MEDIUM_NARROW_MS = 25_300
  const presets = ['fast', 'low', 'medium', 'high', 'xhigh', 'wide-research']

  check('the assumed budgets match the shipped DSH rows',
    TOOL_BUDGET_MS === 60_000 && COMPONENT_TOOL_BUDGET_MS === 30_000,
    `preset=${TOOL_BUDGET_MS} component=${COMPONENT_TOOL_BUDGET_MS}`)
  check('the preset default plus its retry fits the 60 s preset budget',
    presets.every((p) => defaultSoftTimeoutMsFor(p) + FALLBACK_TIMEOUT_MS <= TOOL_BUDGET_MS),
    presets.map((p) => `${p}=${defaultSoftTimeoutMsFor(p)}`).join(' '))
  check('the medium default clears the measured narrow latency',
    defaultSoftTimeoutMsFor('medium') > MEASURED_MEDIUM_NARROW_MS,
    `medium=${defaultSoftTimeoutMsFor('medium')}ms vs measured ${MEASURED_MEDIUM_NARROW_MS}ms`)
  check('the medium default is the derived ceiling, not an ad-hoc number',
    MEDIUM_TIER_MS === TOOL_BUDGET_MS - FALLBACK_TIMEOUT_MS - 5_000, `medium=${MEDIUM_TIER_MS}`)
  check('the fast default is derived from its own named margin',
    FAST_TIER_MS === COMPONENT_TOOL_BUDGET_MS - FALLBACK_TIMEOUT_MS - FAST_DEADLINE_MARGIN_MS,
    `fast=${FAST_TIER_MS} margin=${FAST_DEADLINE_MARGIN_MS}`)
  check('the derived tiers are the documented 12000 and 40000',
    FAST_PRESET_SOFT_TIMEOUT_MS === 12_000 && MAX_SOFT_TIMEOUT_MS === 40_000
      && SOFT_DEADLINE_MARGIN_MS === 5_000,
    `fast=${FAST_PRESET_SOFT_TIMEOUT_MS} max=${MAX_SOFT_TIMEOUT_MS}`)
  check('the fast presets also fit the 30 s component budget',
    ['fast', 'low'].every((p) => defaultSoftTimeoutMsFor(p) + FALLBACK_TIMEOUT_MS <= COMPONENT_TOOL_BUDGET_MS),
    `fast=${FAST_TIER_MS} budget=${COMPONENT_TOOL_BUDGET_MS}`)
  check('every preset default is one of the two derived tiers',
    presets.every((p) => defaultSoftTimeoutMsFor(p) === FAST_TIER_MS || defaultSoftTimeoutMsFor(p) === MEDIUM_TIER_MS),
    JSON.stringify(PRESET_SOFT_TIMEOUT_MS))
  check('the old flat 25 s default is gone from every preset',
    presets.every((p) => defaultSoftTimeoutMsFor(p) !== 25_000),
    JSON.stringify(PRESET_SOFT_TIMEOUT_MS))
  check('an unset preset falls back to the ceiling',
    defaultSoftTimeoutMsFor('') === MEDIUM_TIER_MS, `unset=${defaultSoftTimeoutMsFor('')}`)
}

// ── 6. The derived default is what the provider actually resolves ──────────────
console.log('\n6. resolveOptions applies the preset default; an explicit value wins')
{
  stubFetch([() => agentOk('medium answer')])
  // No softTimeoutMs in the config: the preset-derived default must apply.
  const mediumResult = await makeProvider({ ...baseConfig })
    .search({ query: 'narrow question', maxResults: 5 })

  check('medium without softTimeoutMs resolves the medium default',
    mediumResult.degradation?.softTimeoutMs === MEDIUM_TIER_MS,
    `resolved=${mediumResult.degradation?.softTimeoutMs}`)
  check('a full-depth answer reports not degraded', mediumResult.degradation?.degraded === false,
    JSON.stringify(mediumResult.degradation))
  check('a full-depth answer carries no degraded marker',
    !String(mediumResult.content).includes(DEGRADED_MARKER_PREFIX))
  check('a full-depth answer reports the preset that answered',
    mediumResult.degradation?.requestedPreset === 'medium'
      && mediumResult.degradation?.actualPreset === 'medium'
      && mediumResult.degradation?.fallbackTimeoutMs === 0,
    JSON.stringify(mediumResult.degradation))

  stubFetch([() => agentOk('low answer')])
  const lowResult = await makeProvider({ ...baseConfig, preset: 'low' })
    .search({ query: 'narrow question', maxResults: 5 })
  check('a cheaper preset resolves its own, smaller default',
    lowResult.degradation?.softTimeoutMs === FAST_TIER_MS && FAST_TIER_MS !== MEDIUM_TIER_MS,
    `low=${lowResult.degradation?.softTimeoutMs} medium=${MEDIUM_TIER_MS}`)

  const explicitCalls = stubFetch([() => agentOk('explicit answer')])
  const explicitResult = await makeProvider({ ...baseConfig, softTimeoutMs: 7_000 })
    .search({ query: 'narrow question', maxResults: 5 })
  check('an explicit softTimeoutMs overrides the preset default',
    explicitResult.degradation?.softTimeoutMs === 7_000, `resolved=${explicitResult.degradation?.softTimeoutMs}`)
  check('the override adds no attempt', explicitCalls.length === 1, `calls=${explicitCalls.length}`)

  stubFetch([() => agentOk('undeadlined answer')])
  const offResult = await makeProvider({ ...baseConfig, softTimeoutMs: 0 })
    .search({ query: 'narrow question', maxResults: 5 })
  check('0 still disables the deadline and reserves no retry budget',
    offResult.degradation?.softTimeoutMs === 0 && offResult.degradation?.fallbackTimeoutMs === 0,
    JSON.stringify(offResult.degradation))
}

// ── 7. A 429 backoff honors a signal that was already aborted when it began ────
// `sleep` must reject immediately on an already-aborted signal. Omitting the
// soft deadline puts the outer signal straight onto the request, so a signal
// aborted before the call reaches the provider is forwarded as-is: the response
// then arrives as a 429 and the backoff starts against an aborted signal. That
// models a harness cancel landing while a 429 response is in flight, which is
// exactly when a provider is most likely to be rate-limiting.
//
// A signal already aborted never fires `abort` again, so without the guard the
// backoff runs to completion and issues another request that the caller cannot
// use — it has already been cancelled.
console.log('\n7. an already-aborted signal does not wait out the 429 backoff')
{
  const RETRY_AFTER = '0.5'
  const RESPONSE_DELAY_MS = 40
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body !== undefined ? JSON.parse(init.body) : undefined })
    await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS))
    return {
      ok: false,
      status: 429,
      headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? RETRY_AFTER : null) },
      json: async () => ({ error: 'rate limited' }),
    }
  }

  // softTimeoutMs: 0 keeps the outer signal un-derived, so it reaches requestJson aborted.
  const provider = makeProvider({ ...baseConfig, softTimeoutMs: 0 })
  const outer = new AbortController()
  outer.abort()
  const started = Date.now()
  let error
  try {
    await provider.search({ query: 'cancelled question', maxResults: 5 }, outer.signal)
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - started

  check('the call rejected', error !== undefined)
  check('rejection is the abort, not a timeout rewrite', error?.code === 'WEB_ABORTED', `code=${error?.code}`)
  // Discriminating assertion: without the already-aborted guard the backoff runs
  // its full 500ms and a SECOND request is issued before the abort is noticed.
  check('no further request was issued while backing off', calls.length === 1, `calls=${calls.length}`)
  check(
    'the backoff did not run to completion',
    elapsed < Number(RETRY_AFTER) * 1000,
    `elapsed=${elapsed}ms of a ${Number(RETRY_AFTER) * 1000}ms backoff`,
  )
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
