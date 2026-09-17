/**
 * One way to run an Agent API request: submit in the background, poll by id.
 *
 * Both of this package's agent-backed paths need the same thing — a run that may
 * take minutes must not depend on one long-lived connection. A synchronous
 * `POST /v1/agent` holds a single connection open for the whole run, and the
 * network closes it first: measured against the live API, a long `high` query
 * died at ~180s with `fetch failed <- SocketError: other side closed`, losing
 * the run even though Perplexity was still working on it. The Agent API
 * documents the answer — submit with `background: true`, then poll
 * `GET /v1/agent/{id}` — and that is what this module does for every caller.
 *
 * A polled run also lets a caller give up *cleanly*: when the deadline expires
 * the run is cancelled through the documented endpoint and its id is named in
 * the error, so a run that was already paid for can still be collected. A
 * synchronous request that times out can do neither.
 *
 * Nothing here holds state between calls. The loop is bounded, runs inside the
 * caller's call, and settles before returning: no background promise, no
 * in-memory pending table. (That pattern previously took this plugin down.) The
 * run lives on Perplexity's side, not in this process.
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { isAbortError, requestJson, sleep } from './shared.js'

/**
 * Statuses that mean the run will not change again.
 *
 * The Agent API documents exactly these four; `queued` and `in_progress` are
 * the only non-terminal ones.
 */
export const AGENT_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'incomplete'])

/** Steady-state poll interval for a long research run, in milliseconds. */
export const AGENT_POLL_INTERVAL_MS = 3_000

/**
 * How many extra attempts an unbilled backend failure gets.
 *
 * One, not a backoff ladder: the fault observed in practice was transient (the
 * same request succeeded on the next try), and a research call is expensive
 * enough that a second wasted minute is worse than reporting the failure.
 */
export const MAX_UNBILLED_RETRIES = 1

/**
 * Poll cadence for a call with a tight budget, in milliseconds.
 *
 * `web_search` must answer inside a 60 s tool budget, so a 1–3 s cadence would
 * spend a meaningful share of it waiting to ask whether the run is done. These
 * are short requests against a fast endpoint; 400 ms is cheap and keeps the
 * wait from dominating short answered-in-seconds runs.
 */
export const AGENT_POLL_INTERVAL_SHORT_MS = 400

/**
 * Ask the Agent API to cancel a run, and never fail over it.
 *
 * Cancellation is a courtesy to the account being billed for a run nobody is
 * waiting for any more, so a failure here must not replace the error the caller
 * actually needs to see. The endpoint is documented as asynchronous: a `200`
 * acknowledges with `status: "cancelling"` and the run stops shortly after.
 *
 * @param options - resolved provider options, for the base URL.
 * @param apiKey - bearer credential.
 * @param id - the response id to cancel.
 * @returns nothing; failures are swallowed deliberately.
 */
async function cancelAgentResponse(options, apiKey, id) {
  try {
    await requestJson(
      `${options.baseURL}/v1/agent/${encodeURIComponent(id)}/cancel`,
      apiKey,
      undefined,
      undefined,
      WebError,
      'Perplexity search',
      0,
      'POST',
    )
  } catch {
    // Intentionally empty: the run may still be found later by id, and the
    // caller is already receiving the reason this call ended early.
  }
}

/**
 * Raised when the API reported a run as failed, carrying what it reported.
 *
 * The response is kept because the failure itself decides whether a retry is
 * safe: an API-side `model_error` that generated nothing is a backend fault
 * worth one more attempt, while a run that already produced (and billed) output
 * must never be repeated.
 */
export class AgentRunError extends WebError {
  /**
   * @param response - the terminal response snapshot with `status: 'failed'`.
   * @param message - the message to report; omitted when this module has
   *   nothing to add, so the API's own words pass through unchanged.
   */
  constructor(response, message) {
    const id = response?.id
    const detail = response?.error?.message ?? response?.error?.code
    super(
      message ?? `Perplexity run failed (response ${String(id)})`
      + `${detail !== undefined ? `: ${String(detail)}` : ` with status ${String(response?.status)}`}`,
      'WEB_PROVIDER_ERROR',
    )
    this.name = 'AgentRunError'
    this.responseId = id
    this.response = response
    this.errorCode = response?.error?.code
  }
}

/**
 * True when a failed run generated nothing, and did not bill anything.
 *
 * This is the condition that makes a second attempt safe. A research request is
 * long and expensive, so a wasted failure is worth retrying — but only when the
 * API says no output was produced. A run whose `usage` is present has been
 * billed for work that already happened, and repeating it could duplicate the
 * result the caller wanted once, so it is reported instead.
 *
 * @param response - the API's own terminal snapshot for a failed run.
 * @returns whether a retry cannot duplicate anything.
 */
export function isUnbilledFailure(response) {
  if (response === null || typeof response !== 'object') return false
  if (response.status !== 'failed') return false
  const usage = response.usage
  return usage === null || usage === undefined
}

/** Machine-readable `failureKind` for a run whose model stage emitted nothing. */
export const MODEL_NO_OUTPUT = 'model_no_output'

/**
 * Count what a run's stored output actually holds.
 *
 * The distinction this exists for: a failed run can hold every retrieval item
 * and no answer at all. `status: 'failed'` and the API's own prose cannot say
 * which of those happened, so the counts are read from the output itself and
 * reported alongside the error.
 *
 * @param response - the API's own terminal snapshot.
 * @returns the item counts, all zero for a response with no output array.
 */
export function summarizeAgentOutput(response) {
  const items = Array.isArray(response?.output) ? response.output : []
  const summary = {
    itemCount: items.length,
    messageItems: 0,
    answerChars: 0,
    searchResultBatches: 0,
    fetchUrlBatches: 0,
    otherItemTypes: [],
  }
  for (const item of items) {
    if (item?.type === 'message') {
      summary.messageItems += 1
      for (const block of item.content ?? []) {
        if (block?.type === 'output_text' && typeof block.text === 'string') {
          summary.answerChars += block.text.length
        }
      }
    } else if (item?.type === 'search_results') {
      summary.searchResultBatches += 1
    } else if (item?.type === 'fetch_url_results') {
      summary.fetchUrlBatches += 1
    } else if (item?.type !== undefined) {
      summary.otherItemTypes.push(String(item.type))
    }
  }
  return summary
}

/**
 * True when a failed run produced no answer message at all.
 *
 * This is the observable shape of the `reasoning_only` / model-stage fault: the
 * run is terminal and `failed`, the retrieval items are all there, and
 * `output` holds no `message` item. Billing is a separate axis — see
 * {@link isUnbilledFailure} — because a run can emit nothing and still be
 * charged for the tool calls it made.
 *
 * Deliberately not a claim about the cause: the classification says what the
 * API returned, not why the model produced nothing.
 *
 * @param response - the API's own terminal snapshot.
 * @returns whether the run failed with zero answer messages.
 */
export function isModelNoOutputFailure(response) {
  if (response === null || typeof response !== 'object') return false
  if (response.status !== 'failed') return false
  return summarizeAgentOutput(response).messageItems === 0
}

/** Render the retrieval-vs-answer counts as one clause. */
function describeModelStageOutput(summary) {
  const batches = []
  if (summary.searchResultBatches > 0) {
    batches.push(`${summary.searchResultBatches} search-result ${summary.searchResultBatches === 1 ? 'batch' : 'batches'}`)
  }
  if (summary.fetchUrlBatches > 0) {
    batches.push(`${summary.fetchUrlBatches} URL-fetch ${summary.fetchUrlBatches === 1 ? 'batch' : 'batches'}`)
  }
  const retrieval = batches.length > 0
    ? `the retrieval stage ran (${batches.join(' and ')})`
    : 'no retrieval items were recorded'
  return `${retrieval}, then the model stage emitted nothing: ${summary.messageItems} message items and ${summary.answerChars} answer characters`
}

/**
 * Raised when a run failed with the model stage having produced no answer.
 *
 * Its own class, because the three failure classes call for different next
 * moves and the API's prose does not separate them: a 429 says wait, a
 * connection failure says the request never arrived, and this says the request
 * arrived, the research ran, and the backend returned nothing. The message names
 * the machine facts a reader needs to tell those apart — the upstream
 * `error.code`, the run id, that retrieval completed and how much of it, that
 * zero message items came back, and whether anything was billed — and the same
 * facts are attached as fields for a caller that routes on structure.
 *
 * `invalid_request` is reported verbatim like any other code. It is *not* taken
 * to mean this side's request body was rejected: these runs were accepted and
 * completed their retrieval, so the code describes the model stage, and
 * rewriting the request would be changing the wrong thing.
 */
export class AgentModelNoOutputError extends AgentRunError {
  /**
   * @param response - the terminal snapshot with `status: 'failed'`.
   * @param context - what the run asked for and where it can be retrieved.
   */
  constructor(response, context = {}) {
    const summary = summarizeAgentOutput(response)
    const billed = !(response?.usage === null || response?.usage === undefined)
    const preset = typeof context.preset === 'string' && context.preset.length > 0 ? context.preset : undefined
    const model = typeof context.model === 'string' && context.model.length > 0 ? context.model : undefined
    const upstream = response?.error?.message ?? response?.error?.code
    const ids = Array.isArray(context.responseIds) && context.responseIds.length > 0
      ? context.responseIds
      : [response?.id]
    const subject = [`response ${String(response?.id)}`]
    // The preset is what was asked for; naming the model instead is only a
    // fallback for a preset-less request, because with a preset the model is
    // Perplexity's to choose and changes without notice.
    if (preset !== undefined) subject.push(`preset ${preset}`)
    else if (model !== undefined) subject.push(`model ${model}`)
    if (response?.error?.code !== undefined) subject.push(`upstream code ${String(response.error.code)}`)
    const parts = [
      `Perplexity run failed at the model stage (${subject.join(', ')}):`,
      `${describeModelStageOutput(summary)}.`,
      billed
        ? 'The run was billed (usage was reported), so its work is not free to repeat.'
        : 'Nothing was billed (usage: null).',
      // Naming the two nearby failure classes is the point of this class: a
      // reader must not wait out a rate limit or debug a socket for a fault
      // that is neither.
      'This is a model-stage backend failure — not a rate limit (no HTTP 429) and not a connection failure.',
      context.baseURL !== undefined && response?.id !== undefined
        ? `The run is stored, so its full snapshot can be read with GET ${String(context.baseURL)}/v1/agent/${String(response.id)}.`
        : '',
      ids.length > 1
        ? `All ${ids.length} attempts ended this way (response ids: ${ids.join(', ')}).`
        : '',
      upstream !== undefined
        ? `upstream said: ${JSON.stringify(String(upstream))}`
        : 'upstream sent no readable error text',
    ]
    super(response, parts.filter((part) => part !== '').join(' '))
    this.name = 'AgentModelNoOutputError'
    this.failureKind = MODEL_NO_OUTPUT
    this.preset = preset
    this.model = model
    this.billed = billed
    this.retrievalCompleted = summary.searchResultBatches + summary.fetchUrlBatches > 0
    this.messageItems = summary.messageItems
    this.answerChars = summary.answerChars
    this.searchResultBatches = summary.searchResultBatches
    this.fetchUrlBatches = summary.fetchUrlBatches
    this.attempts = ids.length
    this.responseIds = ids
  }
}

/**
 * The error for one terminal `failed` snapshot.
 *
 * Separate from the constructor so `pollUntilTerminal` reports what it saw
 * without deciding the classification itself.
 *
 * @param snapshot - the terminal response snapshot.
 * @param context - the preset/model the run asked for.
 * @param baseURL - endpoint base, so the message can name the retrieval URL.
 * @returns the classified error to throw.
 */
function failedAgentRunError(snapshot, context, baseURL) {
  if (isModelNoOutputFailure(snapshot)) {
    return new AgentModelNoOutputError(snapshot, {
      preset: context?.preset,
      model: context?.model,
      baseURL,
    })
  }
  return new AgentRunError(snapshot)
}

/**
 * Raised when a run was still going at its deadline and has been cancelled.
 *
 * Callers distinguish this from a provider failure because it is their own
 * deadline, not the API's behaviour: `web_search` degrades to a faster preset
 * on it, while a research call reports it. The message names the run id, so a
 * run that was already paid for can still be collected by hand.
 */
export class AgentDeadlineError extends WebError {
  /**
   * @param lastError - the last polling error, when polling was failing.
   * @param id - the cancelled run's response id.
   * @param baseURL - endpoint base, so the message can name the retrieval URL.
   */
  constructor(lastError, id, baseURL) {
    super(
      `Perplexity did not finish within its deadline, so the run was cancelled. Its id is ${String(id)}: `
      + `it can still be retrieved with GET ${String(baseURL)}/v1/agent/${String(id)}.`
      + `${lastError !== undefined ? ` Last polling error: ${String(lastError.message ?? lastError)}` : ''}`,
      'WEB_PROVIDER_ERROR',
    )
    this.name = 'AgentDeadlineError'
    this.responseId = id
    if (lastError !== undefined) this.lastPollError = lastError
  }
}

/**
 * Wait for a background Agent response to reach a terminal status.
 *
 * A poll that fails transiently does not abandon the run — the run is
 * unaffected by a failed poll and the id still identifies it — so the loop
 * keeps polling until the deadline and only then reports the last error.
 *
 * @param id - response id returned by the background submit.
 * @param options - resolved provider options, for the base URL.
 * @param apiKey - bearer credential.
 * @param signal - cancellation signal: the caller's, plus this call's deadline.
 * @param deadline - epoch milliseconds to stop waiting at.
 * @param pollIntervalMs - steady-state poll interval.
 * @param context - the preset/model this run asked for, recorded on a failure.
 * @returns the terminal response object, for `completed` or `incomplete`.
 * @throws {AgentDeadlineError} when the deadline passes first.
 * @throws {WebError} when the run fails or the caller cancels.
 */
async function pollUntilTerminal(id, options, apiKey, signal, deadline, pollIntervalMs, isExpired, cancelRun, context) {
  const url = `${options.baseURL}/v1/agent/${encodeURIComponent(id)}`
  // A first poll does not need a full interval: a short run is often already
  // finished, and starting at the steady cadence would waste budget on nothing.
  let waitMs = Math.min(pollIntervalMs, 1_000)
  let lastError
  // A poll can end because the signal aborted, or because this call's deadline
  // timer fired. Both must cancel the remote run; only the second is a deadline.
  // `isAbortError` stays narrow (see `shared.js`) because callers elsewhere rely
  // on a bounded attempt still reporting its connection error, so a
  // timeout-shaped abort is recognized here, where it means a cancellation.
  const wasAborted = (error) => isAbortError(error) || error?.name === 'TimeoutError'

  for (;;) {
    try {
      await sleep(waitMs, signal)
    } catch (error) {
      if (wasAborted(error)) {
        await cancelRun()
        if (isExpired()) throw new AgentDeadlineError(error, id)
        throw new WebError('Perplexity request aborted', 'WEB_ABORTED', { cause: error })
      }
      throw error
    }

    let snapshot
    try {
      snapshot = await requestJson(url, apiKey, undefined, signal, WebError, 'Perplexity search', 0, 'GET')
    } catch (error) {
      if (error?.code === 'WEB_ABORTED') {
        await cancelRun()
        if (isExpired()) throw new AgentDeadlineError(lastError, id)
        throw error
      }
      // The run is unaffected by a failed poll, so remember the error and keep
      // waiting rather than abandoning a run that is still going.
      lastError = error
      waitMs = Math.min(waitMs * 2, pollIntervalMs)
      continue
    }

    if (snapshot !== null && typeof snapshot === 'object' && AGENT_TERMINAL_STATUSES.includes(snapshot.status)) {
      if (snapshot.status === 'completed' || snapshot.status === 'incomplete') return snapshot
      if (snapshot.status === 'cancelled') {
        throw new WebError(
          `Perplexity cancelled the run (response ${id}). It may have been stopped by the account or the `
          + 'service; retry the question, or narrow it.',
          'WEB_PROVIDER_ERROR',
        )
      }
      // Any other terminal status is `failed`. The snapshot is carried into the
      // error so the retry decision can consult what the API actually reported,
      // and a failure that produced no answer message at all is reported as its
      // own class rather than as a generic run failure.
      throw failedAgentRunError(snapshot, context, options.baseURL)
    }

    // Still `queued` or `in_progress`.
    waitMs = Math.min(waitMs * 2, pollIntervalMs)
    if (Date.now() >= deadline) {
      await cancelRun()
      throw new AgentDeadlineError(lastError, id)
    }
  }
}

/**
 * Run one Agent API request as a background run and return its terminal
 * response once it finishes inside `timeoutMs`.
 *
 * Every agent-backed call in this package goes through here, so search and
 * research cannot drift apart in how they submit, poll, cancel, or report. The
 * deadline is enforced by this function rather than by aborting a fetch, so an
 * expired call can cancel its remote run; the caller's `signal` is combined with
 * it, keeping a harness cancellation immediate.
 *
 * @param body - the Agent request body; `background` is set here, not by callers.
 * @param options - resolved provider options, for the base URL.
 * @param apiKey - bearer credential.
 * @param signal - optional caller cancellation.
 * @param timeoutMs - how long to wait; `0` or less means no deadline.
 * @param pollIntervalMs - steady-state poll interval; defaults to the long-run cadence.
 * @returns the terminal response object.
 * @throws {AgentDeadlineError} when the deadline passes before the run finishes.
 */
export async function runAgentRequest(body, options, apiKey, signal, timeoutMs, pollIntervalMs = AGENT_POLL_INTERVAL_MS) {
  const hasDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0
  const deadline = hasDeadline ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY
  // One signal carries both reasons to stop; the reason tags are what let the
  // poll loop tell "our deadline" from "the caller cancelled", which is the same
  // distinction the degraded retry in `web_search` depends on.
  const controller = new AbortController()
  const deadlineReason = { deadline: true }
  // Tracking "did MY timer fire" rather than the abort reason: a caller signal
  // that aborts carries its own reason through, so comparing reasons alone would
  // misread a harness cancellation as this deadline and rewrite an abort into a
  // provider error.
  let expired = false
  const onOuterAbort = () => controller.abort(signal.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timer = hasDeadline
    ? setTimeout(() => {
      expired = true
      controller.abort(deadlineReason)
    }, timeoutMs)
    : undefined
  // Expiry is only expiry if the caller did not cancel: a caller already gone
  // must surface as a cancellation, never as this call's deadline.
  const isExpired = () => expired && !(signal !== undefined && signal.aborted)
  // Report a cancellation before anything else — before the submit, and before
  // any retry or poll, so an already-cancelled call issues no request at all.
  if (signal?.aborted) throw new WebError('Perplexity request aborted', 'WEB_ABORTED')
  // The id only exists after the submit below; a holder lets both abort paths
  // cancel a run that was already started without reordering the setup.
  const started = { id: undefined }
  const cancelRunIfStarted = () => (started.id === undefined
    ? Promise.resolve()
    : cancelAgentResponse(options, apiKey, started.id))
  const deadlineError = (lastError) => new AgentDeadlineError(lastError, started.id, options.baseURL)

  try {
    // The preset and explicit model are read once, from the body actually sent,
    // so a failure report names what this run asked Perplexity for rather than
    // what the settings said at some other moment.
    const requestedPreset = typeof body?.preset === 'string' && body.preset.length > 0 ? body.preset : undefined
    const requestedModel = typeof body?.model === 'string' && body.model.length > 0 ? body.model : undefined
    const runContext = { preset: requestedPreset, model: requestedModel }
    // Every unbilled failure is kept, not only the last: "failed once" and
    // "failed twice" are different facts, and the response ids of both attempts
    // are what an incident report — and Perplexity's own retrieval endpoint —
    // need. A billed failure never reaches here; it is thrown immediately.
    const unbilledFailures = []
    for (let attempt = 0; attempt <= MAX_UNBILLED_RETRIES; attempt += 1) {
      if (attempt > 0) {
        // Only a wasted run is worth repeating, and only if the deadline still
        // leaves room to finish. A search that has spent most of its budget
        // must report its failure and let the caller degrade instead of
        // starting a run it cannot wait for.
        const remaining = deadline - Date.now()
        if (remaining !== Number.POSITIVE_INFINITY && remaining < Math.ceil(timeoutMs / 2)) break
      }

      let submitted
      try {
        submitted = await requestJson(
          `${options.baseURL}/v1/agent`,
          apiKey,
          { ...body, background: true },
          controller.signal,
          WebError,
          'Perplexity search',
          0,
          'POST',
        )
      } catch (error) {
        // The deadline firing *during the submit* is still our deadline: the
        // degraded retry may not begin, or a search would silently lose the
        // distinction between "slow" and "cancelled". The submit carries no run
        // id yet, so there is nothing to cancel here.
        if (isExpired()) throw deadlineError()
        throw error
      }
      if (submitted !== null && typeof submitted === 'object' && AGENT_TERMINAL_STATUSES.includes(submitted.status)) {
        // A response that is already terminal needs no id: it is passed straight
        // to the caller's mapper, which is also what keeps an unrecognised body
        // shape a "no answer" rather than a hard error. That is deliberate — a
        // response in the deleted chat-completions shape must not be mistaken for
        // an Agent answer, and must not be turned into a failure either.
        return submitted
      }
      const id = submitted?.id
      if (typeof id !== 'string' || id.length === 0) {
        // No id and no terminal status: nothing to poll, so hand the body to the
        // caller's mapper. It recognizes the Agent output shape and reports "no
        // answer" for anything else, which is the behaviour callers had before
        // background mode and is the honest outcome for a body this code cannot
        // interpret — better than inventing a failure for it.
        return submitted
      }
      started.id = id
      try {
        return await pollUntilTerminal(
          id, options, apiKey, controller.signal, deadline, pollIntervalMs, isExpired, cancelRunIfStarted, runContext)
      } catch (error) {
        // The retry is for one specific fault: the API ran the research and then
        // the model produced nothing, so the run cost nothing and its answer is
        // recoverable by asking again. `usage: null` is what makes that safe. A
        // run that billed for output may already hold the answer, so it is
        // reported rather than repeated.
        if (!(error instanceof AgentRunError) || !isUnbilledFailure(error.response)) throw error
        unbilledFailures.push(error)
      }
    }
    // Every attempt was an unpaid backend failure; report the last one, which
    // still names its run id. When the fault is the model-stage one, the error
    // is rebuilt so its message states the attempt count and lists every run id
    // instead of describing only the attempt that happened to be last.
    const lastUnbilled = unbilledFailures[unbilledFailures.length - 1]
    if (lastUnbilled instanceof AgentModelNoOutputError) {
      throw new AgentModelNoOutputError(lastUnbilled.response, {
        ...runContext,
        baseURL: options.baseURL,
        responseIds: unbilledFailures.map((failure) => failure.responseId),
      })
    }
    throw lastUnbilled
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onOuterAbort)
  }
}
