# How failures are reported

The seam and the harness agent loop forward an error's `message`, so every failure
here is built to be actionable as prose *and* carries the same facts as fields on the
error object. A caller that routes on structure reads the fields; a reader gets the
sentence.

## Three failure classes, three next moves

| Failure | How it is reported | What it means |
|---|---|---|
| Rate limit | `HTTP 429 after N attempts (…) …`, `error.status === 429` | Wait, or the quota window is closed |
| Connection failure | `Perplexity search request failed: <cause chain> [<METHOD> <url>] (pid=… uptime=… runtime=…)` | The request never arrived |
| **Model stage produced nothing** | `AgentModelNoOutputError`, `failureKind: 'model_no_output'` | The request arrived, the research ran, and the backend returned no answer |

They are separate classes because they call for different next moves. A 429 says
wait; a connection failure says the request never arrived; the third says neither, so
waiting or debugging a socket would both be wasted effort.

### Rate limits

The message names the HTTP status, how many attempts were made of the budget, the
elapsed time, the backoff actually spent, and whether the server sent `Retry-After` —
and then preserves the upstream sentence verbatim, so neither half can swallow the
other. The same facts are fields: `status`, `attempts`, `retries`, `elapsedMs`,
`retryAfterMs`, `retryAfterSupplied`, `backoffTotalMs`, `backoffCapMs`,
`clampedBackoffs`.

The retry budget is deliberately small: at most `retries` waits, each capped at 10 s
however large a `Retry-After` the server sends, because a real quota window resets on
a minute scale and waiting it out would pin a tool call past any caller's budget. When
a wait was shortened, the message says so instead of quietly reporting a shorter
backoff. When the budget runs out, the message says that the *budget* is spent rather
than implying the limit has lifted.

### Connection failures

`fetch` reports every connection-layer failure as the same `TypeError: fetch failed`
and puts the actionable part in `cause`. The message therefore walks the cause chain
and names each level's `code`/`errno`/`syscall`/`address`/`port`/`hostname`, the
endpoint, the HTTP method actually used, and the process that produced it — `pid`,
uptime, start time, Node version, and every proxy variable that process sees, with any
credential in a proxy URL redacted. Which process it was matters: a failure that
happens in one host and not another on the same machine is decided by state the
process holds, not by the request.

### A run that researched but answered nothing

A failed Agent run can hold every retrieval item and no answer at all. The provider
reports that as its own failure class rather than as a generic run failure. The
message names the upstream `error.code`, the run id, the preset that was asked for,
how much retrieval completed, that zero `message` items came back, whether anything was
billed, and the `GET /v1/agent/{id}` URL that still retrieves the run.

The same facts are fields: `failureKind`, `responseId`, `responseIds`, `attempts`,
`errorCode`, `preset`, `billed`, `retrievalCompleted`, `messageItems`, `answerChars`,
`searchResultBatches`, `fetchUrlBatches`, and the inherited `response` snapshot.
`error.code` stays `WEB_PROVIDER_ERROR` — the seam's routing category is unchanged.

Two axes are deliberately independent: **retry safety** is decided by `usage` (an
unbilled failure is repeated once; a billed one is reported, never repeated, because
it may already hold the answer), while **classification** is decided by the missing
answer, so a billed run with no output is still classified and still says it was
billed.

`error.code: invalid_request` on such a run is reported verbatim but is *not* read as
a rejection of the request: the run was accepted and completed its retrieval, so the
code describes the model stage. Do not "fix" the request body for it.

A client-side degraded-preset fallback was considered and rejected. The decision, the
confirmed/upstream split, and the open questions are in
[model-stage-no-output.md](model-stage-no-output.md), with the report draft in
[upstream-report-model-no-output.md](upstream-report-model-no-output.md).
`scripts/probe-run-timeline.mjs` dates a run's failure from the harness's own session
logs when the API's `created_at` cannot (that doc's §5).

## Retrieving a failed run

Every run is stored, so a failure is not the end of the information:

```powershell
cd C:\path\to\repo
node scripts/probe-failed-run.mjs resp_xxxxxxxx
```

The script reads the key from the User environment scope and never prints it. A
cancelled or timed-out run can be collected the same way with
`GET /v1/agent/{id}`.
