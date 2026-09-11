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
 * peers, which a plain checkout of this repository does not install. By default
 * the test therefore loads the copy installed into a DSH profile; point
 * `PPLX_PLUGIN_ENTRY` at any other built copy (for example a local
 * `file:C:/.../dsh-web-search-perplexity`) to test that one instead.
 */

const DEFAULT_ENTRY =
  'file:///C:/Users/Administrator/.dsh/profiles/web/node_modules/@shjwudp/dsh-web-search-perplexity/src/index.js'
const MODULE = process.env.PPLX_PLUGIN_ENTRY ?? DEFAULT_ENTRY

const { apply } = await import(MODULE)

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

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
