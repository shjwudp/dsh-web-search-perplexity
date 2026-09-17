/**
 * Perplexity Search API provider: `POST {baseURL}/search`, Perplexity's
 * structured search endpoint. Unlike the Agent API in `./index.js`, it returns
 * a ranked `results[]` array and no generated answer, so the seam result has
 * sources and no `content`.
 *
 * It is registered as a second provider in the same plugin and becomes the
 * usable one only when `searchProvider: perplexity-search` is configured; the
 * Agent API stays the default. Registering both unconditionally would leave the
 * seam with two usable providers and make every search fail as ambiguous.
 *
 * Request and response details follow Perplexity's published schema
 * (`POST /search`): `query`, `max_results` (1-20 web, 1-50 people), the
 * `search_context_size` token budget, `country`, `search_language_filter`, and
 * `search_domain_filter`, plus the date and recency filters.
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { canParseURL, requestJson, resolveApiKey } from './shared.js'

/** Stable id this provider registers under. */
export const SEARCH_API_PROVIDER_ID = 'perplexity-search'

/** Endpoint path appended to the configured base URL. */
export const SEARCH_API_PATH = '/search'

/** Perplexity's own bounds for `max_results`, which differ per search type. */
export const SEARCH_API_MAX_RESULTS_WEB = 20
export const SEARCH_API_MAX_RESULTS_PEOPLE = 50

/** Domain-filter bound from the published schema: at most 20 entries. */
export const SEARCH_API_MAX_DOMAINS = 20

/** Language-filter bound from the published schema: at most 20 two-letter codes. */
export const SEARCH_API_MAX_LANGUAGES = 20

/** Search types the endpoint accepts. */
export const SEARCH_API_TYPES = ['web', 'people']

/** Content-extraction budgets the endpoint accepts. */
export const SEARCH_CONTEXT_SIZES = ['low', 'medium', 'high']

/** Recency windows the endpoint accepts; `hour` is Search-API-only. */
export const SEARCH_API_RECENCY_VALUES = ['hour', 'day', 'week', 'month', 'year']

/**
 * Deadline for one Search API request when `softTimeoutMs` is not configured.
 * Measured latency is ~1–4 s, so this is generous headroom rather than a value
 * tuned to the endpoint; it exists so a stalled request still ends.
 */
export const SEARCH_API_DEFAULT_TIMEOUT_MS = 40_000

/**
 * Prefix of the machine-readable marker prepended to `content`. The result
 * carries no generated answer, and `content` is the only field `dsh-tool-web`
 * forwards to the model, so this line is what tells the model that these are
 * ranked search hits to read rather than an answer to cite.
 */
export const SEARCH_API_MARKER_PREFIX = '[SEARCH] '

/** A two-letter ISO 3166-1 alpha-2 country code. */
const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/

/** A two-letter ISO 639-1 language code. */
const LANGUAGE_CODE_PATTERN = /^[a-z]{2}$/

/** `MM/DD/YYYY`, the format the date filters require. */
const DATE_FILTER_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/**
 * Resolve the provider's request-shaping options from configuration.
 *
 * @param config - the plugin row or settings section supplying the keys.
 * @returns the resolved options; invalid entries are dropped rather than sent,
 *   because the endpoint rejects a malformed filter with `422`.
 */
export function resolveSearchApiOptions(config) {
  const c = config ?? {}
  const searchType = SEARCH_API_TYPES.includes(c.searchType) ? c.searchType : 'web'
  const domains = Array.isArray(c.searchDomains)
    ? c.searchDomains
      .filter((domain) => typeof domain === 'string' && domain.trim().length > 0)
      .map((domain) => domain.trim())
      .slice(0, SEARCH_API_MAX_DOMAINS)
    : []
  const languages = Array.isArray(c.searchLanguages)
    ? c.searchLanguages
      .filter((code) => typeof code === 'string' && LANGUAGE_CODE_PATTERN.test(code.trim().toLowerCase()))
      .map((code) => code.trim().toLowerCase())
      .slice(0, SEARCH_API_MAX_LANGUAGES)
    : []
  const country = typeof c.searchCountry === 'string' && COUNTRY_CODE_PATTERN.test(c.searchCountry.trim())
    ? c.searchCountry.trim().toUpperCase()
    : undefined
  const contextSize = SEARCH_CONTEXT_SIZES.includes(c.searchContextSize) ? c.searchContextSize : 'medium'
  const recency = SEARCH_API_RECENCY_VALUES.includes(c.searchRecency) ? c.searchRecency : undefined
  // The schema's date filters are publication dates in MM/DD/YYYY.
  const after = typeof c.searchAfterDate === 'string' && DATE_FILTER_PATTERN.test(c.searchAfterDate.trim())
    ? c.searchAfterDate.trim()
    : undefined
  const before = typeof c.searchBeforeDate === 'string' && DATE_FILTER_PATTERN.test(c.searchBeforeDate.trim())
    ? c.searchBeforeDate.trim()
    : undefined
  return {
    apiKeyEnv: typeof c.apiKeyEnv === 'string' && c.apiKeyEnv.length > 0 ? c.apiKeyEnv : 'PERPLEXITY_API_KEY',
    literalApiKey: typeof c.apiKey === 'string' && c.apiKey.length > 0 ? c.apiKey : undefined,
    baseURL: typeof c.baseURL === 'string' && c.baseURL.length > 0 ? c.baseURL : 'https://api.perplexity.ai',
    searchType,
    domains,
    languages,
    country,
    contextSize,
    recency,
    after,
    before,
    // How much extracted page content one request may return. The seam returns
    // these snippets to the model, so this is the Search API's own equivalent of
    // a result-size budget.
    maxTokensPerPage: Number.isInteger(c.searchMaxTokensPerPage) && c.searchMaxTokensPerPage > 0
      ? c.searchMaxTokensPerPage
      : undefined,
    // One deadline governs the console: a configured `softTimeoutMs` bounds this
    // backend too, and the fallback is internal so the two backends cannot
    // disagree about how long a search may take.
    softTimeoutMs: Number.isInteger(c.softTimeoutMs) && c.softTimeoutMs >= 0
      ? c.softTimeoutMs
      : SEARCH_API_DEFAULT_TIMEOUT_MS,
  }
}

/**
 * The largest `max_results` this configuration may ask for.
 *
 * @param searchType - the resolved search type.
 * @returns the bound that applies to that type.
 */
export function maxResultsFor(searchType) {
  return searchType === 'people' ? SEARCH_API_MAX_RESULTS_PEOPLE : SEARCH_API_MAX_RESULTS_WEB
}

/**
 * The content budget for one search, as request fields.
 *
 * `search_context_size` applies to web search only. Sending it unconditionally
 * would break every people search: measured against the live endpoint, a people
 * search that carries it is rejected. That rejection is this project's own
 * observation — the current published schema does not forbid the combination and
 * does not document the status code, so the omission is a precaution rather than
 * a documented requirement.
 *
 * @param options - resolved Search API options.
 * @returns either the context-size field or an empty object.
 */
function contextBudget(options) {
  if (options.searchType !== 'web') return {}
  return { search_context_size: options.contextSize }
}

/**
 * Build the request body for one search.
 *
 * `maxResults` is sent as `max_results` because the endpoint has a native result
 * count — the one control the Agent API lacks. The seam still enforces the
 * bound on the way back; sending it here is a cost and latency optimization.
 *
 * @param request - the seam's search request.
 * @param options - resolved Search API options.
 * @returns the request body.
 */
export function searchApiRequestBody(request, options) {
  const limit = Number.isInteger(request.maxResults) && request.maxResults > 0
    ? Math.min(request.maxResults, maxResultsFor(options.searchType))
    : Math.min(10, maxResultsFor(options.searchType))
  return {
    query: request.query,
    max_results: limit,
    search_type: options.searchType,
    ...contextBudget(options),
    ...(options.country !== undefined ? { country: options.country } : {}),
    ...(options.languages.length > 0 ? { search_language_filter: options.languages } : {}),
    ...(options.domains.length > 0 ? { search_domain_filter: options.domains } : {}),
    ...(options.recency !== undefined ? { search_recency_filter: options.recency } : {}),
    ...(options.after !== undefined ? { search_after_date_filter: options.after } : {}),
    ...(options.before !== undefined ? { search_before_date_filter: options.before } : {}),
    ...(options.maxTokensPerPage !== undefined ? { max_tokens_per_page: options.maxTokensPerPage } : {}),
  }
}

/**
 * Map the Search API's `results[]` into the seam's normalized result.
 *
 * @param data - the parsed response body.
 * @returns the normalized result. `content` is empty when no result carries a
 *   snippet, because this endpoint generates no answer.
 */
export function mapSearchApiResponse(data) {
  const sources = []
  const seen = new Set()
  for (const result of data?.results ?? []) {
    if (typeof result?.url !== 'string' || result.url.length === 0 || seen.has(result.url)) continue
    seen.add(result.url)
    sources.push({
      url: result.url,
      ...(typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {}),
      ...(typeof result.snippet === 'string' && result.snippet.length > 0 ? { snippet: result.snippet } : {}),
      ...(typeof result.date === 'string' && result.date.length > 0
        ? { publishedAt: result.date }
        : typeof result.last_updated === 'string' && result.last_updated.length > 0
          ? { publishedAt: result.last_updated }
          : {}),
    })
  }
  return { sources, truncated: false }
}

/**
 * Arm a deadline over the caller's signal. The timer aborts `expired()`-tagged
 * only when this deadline, not the caller, is what fired, so an outer
 * cancellation is never rewritten into a timeout message.
 *
 * @param outerSignal - the signal the web seam forwarded, when any.
 * @param ms - the deadline in milliseconds.
 * @returns the derived signal, an expiry test, and a disarm function.
 */
function boundedDeadline(outerSignal, ms) {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort(outerSignal?.reason)
  if (outerSignal !== undefined) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason)
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(DEADLINE_REASON), ms)
  return {
    signal: controller.signal,
    expired: () => controller.signal.aborted && controller.signal.reason === DEADLINE_REASON,
    clear: () => {
      clearTimeout(timer)
      if (outerSignal !== undefined) outerSignal.removeEventListener('abort', onOuterAbort)
    },
  }
}

/** Abort reason marking this provider's own deadline. */
const DEADLINE_REASON = 'PERPLEXITY_SEARCH_API_DEADLINE'

/** The Search API-backed provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class PerplexitySearchApiProvider {
  /**
   * @param ctx - plugin context, used to resolve the API key.
   * @param configSource - returns the current settings section, so a change made
   *   in the UI applies to the next search without a restart.
   * @param selected - whether the Search API is the configured backend. The Agent
   *   provider in `./index.js` answers the same question, and the two must never
   *   both report usable or the seam refuses the search as ambiguous.
   */
  constructor(ctx, configSource, selected) {
    this.ctx = ctx
    this.configSource = configSource
    this.selected = selected
  }

  /** @returns the stable provider id. */
  get id() {
    return SEARCH_API_PROVIDER_ID
  }

  /** Cheap local usability check; makes no network call. */
  available() {
    if (!this.selected()) return false
    const options = resolveSearchApiOptions(this.configSource())
    const configuredKey = typeof options.literalApiKey === 'string' && options.literalApiKey.length > 0
    const credentialsService = this.ctx.get('credentials') !== undefined
    const ambientKey = typeof process.env[options.apiKeyEnv] === 'string'
      && process.env[options.apiKeyEnv].length > 0
    return (configuredKey || credentialsService || ambientKey) && canParseURL(options.baseURL)
  }

  /**
   * Run one search through `POST {baseURL}/search`.
   *
   * @param request - the query and optional result bound.
   * @param signal - optional cancellation signal.
   * @returns the normalized result, capped by the endpoint's own result count.
   * @throws {WebError} `WEB_PROVIDER_ERROR` for a missing key or a rejected
   *   request, `WEB_ABORTED` for cancellation.
   */
  async search(request, signal) {
    const options = resolveSearchApiOptions(this.configSource())
    const apiKey = await resolveApiKey(this.ctx, options.literalApiKey, options.apiKeyEnv)
    if (apiKey === undefined || apiKey.length === 0) {
      throw new WebError(
        'Perplexity API key is not configured. Set PERPLEXITY_API_KEY, '
        + 'or open Settings → Plugins → Plugin configuration → Perplexity web search '
        + 'and save an API key there.',
        'WEB_PROVIDER_ERROR',
      )
    }
    // `0` disables the deadline, exactly as it does for the Agent API.
    const deadline = options.softTimeoutMs > 0
      ? boundedDeadline(signal, options.softTimeoutMs)
      : { signal, expired: () => false, clear: () => {} }
    let data
    try {
      data = await requestJson(
        `${options.baseURL}${SEARCH_API_PATH}`,
        apiKey,
        searchApiRequestBody(request, options),
        deadline.signal,
        WebError,
        'Perplexity search',
      )
    } catch (error) {
      if (deadline.expired() && !(signal !== undefined && signal.aborted)) {
        throw new WebError(
          `Perplexity Search API did not answer within ${Math.round(options.softTimeoutMs / 1000)}s. `
          + 'Retry with a narrower query, or raise web-search-perplexity.softTimeoutMs together '
          + 'with the web_search tool budget.',
          'WEB_PROVIDER_ERROR', { cause: error },
        )
      }
      throw error
    } finally {
      deadline.clear()
    }
    const mapped = mapSearchApiResponse(data)
    // The endpoint returns no generated answer, and content is the only field
    // `dsh-tool-web` forwards, so the marker is how the model learns that these
    // are ranked hits rather than an answer.
    const marker = {
      provider: SEARCH_API_PROVIDER_ID,
      sources: mapped.sources.length,
      ...(options.searchType !== 'web' ? { searchType: options.searchType } : {}),
    }
    return { ...mapped, content: `${SEARCH_API_MARKER_PREFIX}${JSON.stringify(marker)}` }
  }
}
