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

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { PERPLEXITY_RESEARCH_SKILL } from './skill.js'
import { PerplexitySearchApiProvider, SEARCH_API_PROVIDER_ID } from './search-api.js'
import { DEFAULT_RESEARCH_TIMEOUT_MS, applyResearchTool, researchTimeoutMs } from './research.js'
import { canParseURL, isAbortError, requestJson as postJson, resolveApiKey } from './shared.js'

export const name = 'web-search-perplexity'
// All three are required rather than probed: the plugin contributes the
// `perplexity_research` tool, whose model-facing guidance is a prompt section.
// A composition without either registry could not honour that contribution, so
// the plugin says so instead of failing later on an undefined service.
// `web` is the seam both search providers register into.
export const inject = ['web', 'tools', 'systemPrompt']

export {
  DEFAULT_RESEARCH_TIMEOUT_MS,
  RESEARCH_DEFAULT_DEPTH,
  RESEARCH_DEPTHS,
  RESEARCH_TOOL_NAME,
  formatResearchOutput,
  parseResearchArgs,
  presentResearchCall,
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

const SETTINGS_NAMESPACE = 'web-search-perplexity'
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
 * Per-image byte ceiling. Perplexity's own base64 limit is 50 MB.
 *
 * An image request carries no model of its own: measured against the Agent API,
 * a preset's own model reads images correctly (`preset: fast` answers an image
 * question with `openai/gpt-5.6-luna` and the right answer), so image and text
 * requests share one model selector and cannot disagree.
 */
const DEFAULT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** Media type selected by a file extension, for an extension that names an image. */
const IMAGE_MEDIA_TYPE_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
})

/** Extension of each allowed media type, used in the refusal messages. */
const IMAGE_EXTENSION_BY_MEDIA_TYPE = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
})

/** A local image path candidate: the leading character of a filesystem path. */
const LOCAL_IMAGE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/])/
/** A candidate image URL: public HTTPS with a recognized image extension. */
const IMAGE_URL_PATTERN = /^https:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?$/i

/**
 * Prefix of the machine-readable image line prepended to `content`. Like
 * `DEGRADED_MARKER_PREFIX`, this is the only route for the `images` object on
 * the seam result into `dsh-tool-web`'s closed `web_search` output schema.
 */
export const IMAGE_MARKER_PREFIX = '[IMAGE] '

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

/** Durable settings section surfaced as a plugin-config card in the web UI. */
const Config = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  preset: z.string().default(''),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  model: z.string().default(AGENT_DEFAULT_MODEL),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  searchRecency: z.string().default(''),
  // No schema default: an unset deadline follows the configured preset, so the
  // default cannot drift out of step with the preset it is paired with.
  softTimeoutMs: z.number().step(1).min(0),
  fallbackPreset: z.string().default(DEFAULT_FALLBACK_PRESET),
  // Blank enables image input; only the literal "off"/"false"/"0" disables it,
  // so a cleared field cannot silently change what the provider sends.
  imageInput: z.string().default(''),
  imageMaxBytes: z.number().step(1).min(1).default(DEFAULT_IMAGE_MAX_BYTES),
  imageRoots: z.array(z.string()).default([]),
  // Which of this plugin's two backends serves searches. Blank keeps the Agent
  // API; only the Search API's id switches. Both are never registered as usable
  // at once, because two usable providers make the seam's selection ambiguous.
  searchProvider: z.string().default(''),
  searchType: z.string().default('web'),
  searchDomains: z.array(z.string()).default([]),
  searchLanguages: z.array(z.string()).default([]),
  searchCountry: z.string().default(''),
  searchContextSize: z.string().default('medium'),
  searchMaxTokensPerPage: z.number().step(1).min(1),
  searchAfterDate: z.string().default(''),
  searchBeforeDate: z.string().default(''),
  // The `perplexity_research` tool's own budget, independent of `tool-web`'s.
  // This is the tool's reason to exist, not a second deadline for search: a
  // quick search is bounded by `softTimeoutMs`, a research call by this.
  researchTimeoutMs: z.number().step(1).min(0).default(DEFAULT_RESEARCH_TIMEOUT_MS),
})

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
  const joined = texts.join('\n\n')
  const content = joined.length > 0
    ? joined + (data.status === 'incomplete'
      ? '\n\n(Truncated: the response reached max output tokens. Increase maxTokens for a complete answer.)'
      : '')
    : ''
  return {
    ...(content.length > 0 ? { content } : {}),
    sources,
    truncated: false,
  }
}

/** Detect an image media type from leading bytes, independent of any extension. */
function sniffImageMediaType(bytes) {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6) {
    const gif = String.fromCharCode(...bytes.subarray(0, 6))
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

/** True when `path` is inside one of the configured roots, or no roots are set. */
function isWithinImageRoots(path, roots) {
  if (roots.length === 0) return true
  return roots.some((root) => {
    const candidate = relative(root, path)
    return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))
  })
}

/**
 * Read one local image query and turn it into a data URI.
 *
 * @param {string} path - the query, read as a filesystem path.
 * @param {object} options - resolved provider options.
 * @returns {Promise<{kind: 'image', mediaType: string, dataUri: string, bytes: number}>}
 *   the inline image, or `{kind: 'text'}` when the path is not an image at all.
 * @throws {WebError} when the path names a file that is refused — outside
 *   `imageRoots`, over `imageMaxBytes`, or not the image format its extension
 *   claims. A refusal is never silent: shipping a non-image file to Perplexity
 *   is exactly what the checks exist to prevent.
 */
async function readLocalImageQuery(path, options) {
  const resolvedPath = resolve(path)
  if (!isWithinImageRoots(resolvedPath, options.imageRoots)) {
    throw new WebError(
      `The image query "${path}" is outside the configured imageRoots `
      + `(${options.imageRoots.join(', ')}). Add that directory to `
      + 'web-search-perplexity.imageRoots, or pass a public https image URL instead.',
      'WEB_PROVIDER_ERROR',
    )
  }

  let stats
  try {
    stats = await stat(resolvedPath)
  } catch {
    // Not an existing file: an ordinary text query, not a failed image one.
    return { kind: 'text' }
  }
  if (!stats.isFile()) return { kind: 'text' }
  const extension = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase()
  let claimed = IMAGE_MEDIA_TYPE_BY_EXTENSION[extension]
  if (claimed === undefined) {
    // No extension at all can still be an image (normalized attachment objects
    // are content-addressed and carry none); a wrong or non-image extension is
    // an ordinary query, not an image to read.
    if (extension.startsWith('.')) return { kind: 'text' }
    claimed = 'image/png'
  }
  if (stats.size > options.imageMaxBytes) {
    throw new WebError(
      `The image query "${path}" is ${stats.size} bytes, above imageMaxBytes `
      + `(${options.imageMaxBytes}). Lower the image resolution or raise `
      + 'web-search-perplexity.imageMaxBytes (the Perplexity per-image cap is 50 MB).',
      'WEB_PROVIDER_ERROR',
    )
  }
  const bytes = await readFile(resolvedPath)
  const mediaType = sniffImageMediaType(bytes) ?? undefined
  if (mediaType === undefined || mediaType !== claimed) {
    // The path exists and is not confidently this image format: treat an
    // unrecognized file as text rather than shipping an arbitrary document.
    if (extension in IMAGE_MEDIA_TYPE_BY_EXTENSION) {
      throw new WebError(
        `The image query "${path}" has an ${extension} extension but its bytes are not `
        + `${claimed}. Rename the file to its real format, or pass a public https image URL.`,
        'WEB_PROVIDER_ERROR',
      )
    }
    return { kind: 'text' }
  }
  return {
    kind: 'image',
    mediaType,
    dataUri: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`,
    bytes: bytes.length,
  }
}

/**
 * Classify one query as an image to attach or as ordinary search text.
 *
 * @param {string} query - one `web_search` query.
 * @param {object} options - resolved provider options.
 * @returns {Promise<{kind: 'image', source: string, mediaType?: string, dataUri: string, bytes?: number}
 *   | {kind: 'text'}>} the classification; `dataUri` is the URL itself for a URL image.
 */
async function classifyImageQuery(query, options) {
  const text = typeof query === 'string' ? query.trim() : ''
  if (text.length === 0) return { kind: 'text' }
  if (IMAGE_URL_PATTERN.test(text)) return { kind: 'image', source: text, dataUri: text }
  if (text.startsWith('http://') || text.startsWith('https://') || text.startsWith('//')) {
    // A web address never names a local file, whatever its extension.
    return { kind: 'text' }
  }
  const looksLikeLocalPath = LOCAL_IMAGE_PATH_PATTERN.test(text) || isAbsolute(text)
  if (!looksLikeLocalPath) return { kind: 'text' }
  const read = await readLocalImageQuery(text, options)
  return read.kind === 'image' ? { ...read, source: text } : read
}

/**
 * Build the request body for one image-bearing search, separating the text
 * question (a non-image query in the same call) from the attached images.
 *
 * @param {string[]} queries - the queries of one search call.
 * @param {object} options - resolved provider options.
 * @returns {Promise<{body: object, marker: object}|undefined>} the `input` message
 *   array plus its model-facing marker, or `undefined` when this call carries no
 *   image.
 */
async function buildImageRequest(queries, options) {
  if (!options.imageInput) return undefined
  const classified = []
  for (const query of queries) classified.push(await classifyImageQuery(query, options))
  const images = classified.filter((item) => item.kind === 'image')
  if (images.length === 0) return undefined
  const textQueries = queries.filter((_, index) => classified[index]?.kind !== 'image')
  const question = textQueries.join('\n').trim()
    || 'Analyze this image and research what it shows using web sources.'
  const marker = {
    images: images.length,
    source: images.map((image) => image.source),
    bytes: images.reduce((total, image) => total + (image.bytes ?? 0), 0),
  }

  return {
    marker,
    body: {
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: question },
          ...images.map((image) => ({ type: 'input_image', image_url: image.dataUri })),
        ],
      }],
    },
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
 * Attach the model-facing image marker to a mapped response. `content` is the
 * only field `dsh-tool-web` forwards to the model, so the marker line is what
 * tells it which image was analyzed.
 */
function withImageMarker(mapped, marker) {
  const line = `${IMAGE_MARKER_PREFIX}${JSON.stringify(marker)}`
  return {
    ...mapped,
    content: mapped.content !== undefined && mapped.content.length > 0
      ? `${line}\n\n${mapped.content}`
      : line,
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
  // Image input is on unless it was explicitly switched off.
  const imageInput = c.imageInput === undefined
    || (typeof c.imageInput === 'string' && !['off', 'false', '0'].includes(c.imageInput.trim().toLowerCase()))
  // An image request gets the text deadline plus the analysis margin, capped
  // where the degraded retry still fits the tool budget, and `0` stays `0` so
  // disabling the deadline disables it for images too. This is deliberately not
  // a separate setting: two deadlines side by side invite a configuration where
  // the image one is wrong for the text one.
  const imageDeadlineMs = softTimeoutMs === 0
    ? 0
    : Math.min(softTimeoutMs + IMAGE_ANALYSIS_MARGIN_MS, MAX_SOFT_TIMEOUT_MS)
  return {
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

/** Abort reason marking OUR soft deadline, distinct from an outer cancellation. */
const SOFT_DEADLINE = 'PERPLEXITY_SOFT_DEADLINE'

/**
 * Arm a soft deadline over the caller's signal.
 *
 * The returned signal aborts when either the outer signal aborts (a harness
 * tool-budget cancellation) or this timer expires. `expired()` separates the
 * two, and that distinction is what makes a degraded retry safe: only our own
 * timer may trigger one, because an outer cancellation means no budget is left
 * to retry inside.
 *
 * @param outerSignal - the signal the web seam forwarded, when it forwarded one.
 * @param ms - the soft budget in milliseconds.
 * @returns the derived signal, an expiry test, and a disarm function.
 */
function softDeadline(outerSignal, ms) {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort(outerSignal.reason)
  if (outerSignal !== undefined) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason)
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }
  // The timer is deliberately NOT unref'd: it is the mechanism that bounds the
  // request, so it must be able to fire even when nothing else holds the event
  // loop open. Every caller clears it in a `finally`, so it cannot outlive the
  // search that armed it.
  const timer = setTimeout(() => controller.abort(SOFT_DEADLINE), ms)
  return {
    signal: controller.signal,
    expired: () => controller.signal.aborted && controller.signal.reason === SOFT_DEADLINE,
    clear: () => {
      clearTimeout(timer)
      if (outerSignal !== undefined) outerSignal.removeEventListener('abort', onOuterAbort)
    },
  }
}

/** Build the Agent API request body for one preset. */
function agentRequestBody(request, options, preset) {
  const body = {
    input: request.query,
    tools: [webSearchTool(options)],
    ...(Number.isInteger(options.maxTokens) && options.maxTokens > 0
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
 * @returns the complete Agent API request body.
 */
function agentImageRequestBody(body, options, preset) {
  return {
    ...body,
    tools: [webSearchTool(options)],
    ...(preset !== '' ? { preset } : { model: options.model }),
    ...(Number.isInteger(options.maxTokens) && options.maxTokens > 0
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
  let current = () => config

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

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {},
    })
  })

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
    degradationStatus,
    mapAgentResponse,
    requestJson,
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
    () => resolveOptions(ctx, current()).searchApi,
  ))

  ctx.web.registerSearchProvider({
    id: 'perplexity',
    available() {
      const options = resolveOptions(ctx, current())
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
          + 'or open Settings → Plugins → Plugin configuration → Perplexity web search '
          + 'and save an API key there.',
          'WEB_PROVIDER_ERROR',
        )
      }

      // A query naming an image (local file or public https URL) becomes the
      // request's image content; every other query stays the text question.
      const imageRequest = await buildImageRequest([request.query], options)
      const url = `${options.baseURL}/v1/agent`
      const preset = options.preset

      // No soft deadline configured: one request, exactly as before.
      if (!(options.softTimeoutMs > 0)) {
        const body = imageRequest !== undefined
          ? agentImageRequestBody(imageRequest.body, options, preset)
          : agentRequestBody(request, options, options.preset)
        const data = await requestJson(url, apiKey, body, signal)
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
      const primary = softDeadline(signal, deadlineMs)
      let primaryData
      let softTimedOut = false
      try {
        if (imageRequest !== undefined) {
          primaryData = await requestJson(
            url, apiKey, agentImageRequestBody(imageRequest.body, options, preset), primary.signal)
        } else {
          primaryData = await requestJson(
            url, apiKey, agentRequestBody(request, options, options.preset), primary.signal)
        }
      } catch (error) {
        // Only OUR deadline may degrade the answer. An outer cancellation is
        // the harness tool budget: no time is left for a retry. Any other
        // error is a real provider failure, not a latency problem.
        if (!primary.expired() || (signal !== undefined && signal.aborted)) throw error
        softTimedOut = true
      } finally {
        primary.clear()
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
      // `tool call timed out` result the caller would otherwise receive.
      const fallback = softDeadline(signal, FALLBACK_TIMEOUT_MS)
      try {
        const body = imageRequest !== undefined
          ? agentImageRequestBody(imageRequest.body, options, preset)
          : agentRequestBody(request, options, options.fallbackPreset)
        const data = await requestJson(url, apiKey, body, fallback.signal, 1)
        const mapped = degradedAgentResult(data, { ...options, preset })
        return imageRequest !== undefined
          ? { ...withImageMarker(mapped, imageRequest.marker), images: imageRequest.marker }
          : mapped
      } catch (error) {
        if (fallback.expired() && !(signal !== undefined && signal.aborted)) {
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
      } finally {
        fallback.clear()
      }
    },
  })
}
