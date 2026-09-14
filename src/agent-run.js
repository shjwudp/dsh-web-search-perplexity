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
 * @returns the terminal response object, for `completed` or `incomplete`.
 * @throws {AgentDeadlineError} when the deadline passes first.
 * @throws {WebError} when the run fails or the caller cancels.
 */
async function pollUntilTerminal(id, options, apiKey, signal, deadline, pollIntervalMs, isExpired, cancelRun) {
  const url = `${options.baseURL}/v1/agent/${encodeURIComponent(id)}`
  // A first poll does not need a full interval: a short run is often already
  // finished, and starting at the steady cadence would waste budget on nothing.
  let waitMs = Math.min(pollIntervalMs, 1_000)
  let lastError

  for (;;) {
    try {
      await sleep(waitMs, signal)
    } catch (error) {
      if (isAbortError(error)) {
        await cancelRun()
        if (isExpired()) throw new AgentDeadlineError(error, id)
        throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
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
      const detail = snapshot.error?.message ?? snapshot.error?.code
      throw new WebError(
        `Perplexity run failed (response ${id})`
        + `${detail !== undefined ? `: ${String(detail)}` : ` with status ${String(snapshot.status)}`}`,
        'WEB_PROVIDER_ERROR',
      )
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
  if (signal?.aborted) throw new WebError('Perplexity search aborted', 'WEB_ABORTED')
  // The id only exists after the submit below; a holder lets both abort paths
  // cancel a run that was already started without reordering the setup.
  const started = { id: undefined }
  const cancelRunIfStarted = () => (started.id === undefined
    ? Promise.resolve()
    : cancelAgentResponse(options, apiKey, started.id))
  const deadlineError = (lastError) => new AgentDeadlineError(lastError, started.id, options.baseURL)

  try {
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
    return await pollUntilTerminal(
      id, options, apiKey, controller.signal, deadline, pollIntervalMs, isExpired, cancelRunIfStarted)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onOuterAbort)
  }
}
