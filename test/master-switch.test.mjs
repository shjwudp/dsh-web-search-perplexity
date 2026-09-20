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
const { apply } = await import(MODULE)
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
 * `installSection` is the one seam this test needs faithfully: it must resolve
 * the schema against the row config (which is how the `enabled` default reaches
 * `resolveOptions`) and call `onChange` on install and on every committed
 * change, because that callback is what re-applies the seam selection.
 *
 * @param options.config - the row config the settings section is based on.
 * @param options.searchProviderId - what the seam already has configured, i.e.
 *   what the profile patch named. Stands in for a deployment that points
 *   `ctx.web` at some other provider entirely.
 */
function makeHarness({ config = {}, searchProviderId = 'perplexity' } = {}) {
  const providers = []
  const tools = []
  let resolved
  let hooks
  const settings = {
    installSection(_owner, _ns, schema, entry, passed) {
      hooks = passed
      resolved = schema(entry ?? {})
      passed.setSource(() => resolved)
      passed.onChange()
    },
  }
  const web = {
    searchProviderId,
    registerSearchProvider(provider) { providers.push(provider) },
  }
  const toolsService = { register(tool) { tools.push(tool); return () => {} } }
  const systemPrompt = { section() {}, getSectionOrder: () => 100 }
  const ctx = {
    web,
    settings,
    tools: toolsService,
    systemPrompt,
    get(name) {
      if (name === 'web') return web
      if (name === 'tools') return toolsService
      if (name === 'systemPrompt') return systemPrompt
      if (name === 'settings') return settings
      return undefined
    },
    inject(_names, callback) { callback(ctx) },
    effect(fn) { return typeof fn === 'function' ? fn() : undefined },
  }
  apply(ctx, config)
  return {
    web,
    providers,
    agent: providers.find((provider) => provider.id === 'perplexity'),
    searchApi: providers.find((provider) => provider.id === 'perplexity-search'),
    research: tools.find((tool) => tool.name === 'perplexity_research'),
    resolved: () => resolved,
    /** Simulate one committed settings change, as the settings service would. */
    commit(patch) {
      resolved = { ...resolved, ...patch }
      hooks.onChange()
    },
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

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
