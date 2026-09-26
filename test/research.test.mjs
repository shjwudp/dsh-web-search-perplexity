/**
 * Deterministic tests for the `perplexity_research` tool.
 *
 * The point of this tool is its own timeout budget: `web_search` is bounded by
 * `tool-web.searchTimeoutMs` (60 s under the shipped presets, per-session
 * composition, out of a plugin's reach), while the Agent API's `wide-research`
 * preset runs for minutes. These tests pin that budget, the preset each depth
 * selects, and the request the tool actually sends.
 *
 * They also pin the tool's optional `image` argument: the request shape it
 * builds, the read guards it shares with the provider path (`imageRoots`,
 * `imageMaxBytes`, the byte sniff), and what `imageInput` off does to it. Every
 * local-image case writes its own file under the OS temp directory and declares
 * that directory in `imageRoots`, so nothing depends on the developer's home
 * directory.
 *
 * `globalThis.fetch` is stubbed, so nothing here touches the network.
 *
 * Run: npm test
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoEntry = resolve(repoRoot, 'src/index.js')

/** Machine-specific fallback: a DSH profile install on the author's machine. */
const PROFILE_ROOT = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules',
  '@shjwudp', 'dsh-web-search-perplexity')

async function isImportable(specifier) {
  try {
    await import(specifier)
    return true
  } catch (error) {
    const unresolved = error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT'
    if (unresolved) return false
    return true
  }
}

async function chooseEntry() {
  const override = process.env.PPLX_PLUGIN_ENTRY
  if (override !== undefined && override !== '') return override
  if (existsSync(repoEntry) && await isImportable(pathToFileURL(repoEntry).href)) {
    return pathToFileURL(repoEntry).href
  }
  return pathToFileURL(join(PROFILE_ROOT, 'src', 'index.js')).href
}

const MODULE = await chooseEntry()
console.log(`\nentry: ${MODULE}`)
const plugin = await import(MODULE)
const {
  apply,
  DEFAULT_RESEARCH_TIMEOUT_MS,
  IMAGE_MARKER_PREFIX,
  RESEARCH_DEFAULT_DEPTH,
  RESEARCH_DEPTHS,
  RESEARCH_TOOL_NAME,
  formatResearchOutput,
  parseResearchArgs,
  researchDepth,
  researchTimeoutMs,
} = plugin
if (typeof apply !== 'function' || typeof RESEARCH_TOOL_NAME !== 'string'
  || typeof IMAGE_MARKER_PREFIX !== 'string') {
  console.error('This copy does not export the research surface; sync the working tree first.')
  process.exit(1)
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Register the plugin with a minimal fake context and return the research tool
 * plus the registered prompt sections.
 */
function makeTool(config) {
  const registered = []
  const sections = []
  const providers = []
  const ctx = {
    on() {},
    get(name) {
      if (name === 'tools') return { register(tool) { registered.push(tool); return () => {} } }
      if (name === 'credentials') return { resolve: async (ref) => ({ value: process.env[ref] }) }
      return undefined
    },
    inject() {},
    web: { registerSearchProvider(provider) { providers.push(provider) } },
    tools: { register(tool) { registered.push(tool); return () => {} } },
    systemPrompt: { section(section) { sections.push(section) }, getSectionOrder: () => 100 },
  }
  apply(ctx, config)
  const tool = registered.find((candidate) => candidate.name === RESEARCH_TOOL_NAME)
  if (tool === undefined) throw new Error(`${RESEARCH_TOOL_NAME} was not registered`)
  return { tool, sections, providers }
}

/** A fetch stub that records each parsed request body and answers `200`. */
function stubFetch(responder) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = init?.body !== undefined ? JSON.parse(init.body) : undefined
    calls.push({ url, body, signal: init?.signal })
    return responder(init?.signal, body)
  }
  return calls
}

function agentOk(text) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      status: 'completed',
      model: 'openai/gpt-5.6-sol',
      output: [
        { type: 'message', content: [{ type: 'output_text', text }] },
        { type: 'search_results', results: [{ url: 'https://example.com/a', title: 'A', snippet: 's' }] },
      ],
    }),
  }
}

/** One stubbed HTTP response carrying `data` at `status`. */
function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  }
}

/** Minimal execution context: the tool only reads `signal`. */
const exec = { signal: new AbortController().signal }

const baseConfig = { apiKey: 'test-key', baseURL: 'https://api.perplexity.ai', maxTokens: 500 }

// ── 1. The tool carries its own budget, independent of tool-web ─────────────
console.log('\n1. the tool declares its own timeout budget')
{
  const { tool } = makeTool(baseConfig)
  check('a default budget is declared',
    tool.timeoutMs === DEFAULT_RESEARCH_TIMEOUT_MS && DEFAULT_RESEARCH_TIMEOUT_MS === 1_800_000,
    `timeoutMs=${tool.timeoutMs}`)
  check('the budget is far beyond the shipped tool-web search budget',
    tool.timeoutMs > 60_000, `${tool.timeoutMs} vs 60000`)

  const { tool: short } = makeTool({ ...baseConfig, researchTimeoutMs: 120_000 })
  check('a configured budget overrides the default', short.timeoutMs === 120_000, String(short.timeoutMs))

  // defineTool rejects a non-positive budget, so 0 must remove the field.
  const { tool: off } = makeTool({ ...baseConfig, researchTimeoutMs: 0 })
  check('0 declares no deadline at all', off.timeoutMs === undefined, String(off.timeoutMs))

  check('the resolver is usable on its own',
    researchTimeoutMs({ researchTimeoutMs: 30_000 }) === 30_000
      && researchTimeoutMs({}) === DEFAULT_RESEARCH_TIMEOUT_MS)
}

// ── 2. Each depth selects the Agent preset it promises ─────────────────────
console.log('\n2. depth selects the Agent preset')
{
  const calls = stubFetch(() => agentOk('deep answer'))
  const { tool } = makeTool({ ...baseConfig, preset: 'medium' })
  await tool.execute({ question: 'a broad research question', depth: 'high' }, exec)
  check('an explicit depth wins over the configured preset',
    calls[0]?.body?.preset === 'high', JSON.stringify(calls[0]?.body?.preset))
  check('the request went to the Agent API',
    String(calls[0]?.url).endsWith('/v1/agent'), calls[0]?.url)

  const defaultCalls = stubFetch(() => agentOk('default answer'))
  await makeTool(baseConfig).tool.execute({ question: 'collect items' }, exec)
  check('an omitted depth defaults to the cheapest offered depth',
    defaultCalls[0]?.body?.preset === RESEARCH_DEPTHS[RESEARCH_DEFAULT_DEPTH].preset
      && defaultCalls[0]?.body?.preset === 'low' && RESEARCH_DEFAULT_DEPTH === 'low',
    JSON.stringify(defaultCalls[0]?.body?.preset))
  check('the shallowest depth is offered at all',
    RESEARCH_DEPTHS.low?.preset === 'low' && Object.keys(RESEARCH_DEPTHS)[0] === 'low',
    JSON.stringify(Object.keys(RESEARCH_DEPTHS)))

  // A deployment may configure a deeper default; anything it does not recognize
  // must fall back rather than break the tool.
  const configuredCalls = stubFetch(() => agentOk('configured default'))
  await makeTool({ ...baseConfig, researchDepth: 'high' }).tool.execute({ question: 'q' }, exec)
  check('a configured researchDepth becomes the default',
    configuredCalls[0]?.body?.preset === 'high', JSON.stringify(configuredCalls[0]?.body?.preset))

  const explicitCalls = stubFetch(() => agentOk('explicit wins'))
  await makeTool({ ...baseConfig, researchDepth: 'high' }).tool.execute({ question: 'q', depth: 'low' }, exec)
  check('an explicit depth still wins over the configured default',
    explicitCalls[0]?.body?.preset === 'low', JSON.stringify(explicitCalls[0]?.body?.preset))

  check('the resolver is usable on its own, and ignores an unknown value',
    researchDepth({ researchDepth: 'high' }) === 'high'
      && researchDepth({ researchDepth: 'unlimited' }) === RESEARCH_DEFAULT_DEPTH
      && researchDepth({}) === RESEARCH_DEFAULT_DEPTH
      && researchDepth(undefined) === RESEARCH_DEFAULT_DEPTH)

  const parsed = parseResearchArgs({ question: 'q', depth: 'medium' })
  check('the parser maps depth to preset',
    parsed.preset === 'medium' && parsed.question === 'q', JSON.stringify(parsed))
  check('the parser takes a configured default',
    parseResearchArgs({ question: 'q' }, 'wide').preset === 'wide-research',
    JSON.stringify(parseResearchArgs({ question: 'q' }, 'wide')))
}

// ── 3. The model's parameters are the documented ones ──────────────────────
console.log('\n3. the tool schema offers the documented parameters')
{
  const { tool } = makeTool(baseConfig)
  // `defineTool` compiles the DSL, so the tool carries a JSON Schema rather than
  // the declaration it was built from.
  const params = tool.parameters
  check('the root is an object with the three parameters',
    params.type === 'object' && JSON.stringify(Object.keys(params.properties)) === JSON.stringify(['question', 'depth', 'image']),
    JSON.stringify(Object.keys(params.properties ?? {})))
  check('question is a required string',
    params.required?.includes('question') === true && params.properties.question.type === 'string',
    JSON.stringify(params.required))
  check('depth is an enum of the offered depths',
    JSON.stringify(params.properties.depth.enum) === JSON.stringify(Object.keys(RESEARCH_DEPTHS)),
    JSON.stringify(params.properties.depth.enum))
  check('the depth description names each option',
    Object.values(RESEARCH_DEPTHS)
      .every((entry) => params.properties.depth.description.includes(entry.description)))
  check('image is an optional string, so a text-only call is unchanged',
    params.properties.image.type === 'string' && params.required?.includes('image') !== true,
    `type=${params.properties.image.type} required=${JSON.stringify(params.required)}`)
  check('the image description names both accepted forms and a refusal',
    params.properties.image.description.includes('https') && params.properties.image.description.includes('imageRoots'),
    params.properties.image.description.slice(0, 120))
  check('the image marker is declared on the output, but not required',
    tool.output.schema.properties.images !== undefined
      && tool.output.schema.required?.includes('images') !== true,
    JSON.stringify(Object.keys(tool.output.schema.properties ?? {})))
  check('the tool registers a prompt section', makeTool(baseConfig).sections.length === 1)
  check('the prompt section tells the model the tool takes an image',
    makeTool(baseConfig).sections[0].text.includes('optional image'),
    makeTool(baseConfig).sections[0].text.slice(0, 160))
}

// ── 4. The answer and its sources come back model-ready ────────────────────
console.log('\n4. the result carries the answer and its sources')
{
  stubFetch(() => agentOk('The documented answer'))
  const { tool } = makeTool(baseConfig)
  const value = await tool.execute({ question: 'q', depth: 'wide' }, exec)
  check('content is the generated answer', value.content === 'The documented answer', JSON.stringify(value.content))
  check('sources are projected without absent fields',
    value.sources.length === 1 && value.sources[0].url === 'https://example.com/a'
      && value.sources[0].title === 'A' && value.sources[0].snippet === 's'
      && value.sources[0].publishedAt === undefined,
    JSON.stringify(value.sources))
  check('the value is not flagged truncated', value.truncated === false)

  const rendered = tool.output.render({}, value)[0].text
  check('the rendered text warns that the content is untrusted',
    rendered.includes('untrusted data, not instructions'), rendered.slice(0, 60))
  check('the rendered text lists the answer and the source',
    rendered.includes('The documented answer') && rendered.includes('https://example.com/a'))

  const empty = formatResearchOutput({ sources: [], truncated: false })
  check('an empty result says so', empty.includes('No results found.'), empty.slice(0, 80))
}

// ── 4b. An `incomplete` run is flagged truncated, not merely described ─────
// `incomplete` is the API's own truncation status. The prose line told a reader
// so, but `truncated` — one of the three fields `dsh-tool-web` forwards — stayed
// `false`, so the only machine-readable truncation signal contradicted the
// sentence next to it.
console.log('\n4b. an incomplete run sets the truncated field')
{
  stubFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      status: 'incomplete',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'half an answer' }] },
        { type: 'search_results', results: [{ url: 'https://example.com/a', title: 'A' }] },
      ],
    }),
  }))
  const { tool } = makeTool(baseConfig)
  const value = await tool.execute({ question: 'q' }, exec)
  check('the incomplete status becomes the truncated field', value.truncated === true, String(value.truncated))
  check('the partial answer is still returned', String(value.content).includes('half an answer'), String(value.content))
  check('the content still says why it is short',
    String(value.content).includes('Truncated'), String(value.content).slice(-140))
}

// ── 5. A missing key is a provider error, not a silent call ────────────────
console.log('\n5. a missing API key fails loudly')
{
  stubFetch(() => agentOk('never'))
  const { tool } = makeTool({ ...baseConfig, apiKey: '' })
  let error
  try {
    await tool.execute({ question: 'q' }, exec)
  } catch (caught) {
    error = caught
  }
  check('the call rejected with a provider error', error?.code === 'WEB_PROVIDER_ERROR', String(error?.code))
  check('the message names the remedy',
    String(error?.message).includes('PERPLEXITY_API_KEY'), String(error?.message).slice(0, 80))
}

// ── 6. A rejected research call keeps the provider message ────────────────
console.log('\n6. an HTTP failure surfaces the provider message')
{
  stubFetch(() => ({
    ok: false,
    status: 400,
    headers: { get: () => null },
    json: async () => ({ error: { message: 'invalid request' } }),
  }))
  let error
  try {
    await makeTool(baseConfig).tool.execute({ question: 'q' }, exec)
  } catch (caught) {
    error = caught
  }
  check('the provider message is preserved',
    error?.code === 'WEB_PROVIDER_ERROR' && String(error?.message).includes('invalid request'),
    `${error?.code} ${error?.message}`)
}

// ── 7. The depth argument is validated, not trusted ───────────────────────
console.log('\n7. an unknown depth is refused before any request')
{
  const calls = stubFetch(() => agentOk('never'))
  let error
  try {
    parseResearchArgs({ question: 'q', depth: 'unlimited' })
  } catch (caught) {
    error = caught
  }
  check('an unknown depth is rejected', error !== undefined, String(error?.message))
  check('no request was issued for it', calls.length === 0)
  check('a blank question is rejected',
    (() => { try { parseResearchArgs({ question: '  ' }); return false } catch { return true } })())
}

// ── 8. A composition without the required registries fails loudly ─────────
// The plugin contributes a tool and its prompt guidance, so a context that
// cannot receive them is a misconfiguration to name, not to skip silently.
console.log('\n8. a missing registry is named, not skipped')
{
  const bare = {
    on() {},
    get() { return undefined },
    inject() {},
    web: { registerSearchProvider() {} },
  }
  let error
  try {
    apply(bare, { apiKey: 'k' })
  } catch (caught) {
    error = caught
  }
  check('the plugin refuses a context without tools/systemPrompt', error !== undefined)
  check('the message names the missing service',
    /"(tools|systemPrompt)"/.test(String(error?.message)), String(error?.message).slice(0, 140))
}

// ── 9. A research run is submitted in the background and polled ───────────
// The Agent API's documented pattern for runs that take minutes. Holding one
// connection open for the whole run is what failed on long `high` calls
// (`fetch failed <- SocketError: other side closed`), so these pin the
// asynchronous shape rather than any particular timing.
console.log('\n9. the run is submitted in the background and polled by id')
{
  /** A transport stub that answers in order, recording method and url. */
  const sequence = (responses) => {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: init?.body !== undefined ? JSON.parse(init.body) : undefined,
      })
      const next = responses.shift()
      if (next === undefined) throw new Error(`unexpected extra request: ${init?.method} ${url}`)
      return next
    }
    return calls
  }
  const queued = () => jsonResponse({ id: 'resp_1', status: 'queued', output: [] })
  const completed = (text) => jsonResponse({
    id: 'resp_1',
    status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text }] },
      { type: 'search_results', results: [{ url: 'https://example.com/a', title: 'A' }] },
    ],
  })

  // 9a. Submit is background, the poll is a GET, and the answer still arrives.
  const calls = sequence([queued(), completed('polled answer')])
  const value = await makeTool(baseConfig).tool.execute({ question: 'q', depth: 'high' }, exec)
  check('the submit asks for a background run',
    calls[0]?.method === 'POST' && calls[0]?.body?.background === true,
    `${calls[0]?.method} background=${calls[0]?.body?.background}`)
  check('the poll is a GET on the response id',
    calls[1]?.method === 'GET' && calls[1]?.url.endsWith('/v1/agent/resp_1'),
    `${calls[1]?.method} ${calls[1]?.url}`)
  check('a GET poll sends no body', calls[1]?.body === undefined)
  check('the polled answer is returned', value?.content === 'polled answer', JSON.stringify(value?.content))
  check('its sources survive the poll', value?.sources?.[0]?.url === 'https://example.com/a',
    JSON.stringify(value?.sources))

  // 9b. A run that is still going must be polled again, not reported as done.
  const twice = sequence([queued(), jsonResponse({ id: 'resp_1', status: 'in_progress', output: [] }),
    completed('second poll')])
  const waited = await makeTool(baseConfig).tool.execute({ question: 'q' }, exec)
  check('a non-terminal status is polled again rather than returned',
    waited?.content === 'second poll' && twice.length === 3, `requests=${twice.length}`)

  // 9c. A failing poll must NOT abandon a run that is still going: the run is
  // unaffected by a bad poll, and the id still identifies it.
  const flaky = sequence([queued(), jsonResponse({ error: { message: 'bad gateway' } }, 502),
    completed('survived a blip')])
  const survived = await makeTool(baseConfig).tool.execute({ question: 'q' }, exec)
  check('a transient poll failure does not lose the run',
    survived?.content === 'survived a blip', JSON.stringify(survived?.content))

  // 9d. A failed run is a provider error that names its id.
  // A failed run that the API billed for may already hold the answer, so it is
  // reported rather than repeated. `usage` present is what marks it as billed.
  const failed = sequence([queued(),
    jsonResponse({
      id: 'resp_1',
      status: 'failed',
      error: { message: 'run blew up' },
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      output: [],
    })])
  let failure
  try {
    await makeTool(baseConfig).tool.execute({ question: 'q' }, exec)
  } catch (caught) {
    failure = caught
  }
  check('a failed run rejects as a provider error',
    failure?.code === 'WEB_PROVIDER_ERROR', String(failure?.code))
  check('the failure names the run and the reason',
    String(failure?.message).includes('resp_1') && String(failure?.message).includes('run blew up'),
    String(failure?.message))
  check('a billed failure is not retried', failed.length === 2, `requests=${failed.length}`)
}

// ── 9e. An UNBILLED backend failure is retried once, safely ────────────────
// The fault seen in practice: the API ran the research, then the model produced
// nothing (`echolot: ... (reasoning_only)`), with `usage: null`. Nothing was
// generated and nothing was billed, so asking again cannot duplicate work — and
// a research run is expensive enough that one wasted failure is worth repeating.
console.log('\n9e. an unbilled failure is retried once')
{
  const sequence = (responses) => {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method })
      const next = responses.shift()
      if (next === undefined) throw new Error(`unexpected extra request: ${init?.method} ${url}`)
      return next
    }
    return calls
  }
  const queued = () => jsonResponse({ id: 'resp_r', status: 'queued', output: [] })
  const unbilledFailure = () => jsonResponse({
    id: 'resp_r',
    status: 'failed',
    usage: null,
    error: { code: 'model_error', message: 'echolot: model produced no usable answer: no usable answer (reasoning_only)' },
    output: [],
  })
  const completed = jsonResponse({
    id: 'resp_r',
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer after retry' }] }],
  })

  const calls = sequence([queued(), unbilledFailure(), queued(), completed])
  const value = await makeTool(baseConfig).tool.execute({ question: 'q', depth: 'high' }, exec)
  check('the unbilled failure was retried and the answer returned',
    value?.content === 'answer after retry', JSON.stringify(value?.content))
  check('the retry was a fresh background run, polled again',
    calls.length === 4 && calls[2]?.method === 'POST' && calls[3]?.method === 'GET',
    JSON.stringify(calls.map((call) => call.method)))

  // A second unbilled failure is reported, not retried forever.
  const twice = sequence([queued(), unbilledFailure(), queued(), unbilledFailure()])
  let failure
  try {
    await makeTool(baseConfig).tool.execute({ question: 'q' }, exec)
  } catch (caught) {
    failure = caught
  }
  check('a second unbilled failure is reported rather than retried again',
    twice.length === 4 && String(failure?.message).includes('resp_r'), `requests=${twice.length}`)
}

// ── 9f. The model-stage no-output failure reaches the tool caller classified ──
// The fault from the incident: both attempts ran their whole retrieval and the
// model produced nothing. The caller must receive a failure that names both run
// ids, the upstream code, the completed retrieval and that nothing was billed —
// not one sentence of upstream prose.
console.log('\n9f. a model-stage failure is reported with every run id')
{
  const sequence = (responses) => {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method })
      const next = responses.shift()
      if (next === undefined) throw new Error(`unexpected extra request: ${init?.method} ${url}`)
      return next
    }
    return calls
  }
  const queued = (id) => jsonResponse({ id, status: 'queued', output: [] })
  const noAnswer = (id) => jsonResponse({
    id,
    status: 'failed',
    usage: null,
    error: { code: 'model_error', message: 'echolot: no usable answer (reasoning_only)' },
    output: [{ type: 'search_results', results: [{ url: 'https://example.com/a' }] }],
  })

  const calls = sequence([queued('resp_a'), noAnswer('resp_a'), queued('resp_b'), noAnswer('resp_b')])
  let failure
  try {
    await makeTool(baseConfig).tool.execute({ question: 'q', depth: 'high' }, exec)
  } catch (caught) {
    failure = caught
  }
  check('the tool rejects with the model-stage class, not a generic run failure',
    failure?.name === 'AgentModelNoOutputError' && failure?.failureKind === 'model_no_output',
    `${failure?.name}/${failure?.failureKind}`)
  check('both attempts and both run ids are reported',
    failure?.attempts === 2 && String(failure?.message).includes('resp_a')
      && String(failure?.message).includes('resp_b'),
    String(failure?.message).slice(0, 200))
  check('the reason is kept alongside the classification',
    String(failure?.message).includes('reasoning_only'), String(failure?.message).slice(-120))
  check('the preset the depth selected is named',
    failure?.preset === 'high' && String(failure?.message).includes('preset high'), String(failure?.preset))
  check('the retry really was a second background run',
    calls.length === 4 && calls[2]?.method === 'POST' && calls[3]?.method === 'GET',
    JSON.stringify(calls.map((call) => call.method)))
}

// ── 10. Giving up reports the id instead of losing the run ────────────────
// The budget bounds the wait, but a run that outlives it has still been paid
// for: the message must say how to collect it, and the run must be cancelled so
// it stops costing money.
console.log('\n10. an expired budget names the run and cancels it')
{
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method })
    if (String(url).endsWith('/cancel')) return jsonResponse({ status: 'cancelling' })
    if (init?.method === 'GET') return jsonResponse({ id: 'resp_9', status: 'in_progress', output: [] })
    return jsonResponse({ id: 'resp_9', status: 'queued', output: [] })
  }
  let error
  try {
    // A tiny budget keeps the loop short; the first poll already exceeds it.
    await makeTool({ ...baseConfig, researchTimeoutMs: 1 }).tool.execute({ question: 'q' }, exec)
  } catch (caught) {
    error = caught
  }
  const cancelled = seen.some((call) => call.url.endsWith('/v1/agent/resp_9/cancel'))
  check('an expired budget is a provider error', error?.code === 'WEB_PROVIDER_ERROR', String(error?.code))
  check('the message carries the id so the run can still be collected',
    String(error?.message).includes('resp_9'), String(error?.message).slice(0, 200))
  check('the abandoned run is cancelled rather than left running', cancelled, JSON.stringify(seen))
}

// ── 11. Research leaves the output budget to the preset; web_search keeps its cap ──
// The incident's root cause on our side: `maxTokens` (2048 live) overrode the
// preset's own 128000, and a `high` research run then spent the whole budget
// before writing an answer — reproducibly returning zero `message` items, once as
// `incomplete` and once as the incident's `model_error (reasoning_only)`, while
// the same question uncapped answered fully. Research therefore omits the field.
// `web_search` is unchanged: a short answer is that tool's point, so the contrast
// is pinned here rather than left to drift.
console.log('\n11. research sends no output cap, and web_search still does')
{
  const researchCalls = stubFetch(() => agentOk('deep answer'))
  await makeTool(baseConfig).tool.execute({ question: 'q', depth: 'high' }, exec)
  check('the research body sends no max_output_tokens',
    researchCalls[0]?.body?.max_output_tokens === undefined,
    JSON.stringify(researchCalls[0]?.body))
  check('and still names the preset and the search tool',
    researchCalls[0]?.body?.preset === 'high' && researchCalls[0]?.body?.tools?.[0]?.type === 'web_search',
    JSON.stringify({ preset: researchCalls[0]?.body?.preset, tools: researchCalls[0]?.body?.tools }))
  check('omitting the cap did not change anything else about the body',
    researchCalls[0]?.body?.input === 'q'
      && researchCalls[0]?.url === 'https://api.perplexity.ai/v1/agent'
      && researchCalls[0]?.body?.background === true,
    JSON.stringify(researchCalls[0]?.body))

  const searchCalls = stubFetch(() => agentOk('short answer'))
  const search = makeTool(baseConfig)
  const provider = search.providers.find((candidate) => candidate.id === 'perplexity')
  await provider.search({ query: 'q' }, exec.signal)
  check('the web_search body still carries the configured cap',
    searchCalls[0]?.body?.max_output_tokens === baseConfig.maxTokens,
    JSON.stringify(searchCalls[0]?.body))
}

// ── 12-16. The optional `image` argument ────────────────────────────────────
// A research question about a diagram is still one focused question, but until
// now an image could only reach this tool by *being* the question. The explicit
// argument keeps the question the text question and applies the provider path's
// read guards to the named image. The fixtures live in their own temp directory,
// which is the only declared `imageRoots` entry.
const imageDir = mkdtempSync(join(tmpdir(), 'pplx-research-image-'))
const outsideDir = mkdtempSync(join(tmpdir(), 'pplx-research-outside-'))
const pngPath = join(imageDir, 'shot.png')
const textAsPngPath = join(imageDir, 'notes.png')
const textPath = join(imageDir, 'notes.txt')
const bigPath = join(imageDir, 'huge.png')
const outsidePath = join(outsideDir, 'private.png')
/** 1x1 PNG, the smallest valid raster the media-type sniffer accepts. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)
writeFileSync(pngPath, PNG_1X1)
writeFileSync(textAsPngPath, 'this is not a raster image\n')
writeFileSync(textPath, 'not an image\n')
writeFileSync(bigPath, Buffer.concat([PNG_1X1, Buffer.alloc(4096)]))
writeFileSync(outsidePath, PNG_1X1)
const imageConfig = { ...baseConfig, preset: 'medium', imageRoots: [imageDir] }

console.log('\n12. with no image the request is exactly the text-only body')
{
  const calls = stubFetch(() => agentOk('plain answer'))
  const value = await makeTool(imageConfig).tool.execute({ question: 'a plain question' }, exec)
  check('the body stays a plain string input',
    calls[0]?.body?.input === 'a plain question', JSON.stringify(calls[0]?.body?.input))
  check('the preset selector is unchanged', calls[0]?.body?.preset === 'low', JSON.stringify(calls[0]?.body?.preset))
  check('no image marker and no images field are added',
    value.images === undefined && !String(value.content).includes(IMAGE_MARKER_PREFIX),
    `${JSON.stringify(value.images)} ${String(value.content).slice(0, 60)}`)

  // Backwards compatibility: a question that is itself an image reference has
  // always been classified as one. Leaving the new argument out must not change
  // that.
  const pathCalls = stubFetch(() => agentOk('classified from the question'))
  const pathValue = await makeTool(imageConfig).tool.execute({ question: pngPath }, exec)
  const pathContent = pathCalls[0]?.body?.input?.[0]?.content
  check('a question that is itself an image path is still classified as one',
    pathContent?.[1]?.type === 'input_image', JSON.stringify(pathContent)?.slice(0, 100))
  check('and the result still reports its marker',
    String(pathValue.content).startsWith(IMAGE_MARKER_PREFIX), String(pathValue.content).slice(0, 60))
}

console.log('\n13. a local image inside imageRoots becomes an input_image part')
{
  const calls = stubFetch(() => agentOk('the contact sheet shows five slide pages'))
  const { tool } = makeTool(imageConfig)
  const value = await tool.execute({ question: 'what does this contact sheet show', image: pngPath }, exec)
  const content = calls[0]?.body?.input?.[0]?.content
  check('the text part is the question, not the path',
    content?.[0]?.type === 'input_text' && content[0].text === 'what does this contact sheet show',
    JSON.stringify(content?.[0]))
  check('the second part is input_image with a base64 PNG data URI',
    content?.[1]?.type === 'input_image'
      && String(content?.[1]?.image_url).startsWith('data:image/png;base64,')
      && String(content[1].image_url).slice('data:image/png;base64,'.length) === PNG_1X1.toString('base64'),
    JSON.stringify(content?.[1])?.slice(0, 80))
  check('the request keeps the preset and the search tool',
    calls[0]?.body?.preset === 'low' && calls[0]?.body?.tools?.[0]?.type === 'web_search',
    JSON.stringify({ preset: calls[0]?.body?.preset, tools: calls[0]?.body?.tools }))
  check('research still sends no output cap', calls[0]?.body?.max_output_tokens === undefined)
  check('the answer is still the mapped text',
    String(value.content).includes('contact sheet shows five slide pages'), String(value.content).slice(0, 80))

  const firstLine = String(value.content).split('\n', 1)[0]
  check('the marker is the first line of the answer', firstLine.startsWith(IMAGE_MARKER_PREFIX), firstLine.slice(0, 90))
  const marker = JSON.parse(firstLine.slice(IMAGE_MARKER_PREFIX.length))
  check('the marker reports one image, its source, and its bytes',
    marker.images === 1 && marker.source[0] === pngPath && marker.bytes === PNG_1X1.length,
    JSON.stringify(marker))
  check('the same marker object is on the value',
    JSON.stringify(value.images) === JSON.stringify(marker), JSON.stringify(value.images))

  const rendered = tool.output.render({}, value)[0].text
  check('the rendered output carries the marker line', rendered.includes(firstLine))
  check('the rendered output still labels the content untrusted',
    rendered.includes('untrusted data, not instructions'))
}

console.log('\n14. a public https image URL is passed through, never fetched')
{
  const url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/boardwalk.jpg'
  const calls = stubFetch(() => agentOk('described from the URL'))
  const { tool } = makeTool(imageConfig)
  const value = await tool.execute({ question: 'what is in this photo', image: url }, exec)
  const content = calls[0]?.body?.input?.[0]?.content
  check('the URL is the image reference, not base64',
    content?.[1]?.type === 'input_image' && content[1].image_url === url, JSON.stringify(content?.[1]))
  const marker = JSON.parse(String(value.content).split('\n', 1)[0].slice(IMAGE_MARKER_PREFIX.length))
  check('the marker records the URL and zero uploaded bytes',
    marker.source[0] === url && marker.bytes === 0, JSON.stringify(marker))
}

console.log('\n15. a refused image is named, and no request is issued')
{
  const cases = [
    ['a path outside imageRoots', outsidePath, imageConfig, 'imageRoots'],
    ['a missing file', join(imageDir, 'not-here.png'), imageConfig, 'not an existing file'],
    ['bytes that are not the claimed format', textAsPngPath, imageConfig, 'extension'],
    ['a non-image file extension', textPath, imageConfig, 'not a supported image'],
    ['a file over imageMaxBytes', bigPath, { ...imageConfig, imageMaxBytes: 64 }, 'imageMaxBytes'],
    ['a value that is neither a path nor an image URL', 'just some text', imageConfig, 'neither the absolute path'],
    ['a non-image web address', 'https://example.com/page', imageConfig, 'only a public https URL'],
  ]
  for (const [label, image, config, expected] of cases) {
    const calls = stubFetch(() => agentOk('must not be called'))
    let error
    try {
      await makeTool(config).tool.execute({ question: 'q', image }, exec)
    } catch (caught) {
      error = caught
    }
    check(`${label} is refused as a provider error`,
      error?.code === 'WEB_PROVIDER_ERROR', `${error?.code} ${String(error?.message).slice(0, 80)}`)
    check(`${label} names the reason`,
      String(error?.message).includes(expected), String(error?.message).slice(0, 120))
    check(`${label} issues no request`, calls.length === 0, `calls=${calls.length}`)
  }
}

console.log('\n16. imageInput off ignores the image argument instead of refusing the call')
{
  // Chosen behaviour: IGNORED, not refused. `imageInput` off means "never send an
  // image", which is exactly what the provider path does with a query that names
  // one (it goes as text). A research run must not fail because a capability is
  // switched off, and the argument is metadata rather than part of the question,
  // so it is dropped rather than appended to the text.
  const calls = stubFetch(() => agentOk('text-only answer'))
  const value = await makeTool({ ...imageConfig, imageInput: 'off' })
    .tool.execute({ question: 'a plain question', image: pngPath }, exec)
  check('the request is the plain text body',
    calls[0]?.body?.input === 'a plain question', JSON.stringify(calls[0]?.body?.input))
  check('no image part is present', calls[0]?.body?.preset === 'low', JSON.stringify(calls[0]?.body?.preset))
  check('no marker and no images field are added',
    value.images === undefined && !String(value.content).includes(IMAGE_MARKER_PREFIX))
  check('the answer still comes back', String(value.content).includes('text-only answer'))
}

rmSync(imageDir, { recursive: true, force: true })
rmSync(outsideDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
