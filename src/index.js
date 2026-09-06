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
 * model, maxTokens, searchRecency, and the API key (the key is stored through
 * the credentials domain, never in the settings file).
 *
 * This plugin does NOT depend on `@deepseek-ai/dsh-environment` (which is not
 * published on the npm registry). As a fallback it still reads the
 * `PERPLEXITY_API_KEY` process environment variable.
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
const USER_AGENT = 'dsh-web-search-perplexity/0.1.1'

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
  return {
    apiKey: literalApiKey,
    apiKeyEnv,
    apiMode,
    agentModelOverride,
    preset: AGENT_PRESETS.includes(c.preset) ? c.preset : '',
    baseURL: typeof c.baseURL === 'string' && c.baseURL.length > 0 ? c.baseURL : DEFAULT_BASE_URL,
    model,
    maxTokens: Number.isInteger(c.maxTokens) && c.maxTokens > 0 ? c.maxTokens : DEFAULT_MAX_TOKENS,
    searchRecency: SEARCH_RECENCY_VALUES.includes(c.searchRecency) ? c.searchRecency : undefined,
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
    const onAbort = () => {
      clearTimeout(timer)
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
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
        const agentBody = {
          input: request.query,
          tools: [{ type: 'web_search' }],
          ...(Number.isInteger(options.maxTokens) && options.maxTokens > 0
            ? { max_output_tokens: options.maxTokens }
            : {}),
        }
        if (options.preset !== '') {
          agentBody.preset = options.preset
          // With a preset, `model` is optional and only sent as an override
          // when the user explicitly configured a `provider/model` slug.
          if (options.agentModelOverride !== undefined) agentBody.model = options.agentModelOverride
        } else {
          agentBody.model = options.model
        }
        const data = await requestJson(`${options.baseURL}/v1/agent`, apiKey, agentBody, signal)
        return mapAgentResponse(data)
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
      return mapPerplexityResponse(data)
    },
  })
}
