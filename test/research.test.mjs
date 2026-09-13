/**
 * Deterministic tests for the `perplexity_research` tool.
 *
 * The point of this tool is its own timeout budget: `web_search` is bounded by
 * `tool-web.searchTimeoutMs` (60 s under the shipped presets, per-session
 * composition, out of a plugin's reach), while the Agent API's `wide-research`
 * preset runs for minutes. These tests pin that budget, the preset each depth
 * selects, and the request the tool actually sends.
 *
 * `globalThis.fetch` is stubbed, so nothing here touches the network.
 *
 * Run: npm test
 */

import { existsSync } from 'node:fs'
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
  RESEARCH_DEFAULT_DEPTH,
  RESEARCH_DEPTHS,
  RESEARCH_TOOL_NAME,
  formatResearchOutput,
  parseResearchArgs,
  researchTimeoutMs,
} = plugin
if (typeof apply !== 'function' || typeof RESEARCH_TOOL_NAME !== 'string') {
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
  const ctx = {
    on() {},
    get(name) {
      if (name === 'tools') return { register(tool) { registered.push(tool); return () => {} } }
      if (name === 'credentials') return { resolve: async (ref) => ({ value: process.env[ref] }) }
      return undefined
    },
    inject() {},
    web: { registerSearchProvider() {} },
    tools: { register(tool) { registered.push(tool); return () => {} } },
    systemPrompt: { section(section) { sections.push(section) }, getSectionOrder: () => 100 },
  }
  apply(ctx, config)
  const tool = registered.find((candidate) => candidate.name === RESEARCH_TOOL_NAME)
  if (tool === undefined) throw new Error(`${RESEARCH_TOOL_NAME} was not registered`)
  return { tool, sections }
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

/** Minimal execution context: the tool only reads `signal`. */
const exec = { signal: new AbortController().signal }

const baseConfig = { apiKey: 'test-key', baseURL: 'https://api.perplexity.ai', maxTokens: 500 }

// ── 1. The tool carries its own budget, independent of tool-web ─────────────
console.log('\n1. the tool declares its own timeout budget')
{
  const { tool } = makeTool(baseConfig)
  check('a default budget is declared',
    tool.timeoutMs === DEFAULT_RESEARCH_TIMEOUT_MS && DEFAULT_RESEARCH_TIMEOUT_MS === 600_000,
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
  check('an omitted depth defaults to the medium preset',
    defaultCalls[0]?.body?.preset === RESEARCH_DEPTHS[RESEARCH_DEFAULT_DEPTH].preset
      && defaultCalls[0]?.body?.preset === 'medium',
    JSON.stringify(defaultCalls[0]?.body?.preset))

  const parsed = parseResearchArgs({ question: 'q', depth: 'medium' })
  check('the parser maps depth to preset',
    parsed.preset === 'medium' && parsed.question === 'q', JSON.stringify(parsed))
}

// ── 3. The model's parameters are the documented ones ──────────────────────
console.log('\n3. the tool schema offers the documented parameters')
{
  const { tool } = makeTool(baseConfig)
  // `defineTool` compiles the DSL, so the tool carries a JSON Schema rather than
  // the declaration it was built from.
  const params = tool.parameters
  check('the root is an object with the two parameters',
    params.type === 'object' && JSON.stringify(Object.keys(params.properties)) === JSON.stringify(['question', 'depth']),
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
  check('the tool registers a prompt section', makeTool(baseConfig).sections.length === 1)
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

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
