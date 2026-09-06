/**
 * Standalone Perplexity search provider for the DeepSeek Harness web seam.
 *
 * Registers a `WebSearchProvider` with id `perplexity` into `ctx.web`.
 * It calls Perplexity's OpenAI-compatible `POST /chat/completions` endpoint
 * and maps the generated answer plus `search_results[]` / `citations[]`
 * into the seam's normalized `WebSearchResult`.
 *
 * Unlike the official `@deepseek-ai/dsh-web-search-perplexity` package, this
 * plugin does NOT depend on `@deepseek-ai/dsh-environment` (which is not
 * published on the npm registry). The API key is resolved from the plugin
 * config or the `PERPLEXITY_API_KEY` environment variable.
 */

import { WebError } from '@deepseek-ai/dsh-web'

export const name = 'web-search-perplexity'
export const inject = ['web']

const DEFAULT_BASE_URL = 'https://api.perplexity.ai'
const DEFAULT_MODEL = 'sonar'
const DEFAULT_MAX_TOKENS = 1024
const USER_AGENT = 'dsh-web-search-perplexity/0.1.0'

function canParseURL(value) {
  try {
    return new URL(value) !== null
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
  const content = data.choices?.[0]?.message?.content
  const sources = data.search_results !== undefined
    ? data.search_results.map(mapPerplexityResult)
    : (data.citations ?? []).map((url) => ({ url }))
  return {
    ...(typeof content === 'string' && content.length > 0 ? { content } : {}),
    sources,
    truncated: false,
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - row config from cordis.yml / patch layers.
 */
export function apply(ctx, config = {}) {
  const apiKey = String(config.apiKey ?? process.env.PERPLEXITY_API_KEY ?? '').trim()
  const baseURL = String(config.baseURL ?? DEFAULT_BASE_URL).trim()
  const model = String(config.model ?? DEFAULT_MODEL).trim()
  const maxTokens = Number(config.maxTokens ?? DEFAULT_MAX_TOKENS)
  const searchRecency = config.searchRecency

  ctx.web.registerSearchProvider({
    id: 'perplexity',
    available() {
      return apiKey.length > 0
        && canParseURL(baseURL)
        && Number.isInteger(maxTokens)
        && maxTokens > 0
    },
    async search(request, signal) {
      let response
      try {
        response = await fetch(`${baseURL}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: request.query }],
            ...(searchRecency !== undefined ? { search_recency_filter: searchRecency } : {}),
          }),
          ...(signal !== undefined ? { signal } : {}),
        })
      } catch (error) {
        if (isAbortError(error)) {
          throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
        }
        throw new WebError(`Perplexity search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }

      if (!response.ok) {
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

      try {
        return mapPerplexityResponse(await response.json())
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
    },
  })
}
