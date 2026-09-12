/**
 * Standalone Perplexity search provider for the DeepSeek Harness web seam.
 *
 * Registers a `WebSearchProvider` with id `perplexity` into `ctx.web`.
 * It calls Perplexity's OpenAI-compatible `POST /chat/completions` endpoint
 * and maps the generated answer plus `search_results[]` / `citations[]`
 * into the seam's normalized `WebSearchResult`.
 *
 * Configuration is exposed through the durable `web-search-perplexity`
 * settings namespace, so the web UI's Plugins settings can edit baseURL,
 * model, maxTokens, searchRecency, the soft deadline and its fallback preset,
 * and the API key (the key is stored through the credentials domain, never in
 * the settings file).
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
 */

import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { PERPLEXITY_RESEARCH_SKILL } from './skill.js'

export const name = 'web-search-perplexity'
export const inject = ['web']

const SETTINGS_NAMESPACE = 'web-search-perplexity'
const DEFAULT_BASE_URL = 'https://api.perplexity.ai'
const DEFAULT_MODEL = 'sonar'
const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_API_KEY_ENV = 'PERPLEXITY_API_KEY'
const DEFAULT_API_MODE = 'agent'
const API_MODES = ['sonar', 'agent']
const AGENT_PRESETS = ['fast', 'low', 'medium', 'high', 'xhigh', 'wide-research']
const AGENT_DEFAULT_MODEL = 'openai/gpt-5.6-luna'
// Keep in sync with `version` in package.json.
const USER_AGENT = 'dsh-web-search-perplexity/0.1.5'
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

const SEARCH_RECENCY_VALUES = ['day', 'week', 'month', 'year']

/** Durable settings section surfaced as a plugin-config card in the web UI. */
const Config = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  apiMode: z.string().default(DEFAULT_API_MODE),
  preset: z.string().default(''),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  model: z.string().default(DEFAULT_MODEL),
  maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  searchRecency: z.string().default(''),
  // No schema default: an unset deadline follows the configured preset, so the
  // default cannot drift out of step with the preset it is paired with.
  softTimeoutMs: z.number().step(1).min(0),
  fallbackPreset: z.string().default(DEFAULT_FALLBACK_PRESET),
})

function canParseURL(value) {
  try {
    // Only HTTPS is safe here: the provider sends the Perplexity API key in the
    // Authorization header, so an http:// baseURL would leak it in cleartext.
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isAbortError(error) {
  return (error instanceof Error && error.name === 'AbortError')
    || (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
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

/** Map a Perplexity chat-completions response into a normalized search result. */
function mapPerplexityResponse(data) {
  const rawContent = data.choices?.[0]?.message?.content
  const finishReason = data.choices?.[0]?.finish_reason
  const content = typeof rawContent === 'string' && rawContent.length > 0
    ? rawContent + (finishReason === 'length'
      ? '\n\n(Truncated: the response reached max_tokens. Increase maxTokens for a complete answer.)'
      : '')
    : undefined
  const sources = data.search_results !== undefined
    ? data.search_results.map(mapPerplexityResult)
    : (data.citations ?? []).map((url) => ({ url }))
  return {
    ...(content !== undefined ? { content } : {}),
    sources,
    truncated: false,
  }
}

/** Map an Agent API response into a normalized search result. */
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
  const apiMode = API_MODES.includes(c.apiMode) ? c.apiMode : DEFAULT_API_MODE
  const rawModel = typeof c.model === 'string' && c.model.length > 0 ? c.model : DEFAULT_MODEL
  // Agent API model ids are `provider/model` slugs. If the configured model is
  // a Sonar-era id (no `/`), fall back to a valid Agent API model.
  const model = apiMode === 'agent' && !rawModel.includes('/') ? AGENT_DEFAULT_MODEL : rawModel
  // With an Agent preset, the model is only sent as an explicit override when
  // the user actually configured a `provider/model` slug.
  const agentModelOverride = apiMode === 'agent' && rawModel.includes('/') ? rawModel : undefined
  const preset = AGENT_PRESETS.includes(c.preset) ? c.preset : ''
  // An explicit `softTimeoutMs` always wins — including 0, which disables the
  // deadline. Otherwise the deadline follows the configured preset's measured
  // latency instead of a preset-independent constant.
  const softTimeoutMs = Number.isInteger(c.softTimeoutMs) && c.softTimeoutMs >= 0
    ? c.softTimeoutMs
    : defaultSoftTimeoutMsFor(preset)
  return {
    apiKey: literalApiKey,
    apiKeyEnv,
    apiMode,
    agentModelOverride,
    preset,
    baseURL: typeof c.baseURL === 'string' && c.baseURL.length > 0 ? c.baseURL : DEFAULT_BASE_URL,
    model,
    maxTokens: Number.isInteger(c.maxTokens) && c.maxTokens > 0 ? c.maxTokens : DEFAULT_MAX_TOKENS,
    searchRecency: SEARCH_RECENCY_VALUES.includes(c.searchRecency) ? c.searchRecency : undefined,
    // 0 disables the soft deadline, restoring the single-request behavior.
    softTimeoutMs,
    // Only a fast synchronous preset is a useful degraded retry: `wide-research`
    // is a minutes-long background workflow by design, not a latency fallback.
    fallbackPreset: AGENT_PRESETS.includes(c.fallbackPreset) && c.fallbackPreset !== 'wide-research'
      ? c.fallbackPreset
      : DEFAULT_FALLBACK_PRESET,
    async resolveApiKey() {
      if (literalApiKey !== undefined) return literalApiKey
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        try {
          const resolved = await credentials.resolve(apiKeyEnv)
          const value = resolved?.value
          if (typeof value === 'string' && value.length > 0) return value
        } catch {
          // fall through to the ambient process environment
        }
      }
      const ambient = process.env[apiKeyEnv]
      return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
    },
  }
}

function retryAfterMs(header) {
  if (typeof header !== 'string' || header.length === 0) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer
    const onAbort = () => {
      // `undefined` before the timer exists, and `clearTimeout(undefined)` is a
      // no-op, so the already-aborted path below can share this handler.
      clearTimeout(timer)
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    // A signal that is already aborted never fires `abort` again, so without this
    // check the caller would wait out the full backoff and only then learn it had
    // been cancelled — the 429 path can pass an already-aborted signal when the
    // soft deadline expires just as a retry begins.
    if (signal !== undefined && signal.aborted) {
      onAbort()
      return
    }
    timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
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
    tools: [{ type: 'web_search' }],
    ...(Number.isInteger(options.maxTokens) && options.maxTokens > 0
      ? { max_output_tokens: options.maxTokens }
      : {}),
  }
  if (preset !== '') {
    body.preset = preset
    // With a preset, `model` is optional and only sent as an explicit override
    // when the user explicitly configured a `provider/model` slug.
    if (options.agentModelOverride !== undefined) body.model = options.agentModelOverride
  } else {
    body.model = options.model
  }
  return body
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

/** POST one Perplexity JSON request and return the parsed response body. */
async function requestJson(url, apiKey, body, signal, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(`Perplexity search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (response.ok) {
      try {
        return await response.json()
      } catch (error) {
        if (isAbortError(error)) {
          throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
        }
        throw new WebError(
          `Perplexity returned an unprocessable response body: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
    }

    if (response.status === 429 && attempt < retries) {
      // Honor Retry-After when present, otherwise back off briefly. This is
      // what makes a first-call 429 self-heal instead of surfacing as an error.
      const waitMs = Math.min(retryAfterMs(response.headers.get('retry-after')) ?? 1000 * (2 ** attempt), 10_000)
      try {
        await sleep(waitMs, signal)
      } catch (error) {
        if (isAbortError(error)) {
          throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
        }
        throw error
      }
      continue
    }

    let message = `Perplexity API error (HTTP ${response.status})`
    try {
      const parsed = await response.json()
      const detail = typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error?.message ?? parsed.message
      if (detail !== undefined && String(detail).length > 0) message = String(detail)
    } catch (error) {
      if (isAbortError(error)) {
        throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
      }
    }
    throw new WebError(message, 'WEB_PROVIDER_ERROR')
  }
  throw new WebError('Perplexity API error (HTTP 429)', 'WEB_PROVIDER_ERROR')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - row config from cordis.yml / patch layers.
 */
export function apply(ctx, config = {}) {
  let current = () => config

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

  ctx.web.registerSearchProvider({
    id: 'perplexity',
    available() {
      const options = resolveOptions(ctx, current())
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
      const apiKey = (typeof options.apiKey === 'string' && options.apiKey.length > 0)
        ? options.apiKey
        : await options.resolveApiKey()
      if (apiKey === undefined || apiKey.length === 0) {
        throw new WebError(
          'Perplexity API key is not configured. Set PERPLEXITY_API_KEY, '
          + 'or open Settings → Plugins → Plugin configuration → Perplexity web search '
          + 'and save an API key there.',
          'WEB_PROVIDER_ERROR',
        )
      }

      if (options.apiMode === 'agent') {
        const url = `${options.baseURL}/v1/agent`

        // No soft deadline configured: one request, exactly as before.
        if (!(options.softTimeoutMs > 0)) {
          const data = await requestJson(url, apiKey, agentRequestBody(request, options, options.preset), signal)
          return {
            ...mapAgentResponse(data),
            degradation: degradationStatus(options.preset, options.preset, 0),
          }
        }

        const primary = softDeadline(signal, options.softTimeoutMs)
        let primaryData
        let softTimedOut = false
        try {
          primaryData = await requestJson(
            url, apiKey, agentRequestBody(request, options, options.preset), primary.signal)
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
          return {
            ...mapAgentResponse(primaryData),
            degradation: degradationStatus(options.preset, options.preset, options.softTimeoutMs),
          }
        }

        // Degraded retry: a shallow answer inside the budget beats the opaque
        // `tool call timed out` result the caller would otherwise receive.
        const fallback = softDeadline(signal, FALLBACK_TIMEOUT_MS)
        try {
          const data = await requestJson(
            url, apiKey, agentRequestBody(request, options, options.fallbackPreset), fallback.signal, 1)
          return degradedAgentResult(data, options)
        } catch (error) {
          if (fallback.expired() && !(signal !== undefined && signal.aborted)) {
            throw new WebError(
              `Perplexity agent search passed its ${Math.round(options.softTimeoutMs / 1000)}s soft deadline, and the `
              + `"${options.fallbackPreset}" fallback did not finish within `
              + `${Math.round(FALLBACK_TIMEOUT_MS / 1000)}s. Retry with a narrower, single-fact query, or set `
              + `web-search-perplexity.preset to "${options.fallbackPreset}" — raise softTimeoutMs together with `
              + 'the web_search tool budget if full-depth research is required.',
              'WEB_PROVIDER_ERROR', { cause: error })
          }
          throw error
        } finally {
          fallback.clear()
        }
      }

      const data = await requestJson(
        `${options.baseURL}/chat/completions`,
        apiKey,
        {
          model: options.model,
          max_tokens: options.maxTokens,
          messages: [{ role: 'user', content: request.query }],
          ...(options.searchRecency !== undefined ? { search_recency_filter: options.searchRecency } : {}),
        },
        signal,
      )
      return {
        ...mapPerplexityResponse(data),
        // Sonar mode has no preset, so nothing can degrade.
        degradation: degradationStatus('', '', 0),
      }
    },
  })
}
