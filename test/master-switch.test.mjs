/**
 * Deterministic tests for the `enabled` master switch.
 *
 * The switch exists so a user can hand `web_search` back to the composition's
 * own provider without uninstalling the plugin. The load-bearing detail is that
 * it must release the *configured provider id*, not merely report the provider
 * unusable: the seam answers a configured-but-unavailable provider by throwing
 * (`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`), never by falling back to whatever
 * else is registered. These tests pin that release/restore round trip, the
 * availability gate on both Perplexity backends, and the research tool's
 * refusal while the switch is off.
 *
 * `globalThis.fetch` is never reached: every call below either fails before the
 * transport or is expected to throw.
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
const { apply, Config, liveConfig, SETTINGS_NAMESPACE } = await import(MODULE)
if (typeof apply !== 'function') {
  console.error('This copy does not export the host surface; sync the working tree first.')
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
 * Register the plugin against a minimal fake context.
 *
 * DSH 0.2 hands a plugin its configuration as the Loader resolved it: `apply`
 * receives a section of live references for the `volatile()` fields, and a
 * committed settings edit **restarts** the plugin rather than patching the
 * section in place. The harness therefore models a change as a second `load`:
 * the previous registration is dropped and `apply` runs again, exactly as
 * `Fiber.update()` does. That is what makes the release/restore round trip
 * below a real regression test — an id released by one `apply` has to be
 * restorable by the next one.
 *
 * @param options.config - raw config of the row that mounts the plugin.
 * @param options.searchProviderId - what the seam already has configured, i.e.
 *   what the profile patch named. Stands in for a deployment that points
 *   `ctx.web` at some other provider entirely.
 */
function makeHarness({ config = {}, searchProviderId = 'perplexity' } = {}) {
  const providers = []
  const tools = []
  let raw = { ...config }
  let section
  const web = {
    searchProviderId,
    registerSearchProvider(provider) { providers.push(provider) },
  }
  const toolsService = { register(tool) { tools.push(tool); return () => {} } }
  const systemPrompt = { section() {}, getSectionOrder: () => 100 }
  const ctx = {
    web,
    tools: toolsService,
    systemPrompt,
    get(name) {
      if (name === 'web') return web
      if (name === 'tools') return toolsService
      if (name === 'systemPrompt') return systemPrompt
      return undefined
    },
    inject(_names, callback) { callback(ctx) },
    effect(fn) { return typeof fn === 'function' ? fn() : undefined },
  }
  /** One plugin load with `raw` as the row config; the Loader resolves it first. */
  const load = () => {
    section = Config(raw)
    providers.length = 0
    tools.length = 0
    apply(ctx, section)
  }
  load()
  return {
    web,
    providers,
    /** The section as it currently stands, unwrapped from its references. */
    resolved: () => liveConfig(section),
    /** Simulate one committed settings change, which restarts the plugin. */
    commit(patch) {
      raw = { ...raw, ...patch }
      load()
    },
    // Getters rather than captured values: a restart replaces both registrations.
    get agent() { return providers.find((provider) => provider.id === 'perplexity') },
    get searchApi() { return providers.find((provider) => provider.id === 'perplexity-search') },
    get research() { return tools.find((tool) => tool.name === 'perplexity_research') },
  }
}

/** The error message from one rejected research call. */
async function refusal(harness, args = { question: '' }) {
  try {
    await harness.research.execute(args, { signal: undefined })
    return ''
  } catch (error) {
    return error?.message ?? String(error)
  }
}

// ── 1. Default on: the seam is left exactly as the composition set it ─────────
console.log('\n1. enabled by default, and the seam is untouched')
{
  const harness = makeHarness({ config: { apiKey: 'test-key' } })
  check('the schema default is on', harness.resolved().enabled === true, String(harness.resolved().enabled))
  check('the seam keeps the configured id while on', harness.web.searchProviderId === 'perplexity',
    String(harness.web.searchProviderId))
  check('both backends are registered', harness.agent !== undefined && harness.searchApi !== undefined)
  check('the Agent backend is usable while on', harness.agent.available() === true)
  check('the Search API backend stays idle while the Agent API is selected',
    harness.searchApi.available() === false)
}

// ── 2. Off releases the configured id, because the seam cannot fall back ──────
console.log('\n2. disabling releases the configured provider id')
{
  const harness = makeHarness({ config: { apiKey: 'test-key' } })
  harness.commit({ enabled: false })
  check('the configured id is released, not left pointing at an unusable provider',
    harness.web.searchProviderId === undefined, String(harness.web.searchProviderId))
  check('the Agent backend reports itself unusable', harness.agent.available() === false)
  check('the Search API backend reports itself unusable', harness.searchApi.available() === false)

  harness.commit({ enabled: true })
  check('re-enabling restores the id it released', harness.web.searchProviderId === 'perplexity',
    String(harness.web.searchProviderId))
  check('the Agent backend is usable again', harness.agent.available() === true)
}

// ── 3. The released id is remembered, not assumed ────────────────────────────
console.log('\n3. re-enabling restores whatever id was released')
{
  const harness = makeHarness({ config: { apiKey: 'test-key' }, searchProviderId: 'deepseek-official' })
  check('a foreign configured id is left alone while on',
    harness.web.searchProviderId === 'deepseek-official', String(harness.web.searchProviderId))
  harness.commit({ enabled: false })
  check('disabling releases the foreign id too', harness.web.searchProviderId === undefined)
  harness.commit({ enabled: true })
  check('re-enabling restores the foreign id rather than assuming `perplexity`',
    harness.web.searchProviderId === 'deepseek-official', String(harness.web.searchProviderId))
}

// ── 4. A row config that ships the switch off is honoured at load ─────────────
console.log('\n4. a deployment can ship the switch off')
{
  const harness = makeHarness({ config: { apiKey: 'test-key', enabled: false } })
  check('the installed section reads as off', harness.resolved().enabled === false)
  check('the seam was released during apply', harness.web.searchProviderId === undefined)
  check('no backend claims to be usable', harness.agent.available() === false && harness.searchApi.available() === false)
}

// ── 5. The switch gates the Search API backend on the same terms ──────────────
console.log('\n5. the Search API backend is gated by the switch')
{
  const harness = makeHarness({ config: { apiKey: 'test-key', searchProvider: 'perplexity-search' } })
  check('the selected Search API backend is usable', harness.searchApi.available() === true)
  check('the Agent backend yields to it', harness.agent.available() === false)
  harness.commit({ enabled: false })
  check('disabling makes the selected backend unusable', harness.searchApi.available() === false)
  check('and releases the seam', harness.web.searchProviderId === undefined)
}

// ── 6. The research tool refuses while disabled, and only while disabled ──────
console.log('\n6. perplexity_research refuses while the switch is off')
{
  const harness = makeHarness({ config: { apiKey: 'test-key' } })
  check('the tool is registered', harness.research !== undefined)

  harness.commit({ enabled: false })
  const disabledMessage = await refusal(harness)
  check('a disabled plugin refuses the call instead of billing Perplexity',
    disabledMessage.includes('is disabled'), disabledMessage)

  harness.commit({ enabled: true })
  // An empty question fails argument parsing before any transport, so this
  // proves the guard lifted without a network call.
  const enabledMessage = await refusal(harness)
  check('re-enabling lifts the refusal', !enabledMessage.includes('is disabled'), enabledMessage)
  check('the call then fails for its own reason, not the switch',
    enabledMessage.includes('question'), enabledMessage)
}

// ── 7. The DSH 0.2 configuration contract ────────────────────────────────────
// The port's load-bearing assumptions, pinned so a later edit cannot quietly
// undo them: the module must export `Config` (DSH derives the entry's settings
// page from the loaded module's `Config`), every field the plugin reads must be
// `volatile()` (that is what resolves it into the live reference `liveConfig`
// unwraps), and `apiKey` must NOT be — DSH's generated form renders exactly the
// volatile fields, and a form write is persisted into the profile's
// `cordis.patch.yml`, which is the one place this plugin promises never to put
// the key. Section 4 is what fails if that split is ever flattened.
console.log('\n7. the DSH 0.2 configuration contract')
{
  check('the module exports the schema DSH derives the settings page from',
    Config !== undefined && typeof Config === 'function', typeof Config)
  check('the export is a schemastery object schema',
    Config?.type === 'object' && Config?.dict !== undefined, String(Config?.type))

  const entries = Object.entries(Config.dict ?? {})
  const volatileFields = entries.filter(([, field]) => field.meta?.volatile === true).map(([name]) => name)
  const plainFields = entries.filter(([, field]) => field.meta?.volatile !== true).map(([name]) => name)
  check('apiKey is the only field DSH\'s generated form must not render',
    plainFields.length === 1 && plainFields[0] === 'apiKey', JSON.stringify(plainFields))
  check('every other field is volatile, so the Loader hands apply a live reference',
    volatileFields.length === entries.length - 1, JSON.stringify(plainFields))
  check('the key field is still marked secret', Config.dict.apiKey.meta?.role === 'secret',
    String(Config.dict.apiKey.meta?.role))

  const section = Config({ baseURL: 'https://example.test', enabled: false })
  check('a resolved field is a live reference, not a value',
    typeof section.baseURL?.get === 'function')
  const plain = liveConfig(section)
  check('liveConfig unwraps the section into ordinary values',
    plain.baseURL === 'https://example.test' && plain.enabled === false
      && Number.isInteger(plain.maxTokens) && plain.maxTokens > 0,
    JSON.stringify({ baseURL: plain.baseURL, enabled: plain.enabled, maxTokens: plain.maxTokens }))
  check('liveConfig passes the non-volatile literal key through',
    liveConfig(Config({ apiKey: 'literal' })).apiKey === 'literal')
  check('the configuration namespace is the row id this package ships',
    SETTINGS_NAMESPACE === 'web-search-perplexity', String(SETTINGS_NAMESPACE))
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
