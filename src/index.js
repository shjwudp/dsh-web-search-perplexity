/**
 * Standalone Perplexity search provider for the DeepSeek Harness web seam.
 *
 * Registers a `WebSearchProvider` with id `perplexity` into `ctx.web`.
 * It calls Perplexity's Agent API (`POST /v1/agent`) and maps the generated
 * answer plus its `search_results[]` into the seam's normalized
 * `WebSearchResult`. No other endpoint is supported: Perplexity's Sonar Chat
 * Completions API is deprecated (supported only until 2026-09-27), and the
 * Agent API is its replacement.
 *
 * Configuration is exposed through the durable `web-search-perplexity`
 * settings namespace, so the web UI's Plugins settings can edit baseURL,
 * model, maxTokens, searchRecency, the soft deadline and its fallback preset,
 * the image settings, and the API key (the key is stored through the
 * credentials domain, never in the settings file).
 *
 * This plugin does NOT depend on `@deepseek-ai/dsh-environment` (which is not
 * published on the npm registry). As a fallback it still reads the
 * `PERPLEXITY_API_KEY` process environment variable.
 *
 * Agent-mode searches run under an optional soft deadline (`softTimeoutMs`).
 * When it expires, the provider makes exactly one bounded degraded retry on a
 * faster preset and labels that answer, so a slow deep-research query degrades
 * instead of surfacing the harness's opaque `tool call timed out` result. The
 * retry stays synchronous inside the caller's budget: no background request, no
 * pending-task table, and no promise outliving the tool call.
 *
 * Because a preset-independent deadline turns that boundary case into the
 * default path (a flat 25s sat below `medium`'s own measured 25.3s narrow
 * latency, so every `medium` narrow query degraded), an unset `softTimeoutMs`
 * is derived per preset via {@link defaultSoftTimeoutMsFor}.
 *
 * A degraded answer is marked twice: `degradation` on the seam result, and a
 * `DEGRADED_MARKER_PREFIX` line carrying the same JSON inside `content` — which
 * is the only field `dsh-tool-web` forwards to the model. A consumer can
 * therefore tell a full-depth result from a shallow retry without reading prose.
 *
 * Image input: `dsh-tool-web` hands this provider nothing but `request.query`
 * (`WebSearchRequest` declares only `query` and `maxResults`), so an image can
 * only arrive as text. A query naming a local image file or a public image URL
 * is therefore sent as that image plus its text question, using Perplexity's
 * multimodal content parts. A local file is read only when its media type is
 * allowed, it sits inside a configured `imageRoots` entry, it is within
 * `imageMaxBytes`, and its bytes really are that format — otherwise the request
 * fails loudly instead of shipping an arbitrary document to Perplexity. An
 * image-bearing request is marked with an `IMAGE_MARKER_PREFIX` line inside
 * `content`, carrying the same JSON as `images` on the seam result.
 */

import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  DEFAULT_IMAGE_MAX_BYTES,
  buildImageRequest,
  imageRequestBody,
  resolveImageAttachment,
  withImageMarker,
} from './image.js'
import { PERPLEXITY_RESEARCH_SKILL } from './skill.js'
import { PerplexitySearchApiProvider, SEARCH_API_PROVIDER_ID } from './search-api.js'
import { DEFAULT_RESEARCH_TIMEOUT_MS, applyResearchTool, researchTimeoutMs } from './research.js'
import { AGENT_POLL_INTERVAL_SHORT_MS, AgentDeadlineError, runAgentRequest } from './agent-run.js'
import { canParseURL, isAbortError, isImageInputEnabled, requestJson as postJson, resolveApiKey } from './shared.js'

export const name = 'web-search-perplexity'
// All three are required rather than probed: the plugin contributes the
// `perplexity_research` tool, whose model-facing guidance is a prompt section.
// A composition without either registry could not honour that contribution, so
// the plugin says so instead of failing later on an undefined service.
// `web` is the seam both search providers register into.
export const inject = ['web', 'tools', 'systemPrompt']

// The image-input decision lives in `./shared.js` so the browser half can carry
// the same rule; re-exported here so this package's single entry point exposes
// it and a test can assert the request path and the exposed boolean agree.
export { IMAGE_INPUT_DISABLED_VALUES, isImageInputEnabled } from './shared.js'

// The image plumbing itself lives in `./image.js`, shared with the research
// tool so the two cannot drift about what a refusal is or what an image request
// looks like. The marker stays re-exported here because callers and tests import
// it from this package's entry point.
export { IMAGE_MARKER_PREFIX } from './image.js'

export {
  DEFAULT_RESEARCH_TIMEOUT_MS,
  RESEARCH_DEFAULT_DEPTH,
  RESEARCH_DEPTHS,
  RESEARCH_TOOL_NAME,
  formatResearchOutput,
  parseResearchArgs,
  presentResearchCall,
  researchDepth,
  researchTimeoutMs,
} from './research.js'

// The Search API backend lives in its own module; re-export its surface so this
// package has one entry point, and so both backends can be imported together.
export {
  SEARCH_API_MARKER_PREFIX,
  SEARCH_API_MAX_DOMAINS,
  SEARCH_API_MAX_LANGUAGES,
  SEARCH_API_MAX_RESULTS_PEOPLE,
  SEARCH_API_MAX_RESULTS_WEB,
  SEARCH_API_PATH,
  SEARCH_API_PROVIDER_ID,
  SEARCH_API_RECENCY_VALUES,
  SEARCH_API_TYPES,
  SEARCH_CONTEXT_SIZES,
  PerplexitySearchApiProvider,
  mapSearchApiResponse,
  maxResultsFor,
  resolveSearchApiOptions,
  searchApiRequestBody,
} from './search-api.js'

/**
 * This plugin's configuration namespace.
 *
 * DSH 0.2 replaced per-plugin settings sections with Loader-entry configuration:
 * a plugin's namespace *is* the id of the entry that mounts it, and this package
 * ships that row as `id: web-search-perplexity` in its bundled
 * `cordis.patch.yml`. The browser half (which cannot import this module) repeats
 * the same string as the id its card registers under, and
 * `test/package-metadata.test.mjs` pins the three together so they cannot drift.
 */
export const SETTINGS_NAMESPACE = 'web-search-perplexity'
const DEFAULT_BASE_URL = 'https://api.perplexity.ai'
const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_API_KEY_ENV = 'PERPLEXITY_API_KEY'
const AGENT_PRESETS = ['fast', 'low', 'medium', 'high', 'xhigh', 'wide-research']
const AGENT_DEFAULT_MODEL = 'openai/gpt-5.6-luna'
/**
 * `web_search`'s budget under the shipped DSH agent presets: the `tool-web` row
 * of `@deepseek-ai/dsh-agent-presets` sets `searchTimeoutMs: 60000`
 * (`dsh-tool-web` alone defaults to 30000, see below). This is a hard ceiling —
 * past it the harness cancels the call and the caller gets the opaque
 * `tool call timed out after <ms>ms` that this provider exists to replace — so
 * every soft deadline here is derived to stay strictly inside it.
 */
export const TOOL_BUDGET_MS = 60_000
/** `dsh-tool-web`'s own default budget, for presets that can fit inside it. */
export const COMPONENT_TOOL_BUDGET_MS = 30_000
/** Hard cap for the single degraded retry, so the retry cannot overrun the budget. */
export const FALLBACK_TIMEOUT_MS = 15_000
/** Headroom kept between the worst case (`soft + fallback`) and the tool budget. */
export const SOFT_DEADLINE_MARGIN_MS = 5_000
/**
 * Headroom kept between the worst case (`soft + fallback`) and the 30s component
 * budget, for the fast presets that must also fit under it.
 */
export const FAST_DEADLINE_MARGIN_MS = 3_000
/**
 * Ceiling for a soft deadline. Derived, not chosen: a deadline above this would
 * leave the degraded retry no room inside the 60s preset budget, so the retry
 * could not run at all and the caller would get an opaque timeout instead.
 */
export const MAX_SOFT_TIMEOUT_MS = TOOL_BUDGET_MS - FALLBACK_TIMEOUT_MS - SOFT_DEADLINE_MARGIN_MS
/** Deadline for the presets fast enough to also fit the 30s component budget. */
export const FAST_PRESET_SOFT_TIMEOUT_MS = COMPONENT_TOOL_BUDGET_MS - FALLBACK_TIMEOUT_MS - FAST_DEADLINE_MARGIN_MS
/**
 * Extra deadline an image-bearing search gets over a text one. An image search
 * does strictly more work than the text search the same preset bounds: the image
 * is uploaded and then read by a separate vision pass before the search runs.
 * Keeping the text deadline would therefore degrade image searches that are
 * behaving normally, while a preset-independent absolute value would be wrong for
 * the same reason one flat `softTimeoutMs` was wrong for every preset. It is an
 * internal margin rather than a setting, so no configuration can pair a text
 * deadline with an image deadline that contradicts it.
 */
export const IMAGE_ANALYSIS_MARGIN_MS = 12_000

/**
 * Soft deadline per Agent preset, derived from that preset's measured latency
 * (`fast` ≈ 4s, `low` ≈ 5s, `medium` ≈ 25s narrow / >180s broad — 25.3s
 * measured for the narrow case — `high` and `xhigh` slower still,
 * `wide-research` minutes).
 *
 * It must be derived per preset, because one preset-independent constant cannot
 * be right for all of them. The previous flat 25s default sat *below* the
 * `medium` preset's own measured 25.3s narrow latency, so every `medium` narrow
 * query spent the full 25s and was then answered by a `fast` retry: the degraded
 * path stopped being a boundary case and became the default outcome — strictly
 * worse than either lowering the preset or raising the deadline.
 *
 * Two budget tiers, because the harness budget differs by deployment:
 *
 * - `fast` and `low` answer in ~4-5s, so 12s already leaves >2x headroom while
 *   still satisfying `soft + fallback + margin <= 30s`, the `dsh-tool-web`
 *   component default. They are safe under either budget.
 * - `medium` and slower cannot fit a 30s budget at all (a narrow `medium` query
 *   alone takes ~25s and leaves nothing for a retry), so they take
 *   `MAX_SOFT_TIMEOUT_MS`, which requires the 60s budget the shipped agent
 *   presets declare. `medium` then returns at full depth instead of degrading.
 *
 * Under a 30s budget, `medium` is unusable whatever this deadline is: lower the
 * preset to `low`, or raise `tool-web.searchTimeoutMs` in the agent preset.
 */
export const PRESET_SOFT_TIMEOUT_MS = Object.freeze({
  fast: FAST_PRESET_SOFT_TIMEOUT_MS,
  low: FAST_PRESET_SOFT_TIMEOUT_MS,
  medium: MAX_SOFT_TIMEOUT_MS,
  high: MAX_SOFT_TIMEOUT_MS,
  xhigh: MAX_SOFT_TIMEOUT_MS,
  'wide-research': MAX_SOFT_TIMEOUT_MS,
})
/** Deadline for an Agent-mode request that names no preset. */
const DEFAULT_SOFT_TIMEOUT_MS = MAX_SOFT_TIMEOUT_MS
const DEFAULT_FALLBACK_PRESET = 'fast'

/**
 * The soft deadline one Agent preset gets when `softTimeoutMs` is not
 * configured. The effective value is echoed in every result's
 * `degradation.softTimeoutMs`, so no consumer has to guess which deadline was
 * actually in force.
 *
 * @param preset - a configured Agent preset, or `''` when none is set.
 * @returns the preset's soft deadline in milliseconds.
 */
export function defaultSoftTimeoutMsFor(preset) {
  return PRESET_SOFT_TIMEOUT_MS[preset] ?? DEFAULT_SOFT_TIMEOUT_MS
}

/**
 * Prefix of the machine-readable degradation line prepended to `content`; the
 * rest of that line is one JSON object.
 *
 * `content` is the only field that survives `dsh-tool-web`'s closed `web_search`
 * output schema (`content` / `sources` / `truncated` with
 * `additionalProperties: false`), so the structured `degradation` object on the
 * seam result cannot reach the model through that tool. This line carries the
 * same status across that boundary for one `JSON.parse`, with no prose reading.
 */
export const DEGRADED_MARKER_PREFIX = '[DEGRADED] '

/**
 * Recency windows accepted by the Agent API's `web_search` tool filter
 * (`tools[].filters.search_recency_filter`).
 */
const SEARCH_RECENCY_VALUES = ['day', 'week', 'month', 'year']

/**
 * The plugin's configuration schema, and the one place its shape is declared.
 *
 * Exported because DSH 0.2 derives a plugin's settings page from the `Config`
 * export of its loaded module: the Loader validates (and defaults) this entry's
 * config with it, and `ctx.settings.describe()` projects it into the form the
 * web UI renders. A local `const` would leave the entry unvalidated and with no
 * page at all.
 *
 * Every field is `volatile()` except {@link Config}'s `apiKey`. Volatility is
 * what makes a field editable *live*: the Loader resolves a volatile field into
 * a reference whose `get()` answers with the value currently in force, so a
 * saved edit reaches the plugin without remounting it. It also means
 * {@link liveConfig} must unwrap the section before anything reads it — a
 * volatile field is a reference object, not the value.
 *
 * `apiKey` is deliberately the one non-volatile field. DSH's generated form
 * renders exactly the volatile fields, and a form write is persisted into the
 * profile's `cordis.patch.yml`; leaving the literal key out of that form is what
 * keeps the plugin's promise that the key lives in the credentials domain and
 * never in a patch file. A hand-written `apiKey` in the patch is still honoured
 * on the next start — it simply has no UI control.
 *
 * This plugin's own card (`src/client.js`) is the custom page for the section;
 * `enabled` below is its master switch.
 */
export const Config = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  // Master switch owned by this plugin's settings card. While false the plugin
  // releases the `ctx.web` seam selection so the composition's own provider
  // (the shipped `deepseek-official`) serves search again, and both Perplexity
  // backends report themselves unavailable. The seam id is released when the
  // plugin loads with this false, so flipping it in the UI applies to the next
  // search rather than the next DSH start.
  enabled: z.boolean().default(true).volatile(),
  preset: z.string().default('').volatile(),
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  model: z.string().default(AGENT_DEFAULT_MODEL).volatile(),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).volatile(),
  searchRecency: z.string().default('').volatile(),
  // No schema default: an unset deadline follows the configured preset, so the
  // default cannot drift out of step with the preset it is paired with.
  softTimeoutMs: z.number().step(1).min(0).volatile(),
  fallbackPreset: z.string().default(DEFAULT_FALLBACK_PRESET).volatile(),
  // Blank enables image input; only the literal "off"/"false"/"0" disables it,
  // so a cleared field cannot silently change what the provider sends. This
  // governs only a query that is ITSELF an image path or URL; the research
  // tool's explicit `image` argument does not consult it. The rule itself is
  // `isImageInputEnabled` in `./shared.js` — the one place that decides, called
  // by the request path and by what the settings UI exposes.
  imageInput: z.string().default('').volatile(),
  imageMaxBytes: z.number().step(1).min(1).default(DEFAULT_IMAGE_MAX_BYTES).volatile(),
  imageRoots: z.array(z.string()).default([]).volatile(),
  // Which of this plugin's two backends serves searches. Blank keeps the Agent
  // API; only the Search API's id switches. Both are never registered as usable
  // at once, because two usable providers make the seam's selection ambiguous.
  searchProvider: z.string().default('').volatile(),
  searchType: z.string().default('web').volatile(),
  searchDomains: z.array(z.string()).default([]).volatile(),
  searchLanguages: z.array(z.string()).default([]).volatile(),
  searchCountry: z.string().default('').volatile(),
  searchContextSize: z.string().default('medium').volatile(),
  searchMaxTokensPerPage: z.number().step(1).min(1).volatile(),
  searchAfterDate: z.string().default('').volatile(),
  searchBeforeDate: z.string().default('').volatile(),
  // The `perplexity_research` tool's own budget, independent of `tool-web`'s.
  // This is the tool's reason to exist, not a second deadline for search: a
  // quick search is bounded by `softTimeoutMs`, a research call by this.
  researchTimeoutMs: z.number().step(1).min(0).default(DEFAULT_RESEARCH_TIMEOUT_MS).volatile(),
  // Default `depth` for a research call that names none. Blank keeps the built-in
  // default (`low`); an unknown value is ignored rather than breaking the tool, so
  // a typo cannot make research unavailable. Read per call, not at registration.
  researchDepth: z.string().default('').volatile(),
})

/**
 * One plain snapshot of a resolved `Config` section.
 *
 * Every field above is `volatile()`, so the section the Loader hands `apply` is
 * a record of live references rather than of values. Unwrapping here keeps that
 * detail in one place: everything downstream — {@link resolveOptions}, the
 * provider's `available()`, the research tool — keeps reading ordinary values,
 * as it did when the section arrived from `settings.installSection`.
 *
 * A section from a host that did not resolve the schema (an older DSH, or a
 * plugin mounted outside the Loader) already holds plain values, so a field
 * without `get()` is passed through unchanged.
 *
 * @param config - the section `apply` received, possibly undefined.
 * @returns its current values, unwrapped.
 */
export function liveConfig(config) {
  const plain = {}
  for (const [field, value] of Object.entries(config ?? {})) {
    // A volatile field is a frozen reference object with `get()`; a plain value
    // (an unwrapped section, or the non-volatile `apiKey`) is passed through.
    const reference = typeof value === 'object' && value !== null ? value : undefined
    const get = reference === undefined ? undefined : Reflect.get(reference, 'get')
    plain[field] = typeof get === 'function' ? get.call(reference) : value
  }
  return plain
}

/**
 * The seam provider id this plugin released, per `ctx.web` instance.
 *
 * `enabled: false` has to clear the seam's configured id rather than only
 * report the provider unavailable: the seam answers a configured-but-unusable
 * provider by throwing, never by falling back to another one. The id the
 * composition named is remembered so re-enabling restores exactly it rather
 * than assuming which provider the deployment pinned.
 *
 * It lives beside the seam rather than in `apply`'s closure because a live
 * config edit restarts the plugin: a fresh closure would have forgotten the id
 * and could never give it back.
 */
const releasedSeamProviders = new WeakMap()

/**
 * Apply the master switch to the seam's provider selection.
 *
 * @param web - the `ctx.web` service, used as the memory's key.
 * @param enabled - the value of the `enabled` setting currently in force.
 */
function applySeamSelection(web, enabled) {
  if (enabled) {
    const released = releasedSeamProviders.get(web)
    if (released === undefined) return
    web.searchProviderId = released
    releasedSeamProviders.delete(web)
    return
  }
  if (web.searchProviderId !== undefined) releasedSeamProviders.set(web, web.searchProviderId)
  web.searchProviderId = undefined
}

/** Map one structured Perplexity search result into a normalized source. */
function mapPerplexityResult(result) {
  return {
    url: result.url,
    ...(typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {}),
    ...(typeof result.snippet === 'string' && result.snippet.length > 0 ? { snippet: result.snippet } : {}),
    ...(typeof result.date === 'string' && result.date.length > 0 ? { publishedAt: result.date } : {}),
  }
}

/**
 * Map an Agent API response into a normalized search result.
 */
function mapAgentResponse(data) {
  const texts = []
  const sources = []
  const seen = new Set()
  const pushSource = (source) => {
    if (typeof source.url !== 'string' || source.url.length === 0 || seen.has(source.url)) return
    seen.add(source.url)
    sources.push({
      url: source.url,
      ...(typeof source.title === 'string' && source.title.length > 0 ? { title: source.title } : {}),
      ...(typeof source.snippet === 'string' && source.snippet.length > 0 ? { snippet: source.snippet } : {}),
      ...(typeof source.date === 'string' && source.date.length > 0 ? { publishedAt: source.date } : {}),
    })
  }
  for (const item of data.output ?? []) {
    if (item.type === 'message') {
      for (const block of item.content ?? []) {
        if (block.type === 'output_text' && typeof block.text === 'string' && block.text.length > 0) {
          texts.push(block.text)
        }
      }
    } else if (item.type === 'search_results') {
      for (const result of item.results ?? []) pushSource(result)
    } else if (item.type === 'fetch_url_results') {
      for (const content of item.contents ?? []) pushSource(content)
    }
  }
  // `incomplete` is the API's own truncation status, so it becomes both a line
  // the model can read and the machine-readable field. The field is the part that
  // matters: it is one of the three fields `dsh-tool-web` forwards, and a result
  // that prints "Truncated" while reporting `truncated: false` contradicts itself
  // exactly when a reader needs it to be right.
  const truncated = data.status === 'incomplete'
  const joined = texts.join('\n\n')
  const content = joined.length > 0
    ? joined + (truncated
      // Deliberately does not name `maxTokens` as the remedy: `perplexity_research`
      // leaves the output budget to the preset, so that advice would be wrong there.
      ? '\n\n(Truncated: the response ended before it finished — its output budget was exhausted.)'
      : '')
    : ''
  return {
    ...(content.length > 0 ? { content } : {}),
    sources,
    truncated,
  }
}

/**
 * The Agent API `web_search` tool entry: its type plus every configured filter.
 * `searchRecency` is the same `day`/`week`/`month`/`year` window the Sonar API
 * used to take as a top-level `search_recency_filter`; on the Agent API it
 * belongs to the tool that performs the search.
 *
 * @param {object} options - resolved provider options.
 * @returns {object} the tool entry for the request's `tools` array.
 */
function webSearchTool(options) {
  return {
    type: 'web_search',
    ...(options.searchRecency !== undefined
      ? { filters: { search_recency_filter: options.searchRecency } }
      : {}),
  }
}

/**
 * Project the current settings section into the options the provider serves
 * its next search with. `ctx` supplies the credentials domain, which is where
 * the UI-stored API key lives.
 */
function resolveOptions(ctx, config) {
  const c = config ?? {}
  const apiKeyEnv = typeof c.apiKeyEnv === 'string' && c.apiKeyEnv.length > 0
    ? c.apiKeyEnv
    : DEFAULT_API_KEY_ENV
  const literalApiKey = typeof c.apiKey === 'string' && c.apiKey.length > 0
    ? c.apiKey
    : undefined
  // The Search API is a second, independent backend in this same plugin, so
  // which one is usable is decided here rather than by registering both (two
  // usable providers would make the seam's selection ambiguous). It is opt-in:
  // an unset or unknown value leaves the Agent API in place.
  const searchApi = typeof c.searchProvider === 'string' && c.searchProvider.trim() === SEARCH_API_PROVIDER_ID
  const rawModel = typeof c.model === 'string' && c.model.length > 0 ? c.model : AGENT_DEFAULT_MODEL
  // Agent API model ids are `provider/model` slugs. A configured id without one
  // is not an Agent API model, so it falls back rather than being sent to fail.
  const model = rawModel.includes('/') ? rawModel : AGENT_DEFAULT_MODEL
  // With a preset, `model` is only sent as an explicit override when one was
  // configured. The built-in default is a fallback for the preset-less request,
  // not an override of a preset.
  const configuredModel = typeof c.model === 'string' && c.model.includes('/') ? c.model : undefined
  const preset = AGENT_PRESETS.includes(c.preset) ? c.preset : ''
  // An explicit `softTimeoutMs` always wins — including 0, which disables the
  // deadline. Otherwise the deadline follows the configured preset's measured
  // latency instead of a preset-independent constant.
  const softTimeoutMs = Number.isInteger(c.softTimeoutMs) && c.softTimeoutMs >= 0
    ? c.softTimeoutMs
    : defaultSoftTimeoutMsFor(preset)
  // Image input is on unless it was explicitly switched off. The rule lives in
  // one place (`isImageInputEnabled`), so what the settings projection exposes
  // cannot disagree with what the request path does.
  const imageInput = isImageInputEnabled(c.imageInput)
  // An image request gets the text deadline plus the analysis margin, capped
  // where the degraded retry still fits the tool budget, and `0` stays `0` so
  // disabling the deadline disables it for images too. This is deliberately not
  // a separate setting: two deadlines side by side invite a configuration where
  // the image one is wrong for the text one.
  const imageDeadlineMs = softTimeoutMs === 0
    ? 0
    : Math.min(softTimeoutMs + IMAGE_ANALYSIS_MARGIN_MS, MAX_SOFT_TIMEOUT_MS)
  return {
    enabled: c.enabled !== false,
    apiKey: literalApiKey,
    apiKeyEnv,
    searchApi,
    agentModelOverride: configuredModel,
    preset,
    baseURL: typeof c.baseURL === 'string' && c.baseURL.length > 0 ? c.baseURL : DEFAULT_BASE_URL,
    model,
    maxTokens: Number.isInteger(c.maxTokens) && c.maxTokens > 0 ? c.maxTokens : DEFAULT_MAX_TOKENS,
    // Sent as the web_search tool's `filters.search_recency_filter`.
    searchRecency: SEARCH_RECENCY_VALUES.includes(c.searchRecency) ? c.searchRecency : undefined,
    // 0 disables the soft deadline, restoring the single-request behavior.
    softTimeoutMs,
    imageInput,
    imageMaxBytes: Number.isInteger(c.imageMaxBytes) && c.imageMaxBytes > 0
      ? c.imageMaxBytes
      : DEFAULT_IMAGE_MAX_BYTES,
    imageRoots: Array.isArray(c.imageRoots)
      ? c.imageRoots.filter((root) => typeof root === 'string' && root.length > 0).map((root) => resolve(root))
      : [],
    imageDeadlineMs,
    // Only a fast synchronous preset is a useful degraded retry: `wide-research`
    // is a minutes-long background workflow by design, not a latency fallback.
    fallbackPreset: AGENT_PRESETS.includes(c.fallbackPreset) && c.fallbackPreset !== 'wide-research'
      ? c.fallbackPreset
      : DEFAULT_FALLBACK_PRESET,
  }
}

/**
 * Build the Agent API request body for one preset.
 *
 * `applyMaxTokens` exists for one measured reason: a preset brings its own output
 * budget (128000 for `medium`/`high`), and overriding it with the shared
 * `maxTokens` (2048 live) starves a multi-step research run. Measured against the
 * live API on 2026-09-16, on the very questions whose runs failed: with the cap, a
 * `high` run ended with **zero** answer messages — reproduced as both
 * `incomplete` (documented as truncation) and
 * `failed` + `model_error … (reasoning_only)`, the exact incident signature —
 * while the same questions uncapped answered fully (8 343–11 054 output tokens,
 * 2 096–2 718 of them reasoning). So research omits the field and lets the preset
 * size its own budget. See `docs/model-stage-no-output.md` §3.1.
 *
 * @param request - the search request, for its query.
 * @param options - resolved provider options.
 * @param preset - the Agent preset to send, or `''` for the model-only shape.
 * @param settings - `applyMaxTokens: false` leaves the output budget to the preset.
 * @returns the Agent API request body.
 */
function agentRequestBody(request, options, preset, { applyMaxTokens = true } = {}) {
  const body = {
    input: request.query,
    tools: [webSearchTool(options)],
    ...(applyMaxTokens && Number.isInteger(options.maxTokens) && options.maxTokens > 0
      ? { max_output_tokens: options.maxTokens }
      : {}),
  }
  if (preset !== '') {
    body.preset = preset
    // With a preset, `model` is optional and only sent as an explicit override
    // when the user actually configured a `provider/model` slug. The built-in
    // default model is a fallback for the preset-less case, not an override, so
    // it must not be sent alongside a preset.
    if (options.agentModelOverride !== undefined) body.model = options.agentModelOverride
  } else {
    body.model = options.model
  }
  return body
}

/**
 * Complete an image-bearing Agent API body with the search tool and token cap.
 *
 * The model selector is the same one a text request uses: the configured preset
 * when there is one, otherwise the configured model. An image request therefore
 * cannot disagree with a text request about which model answers.
 *
 * @param body - the image message array.
 * @param options - resolved provider options.
 * @param preset - the preset the caller would otherwise send.
 * @param settings - `applyMaxTokens: false` leaves the output budget to the preset.
 * @returns the complete Agent API request body.
 */
function agentImageRequestBody(body, options, preset, { applyMaxTokens = true } = {}) {
  return {
    ...body,
    tools: [webSearchTool(options)],
    ...(preset !== '' ? { preset } : { model: options.model }),
    ...(applyMaxTokens && Number.isInteger(options.maxTokens) && options.maxTokens > 0
      ? { max_output_tokens: options.maxTokens }
      : {}),
  }
}

/**
 * Machine-readable degradation status for one result.
 *
 * The degraded retry used to be visible only as the prose sentence prepended to
 * `content`, so a reader in a hurry — a subagent, a later session — could miss
 * that line and cite a shallow answer as full-depth research. Every result now
 * carries this object instead: whether the answer degraded, which preset was
 * asked for, which preset actually answered, and the soft deadline in force.
 *
 * Caveat: `dsh-tool-web` re-projects the seam result into its own closed
 * `web_search` output schema, so this object reaches direct `ctx.web.search`
 * consumers but not the model-facing tool result. `DEGRADED_MARKER_PREFIX` plus
 * one JSON object inside `content` is what carries the same status across that
 * boundary.
 *
 * @param requestedPreset - the preset the caller asked for.
 * @param actualPreset - the preset that produced this answer.
 * @param softTimeoutMs - the soft deadline that was in force (0 when disabled).
 * @returns the status object shared by the seam result and the content marker.
 */
function degradationStatus(requestedPreset, actualPreset, softTimeoutMs) {
  const degraded = actualPreset !== requestedPreset
  return {
    degraded,
    requestedPreset,
    actualPreset,
    softTimeoutMs,
    fallbackTimeoutMs: degraded ? FALLBACK_TIMEOUT_MS : 0,
  }
}

/**
 * Label a fallback answer as degraded, so neither the model nor the user can
 * mistake a shallow retry for the full-depth result that was requested. The
 * machine-readable marker comes first so it survives a truncated read.
 */
function degradedAgentResult(data, options) {
  const mapped = mapAgentResponse(data)
  const status = degradationStatus(options.preset, options.fallbackPreset, options.softTimeoutMs)
  const note = `${DEGRADED_MARKER_PREFIX}${JSON.stringify(status)}\n`
    + `(Degraded result: the "${options.preset}" agent search passed its `
    + `${Math.round(options.softTimeoutMs / 1000)}s soft deadline, so this answer was retried with the `
    + `"${options.fallbackPreset}" preset and is shallower than requested. Narrow the query, or raise `
    + 'web-search-perplexity.softTimeoutMs together with the web_search tool budget.)'
  return {
    ...mapped,
    degradation: status,
    content: mapped.content !== undefined ? `${note}\n\n${mapped.content}` : note,
  }
}

/**
 * POST one Perplexity Agent API request. Transport, redirect rejection, retry,
 * and abort classification live in {@link postJson}, shared with the Search API
 * provider.
 *
 * @param url - absolute endpoint URL.
 * @param apiKey - bearer credential.
 * @param body - request body.
 * @param signal - optional cancellation signal.
 * @param retries - how many times a 429 may be retried.
 * @returns the parsed response body.
 */
function requestJson(url, apiKey, body, signal, retries = 2) {
  return postJson(url, apiKey, body, signal, WebError, 'Perplexity search', retries)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - row config from cordis.yml / patch layers.
 */
export function apply(ctx, config = {}) {
  // The Loader resolves volatile fields into references, so the section itself
  // is not a record of values; this reads the section as it stands at each call
  // rather than caching a snapshot. The Loader also restarts the plugin when the
  // config changes, so `current` never observes a value the composition has
  // already replaced.
  const current = () => liveConfig(config)

  // The registrations below are the plugin's whole contribution, so a service
  // that cannot receive one is a misconfiguration to name, not to skip.
  for (const service of ['web', 'tools', 'systemPrompt']) {
    if (ctx.get(service) === undefined && ctx[service] === undefined) {
      throw new Error(
        `web-search-perplexity needs the "${service}" service: it registers two search `
        + 'providers and the perplexity_research tool. Mount it in a composition that '
        + 'loads @deepseek-ai/dsh-web and @deepseek-ai/dsh-tools.',
      )
    }
  }

  // The master switch, applied once for the section now in force. DSH derives
  // this entry's settings page from the exported `Config` schema and restarts
  // the plugin on every committed edit, so this call *is* the change handler
  // the old `installSection` hook used to provide — there is nothing to
  // subscribe to, and no card to install.
  applySeamSelection(ctx.web, resolveOptions(ctx, current()).enabled)

  // Contribute an embedded research skill when the skill registry is mounted.
  // This is defensive: without the `dsh-skill` service the provider still works.
  const skills = ctx.get('skills')
  if (skills !== undefined && typeof skills.register === 'function') {
    skills.register(PERPLEXITY_RESEARCH_SKILL)
  }

  // The long-research tool carries its own budget, which is what lets it outlive
  // `tool-web`'s per-session budget that a plugin cannot raise.
  applyResearchTool(ctx, current, {
    agentRequestBody,
    agentImageRequestBody,
    buildImageRequest,
    // The explicit `image` argument of the research tool: the strict read guards
    // and the content-part assembly are shared with the provider path rather
    // than reimplemented in the tool.
    imageRequestBody,
    resolveImageAttachment,
    withImageMarker,
    mapAgentResponse,
    resolveApiKey,
    resolveOptions,
  })

  // Both backends are registered, but only one reports itself usable at a time:
  // each `available()` consults `searchProvider`, so switching in the settings UI
  // takes effect on the next search instead of requiring a restart. Registration
  // alone cannot decide this, because the seam resolves the provider per call.
  ctx.web.registerSearchProvider(new PerplexitySearchApiProvider(
    ctx,
    current,
    () => {
      const options = resolveOptions(ctx, current())
      // The master switch gates the Search API backend on the same terms as the
      // Agent one, so a disabled plugin never reports either backend usable.
      return options.enabled && options.searchApi
    },
  ))

  ctx.web.registerSearchProvider({
    id: 'perplexity',
    available() {
      const options = resolveOptions(ctx, current())
      // Disabled: report unusable so auto-selection (the seam id having been
      // released above) can settle on the composition's own provider.
      if (!options.enabled) return false
      // Only the Agent backend is usable when it is the configured one: two
      // usable providers would make the seam's selection ambiguous.
      if (options.searchApi) return false
      const hasCredentialsService = ctx.get('credentials') !== undefined
      const hasAmbientKey = typeof process.env[options.apiKeyEnv] === 'string'
        && process.env[options.apiKeyEnv].length > 0
      return ((typeof options.apiKey === 'string' && options.apiKey.length > 0)
          || hasCredentialsService
          || hasAmbientKey)
        && canParseURL(options.baseURL)
        && Number.isInteger(options.maxTokens)
        && options.maxTokens > 0
    },
    async search(request, signal) {
      const options = resolveOptions(ctx, current())
      const apiKey = await resolveApiKey(ctx, options.apiKey, options.apiKeyEnv)
      if (apiKey === undefined || apiKey.length === 0) {
        throw new WebError(
          'Perplexity API key is not configured. Set PERPLEXITY_API_KEY, '
          + 'or open Settings → Built-in plugins → Perplexity web search '
          + 'and save an API key there.',
          'WEB_PROVIDER_ERROR',
        )
      }

      // A query naming an image (local file or public https URL) becomes the
      // request's image content; every other query stays the text question.
      const imageRequest = await buildImageRequest([request.query], options)
      const preset = options.preset
      const agentBody = (chosenPreset) => (imageRequest !== undefined
        ? agentImageRequestBody(imageRequest.body, options, chosenPreset)
        : agentRequestBody(request, options, chosenPreset))

      // No soft deadline configured: one background run with no wait limit
      // beyond the caller's own cancellation.
      if (!(options.softTimeoutMs > 0)) {
        const data = await runAgentRequest(
          agentBody(options.preset), options, apiKey, signal, 0, AGENT_POLL_INTERVAL_SHORT_MS)
        const mapped = imageRequest !== undefined
          ? withImageMarker(mapAgentResponse(data), imageRequest.marker)
          : mapAgentResponse(data)
        return {
          ...mapped,
          ...(imageRequest !== undefined ? { images: imageRequest.marker } : {}),
          degradation: degradationStatus(options.preset, options.preset, 0),
        }
      }

      const deadlineMs = imageRequest !== undefined ? options.imageDeadlineMs : options.softTimeoutMs
      // A search runs through the same background submit and poll as the
      // research tool, with a deadline the plugin enforces instead of a fetch
      // it aborts. That is what makes giving up clean rather than lossy: on
      // expiry the remote run is cancelled and named, where aborting a fetch
      // left it running and discarded the answer.
      let primaryData
      let softTimedOut = false
      try {
        primaryData = await runAgentRequest(
          agentBody(preset), options, apiKey, signal, deadlineMs, AGENT_POLL_INTERVAL_SHORT_MS)
      } catch (error) {
        // Only OUR deadline may degrade the answer. An outer cancellation is
        // the harness tool budget: no time is left for a retry. Any other
        // error is a real provider failure, not a latency problem.
        if (!(error instanceof AgentDeadlineError) || (signal !== undefined && signal.aborted)) throw error
        softTimedOut = true
      }
      if (!softTimedOut) {
        const mapped = imageRequest !== undefined
          ? withImageMarker(mapAgentResponse(primaryData), imageRequest.marker)
          : mapAgentResponse(primaryData)
        return {
          ...mapped,
          ...(imageRequest !== undefined ? { images: imageRequest.marker } : {}),
          degradation: degradationStatus(preset, preset, deadlineMs),
        }
      }

      // The degraded retry: a shallow answer inside the budget beats the opaque
      // `tool call timed out` result the caller would otherwise receive. It gets
      // its own deadline, so the whole search still fits the tool budget.
      try {
        const data = await runAgentRequest(
          agentBody(options.fallbackPreset), options, apiKey, signal, FALLBACK_TIMEOUT_MS, AGENT_POLL_INTERVAL_SHORT_MS)
        const mapped = degradedAgentResult(data, { ...options, preset })
        return imageRequest !== undefined
          ? { ...withImageMarker(mapped, imageRequest.marker), images: imageRequest.marker }
          : mapped
      } catch (error) {
        if (error instanceof AgentDeadlineError && !(signal !== undefined && signal.aborted)) {
          throw new WebError(
            `Perplexity agent search passed its ${Math.round(deadlineMs / 1000)}s soft deadline, and the `
            + `"${options.fallbackPreset}" fallback did not finish within `
            + `${Math.round(FALLBACK_TIMEOUT_MS / 1000)}s. Retry with a narrower, single-fact query, or set `
            + `web-search-perplexity.preset to "${options.fallbackPreset}" — raise `
            + 'softTimeoutMs together with the web_search tool budget if full-depth '
            + 'research is required.',
            'WEB_PROVIDER_ERROR', { cause: error })
        }
        throw error
      }
    },
  })
}
