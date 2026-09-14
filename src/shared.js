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

/** Proxy env names, in the spellings Node and undici consult. */
const PROXY_ENV_NAMES = [
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
]

/**
 * Render the userinfo of a proxy URL as `***`, so a credentialed proxy URL can
 * be reported without disclosing the credential.
 *
 * @param value - the raw environment value.
 * @returns the value with any `user:pass@` replaced by `***@`.
 */
export function redactProxyValue(value) {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    if (url.username === '' && url.password === '') return value
    url.username = '***'
    url.password = ''
    return url.toString()
  } catch {
    // Not a URL: report the shape without risking a credential.
    return value.includes('@') ? '***@(unparseable)' : value
  }
}

/**
 * Load time of this module, used as a fallback clock for process age when
 * `process.uptime()` is unavailable.
 */
const MODULE_LOADED_AT = Date.now()

/**
 * Describe which process is asking, and how long it has been alive.
 *
 * The host process is a variable, not a constant: the same request succeeded
 * one minute after a host started and failed four minutes later in the same
 * process, and restarting healed it. So every failure has to name the process
 * that produced it. Without that, "which instance was this?" is unanswerable
 * from the message alone, and a per-process state bug looks like an
 * intermittent network fault.
 *
 * `pid` identifies the host instance; `uptime` is its age in seconds, which is
 * the value that made the in-process degradation visible at all. `started` is
 * the same fact in wall-clock form, so a reader can correlate a failure with a
 * restart without having to know when the message was produced. The clock is
 * only read here, inside the failure path, so a successful call pays nothing.
 *
 * @returns one line naming the process id, its uptime, and its start time.
 */
export function describeProcess() {
  const uptimeMs = typeof process.uptime === 'function'
    ? process.uptime() * 1000
    : Date.now() - MODULE_LOADED_AT
  let started
  try {
    // Epoch milliseconds on Node 20+, where `getCreationTime` gives the clock
    // directly. Where it is absent, `Date.now() - uptimeMs` is used instead:
    // exact to within the process age, and still enough to identify the
    // restart, which is the whole point of the field.
    const creation = process.getCreationTime?.()
    const startedMs = typeof creation === 'number' ? creation : Date.now() - uptimeMs
    started = new Date(startedMs).toISOString()
  } catch (error) {
    // A diagnostic must never be the reason a failure goes unreported, but it
    // must not hide its own failure behind a placeholder either: naming why the
    // absolute clock was unavailable is the difference between "cannot tell"
    // and "this field is broken".
    started = `(unavailable: ${String(error?.message ?? error)})`
  }
  return `pid=${process.pid} uptime=${(uptimeMs / 1000).toFixed(1)}s started=${started}`
}

/**
 * Describe the runtime configuration a connection failure depends on.
 *
 * A `fetch` failure that happens in one process and not another on the same
 * machine is decided by something outside the request: the runtime version, the
 * process's own identity and age, and the proxy variables that process actually
 * sees. Node's `fetch` ignores the proxy environment — a harness installs a
 * dispatcher when it wants them honored — but a long-lived host can have those
 * names written at runtime, which no external observer can see. Reporting them
 * here makes the next failure carry its own answer.
 *
 * @returns one line naming the runtime, the process, and every set proxy
 * variable, redacted.
 */
export function describeRuntime() {
  const proxy = PROXY_ENV_NAMES
    .filter((name) => process.env[name] !== undefined && process.env[name] !== '')
    .map((name) => `${name}=${redactProxyValue(String(process.env[name]))}`)
  return `${describeProcess()} runtime=node/${process.version} ${proxy.length > 0 ? proxy.join(' ') : 'proxy=(none set)'}`
}

/**
 * Render a thrown value's full cause chain as machine-readable text.
 *
 * `fetch` reports every connection-layer failure as the same
 * `TypeError: fetch failed`, and puts the actionable part — `ENOTFOUND`,
 * `ECONNREFUSED`, `ETIMEDOUT`, a TLS error, a proxy refusal — in `cause` (for
 * an aggregate failure, in `cause.errors[]`). `String(error)` shows none of it,
 * so a provider failure reached the caller as an undiagnosable "fetch failed".
 * This walks the chain and appends each level's `name`, `message`, and any
 * `code`/`errno`/`syscall`/`address`/`port`/`hostname`.
 *
 * @param error - the thrown value, of any type.
 * @param depth - current depth, to bound the walk.
 * @returns one line naming the error and its causes, innermost last.
 */
export function describeErrorCause(error, depth = 0) {
  if (depth > 4) return '(cause chain truncated)'
  if (error === undefined || error === null) return '(no value)'
  if (!(error instanceof Error)) return String(error)
  const details = []
  for (const field of ['code', 'errno', 'syscall', 'address', 'port', 'hostname']) {
    const value = error[field]
    if (value !== undefined) details.push(`${field}=${String(value)}`)
  }
  const head = `${error.name}: ${error.message}${details.length > 0 ? ` (${details.join(', ')})` : ''}`
  const causes = []
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    // An aggregate fetch failure wraps one error per attempted address.
    for (const inner of error.errors) causes.push(describeErrorCause(inner, depth + 1))
  }
  if (error.cause !== undefined && error.cause !== error) {
    causes.push(describeErrorCause(error.cause, depth + 1))
  }
  return causes.length > 0 ? `${head} <- ${causes.join(' | ')}` : head
}

/**
 * POST one JSON request and return the parsed response body.
 *
 * A 429 is retried with `Retry-After` honored when present, so a first-call
 * rate limit self-heals instead of surfacing as an error. Redirects are
 * rejected before the `Location` target is contacted, so the bearer credential
 * never follows a redirect to another origin.
 *
 * `Connection: close` is sent so the connection is not kept alive and reused.
 * The host failed with `UND_ERR_SOCKET: other side closed` ~4 minutes into a
 * process that had just succeeded, which is undici handing a new POST a
 * keep-alive socket the other end had already closed. Closing the connection
 * is the fix that needs no retry: `UND_ERR_SOCKET` says the peer closed the
 * socket, NOT that the request went unprocessed, and `/v1/agent` is a long
 * task — so a blind resend of a POST that may already be running risks
 * duplicate work, which is worse than a clean failure. Not reusing the socket
 * removes the failure mode instead of recovering from it. The cost is one TLS
 * handshake per call, which is irrelevant next to a multi-second research
 * request. Prefer this over installing an `undici.Agent`: a request-scoped
 * dispatcher would also override Node's own proxy handling, and a broken proxy
 * path is a worse regression than the socket reuse this avoids.
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
          // Do not leave a reusable keep-alive socket behind; see the note on
          // this function for why not reusing beats retrying here.
          connection: 'close',
        },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw new webError(`${messagePrefix} aborted`, 'WEB_ABORTED', { cause: error })
      }
      // The endpoint is named because a wrong baseURL is one of the things this
      // message has to distinguish; the runtime line names what the process
      // itself sees, which is the part an outside observer cannot inspect.
      throw new webError(
        `${messagePrefix} request failed: ${describeErrorCause(error)} [POST ${url}] (${describeRuntime()})`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
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
