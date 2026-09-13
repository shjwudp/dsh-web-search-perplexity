/**
 * Helpers shared by this package's Perplexity providers.
 *
 * The Agent API and the Search API differ in request and response shape but not
 * in transport: both POST JSON to the same base URL with the same bearer
 * credential, both classify cancellation and HTTP failures the same way, and
 * both resolve their API key through the same credential chain. Keeping those
 * here means a fix to retry, abort classification, or credential resolution
 * applies to every provider instead of one of them.
 */

/** Attribution header sent with every request; keep in sync with `version`. */
export const USER_AGENT = 'dsh-web-search-perplexity/0.1.7-rc.1'

/**
 * True when `value` is an HTTPS URL. Only HTTPS is acceptable: every request
 * carries the API key in its Authorization header, so an `http://` base would
 * leak the credential in cleartext.
 *
 * @param value - candidate endpoint base.
 * @returns whether it parses as an https URL.
 */
export function canParseURL(value) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * True for a fetch or `AbortSignal` abort, which the providers surface as
 * `WEB_ABORTED` rather than as a provider failure.
 *
 * @param error - value caught from a request.
 * @returns whether it is an abort.
 */
export function isAbortError(error) {
  return (error instanceof Error && error.name === 'AbortError')
    || (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError')
}

/**
 * Resolve the API key through the credential chain: a literal config value
 * first, then the credentials domain entry named by `apiKeyEnv` (which is what
 * the web UI writes), then the ambient process environment.
 *
 * @param ctx - plugin context whose `credentials` service may be mounted.
 * @param literalApiKey - a configured literal key, when any.
 * @param apiKeyEnv - credential reference name, e.g. `PERPLEXITY_API_KEY`.
 * @returns the key, or `undefined` when no source has one.
 */
export async function resolveApiKey(ctx, literalApiKey, apiKeyEnv) {
  if (typeof literalApiKey === 'string' && literalApiKey.length > 0) return literalApiKey
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(apiKeyEnv)
      const value = resolved?.value
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // Fall through to the ambient process environment: an unreadable
      // credential store must not make an ambient key unusable.
    }
  }
  const ambient = process.env[apiKeyEnv]
  return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
}

/**
 * `Retry-After` as milliseconds, for either accepted form (delay-seconds or an
 * HTTP date).
 *
 * @param header - the response's `retry-after` header value, when present.
 * @returns the delay in milliseconds, or `undefined` when absent or unparseable.
 */
function retryAfterMs(header) {
  if (typeof header !== 'string' || header.length === 0) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

/**
 * Wait for `ms`, rejecting with an abort error as soon as `signal` aborts — or
 * immediately when it already has, so a caller is never told to wait out a
 * backoff it has already been cancelled for.
 *
 * @param ms - milliseconds to wait.
 * @param signal - optional cancellation.
 * @returns completion, or a rejection carrying an `AbortError`.
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    // A signal that is already aborted never fires `abort` again, so without
    // this check the caller would wait out the full backoff before learning it
    // had been cancelled.
    if (signal !== undefined && signal.aborted) {
      onAbort()
      return
    }
    timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * POST one JSON request and return the parsed response body.
 *
 * A 429 is retried with `Retry-After` honored when present, so a first-call
 * rate limit self-heals instead of surfacing as an error. Redirects are
 * rejected before the `Location` target is contacted, so the bearer credential
 * never follows a redirect to another origin.
 *
 * @param url - absolute endpoint URL.
 * @param apiKey - bearer credential.
 * @param body - request body.
 * @param signal - optional cancellation signal.
 * @param webError - the `WebError` class to construct failures with.
 * @param messagePrefix - phrase naming the operation, e.g. `Perplexity search`.
 * @param retries - how many times a 429 may be retried.
 * @returns the parsed response body.
 * @throws when the request fails, is rejected, or its body is unreadable.
 */
export async function requestJson(url, apiKey, body, signal, webError, messagePrefix, retries = 2) {
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
        throw new webError(`${messagePrefix} aborted`, 'WEB_ABORTED', { cause: error })
      }
      throw new webError(`${messagePrefix} request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (response.ok) {
      try {
        return await response.json()
      } catch (error) {
        if (isAbortError(error)) {
          throw new webError(`${messagePrefix} aborted`, 'WEB_ABORTED', { cause: error })
        }
        throw new webError(
          `Perplexity returned an unprocessable response body: ${String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
    }

    if (response.status === 429 && attempt < retries) {
      const waitMs = Math.min(retryAfterMs(response.headers.get('retry-after')) ?? 1000 * (2 ** attempt), 10_000)
      try {
        await sleep(waitMs, signal)
      } catch (error) {
        // A cancellation that lands during the backoff is the same caller
        // cancellation as one that lands during the request, so it must carry
        // the same code rather than escaping as a bare AbortError.
        if (isAbortError(error)) {
          throw new webError(`${messagePrefix} aborted`, 'WEB_ABORTED', { cause: error })
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
      // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
      // into a generic HTTP-error message.
      if (isAbortError(error)) {
        throw new webError(`${messagePrefix} aborted`, 'WEB_ABORTED', { cause: error })
      }
      // Otherwise the HTTP status is already captured above; a malformed error
      // body can only cost a richer message, never the real error.
    }
    throw new webError(message, 'WEB_PROVIDER_ERROR')
  }
  throw new webError('Perplexity API error (HTTP 429)', 'WEB_PROVIDER_ERROR')
}
