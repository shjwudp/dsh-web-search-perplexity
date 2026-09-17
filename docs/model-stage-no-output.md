# A run that researched but answered nothing: diagnosis and the fallback decision

Status: **decision recorded 2026-09-16** · task `f40a29b9` · incident
2026-09-16 21:26–22:41 local · evidence: five stored Agent runs
(`store: true`, retrievable), `scripts/probe-failed-run.mjs`.

This record answers three questions the incident raised, and separates what this
repository can change from what only Perplexity can.

## 1. What happened

Five consecutive `perplexity_research` calls failed with zero successes. Every
one of them **completed its retrieval stage** — 9–13 `search_results` batches of
15 results, plus `fetch_url_results` — and then returned **no `message` item at
all**. All five reported `status: failed` with `usage: null`. Three carried
`error.code: model_error` with `… (reasoning_only)` in the message; two carried
`error.code: invalid_request`. Both codes appeared *after* a completed retrieval,
so `invalid_request` here is a model-stage code, **not** a rejection of our
request body.

| run id | preset | `error.code` | `usage` | output |
|---|---|---|---|---|
| `resp_a15e2273-3b8c-4ace-b020-840d5366e027` | high | `invalid_request` | null | 12 × search_results(15) + fetch_url_results, no `message` |
| `resp_fca3947a-ca26-4e44-88ad-dc354b4b440e` | high | `model_error` (reasoning_only) | null | 12 × search_results(15) + fetch_url_results, no `message` |
| `resp_f7c6c900-f0d6-4d6a-8178-a25f914edd16` | high | `model_error` (reasoning_only) | null | 9 × search_results(15) + 5 × fetch_url_results, no `message` |
| `resp_08f5e990-b980-4d6b-9aaf-a9dfa23e6c1f` | medium | `invalid_request` | null | 9 × search_results(15) + 5 × fetch_url_results, no `message` |
| `resp_0f9b7afc-ba54-4d3d-baf7-d9e94f0b74d5` | medium | `model_error` (reasoning_only) | null | 6 × search_results(15) + 3 × fetch_url_results, no `message` |

The verbatim upstream sentence was
`echolot: model produced no usable answer: no usable answer (reasoning_only)`.

It is worth stating what that leaves for a local fix — and the answer changed
once the cap was tested. The `high` preset's own published system prompt says the
opposite of what happened
([Presets](https://docs.perplexity.ai/docs/agent-api/presets.md)):

> ALWAYS end your turn with a complete final answer. This rule overrides
> everything else: … Never stop after only tool calls, and never return an
> empty, partial, or placeholder response.

The request was accepted, the preset was applied, the retrieval ran to
completion, and the model stage returned nothing. A local edit cannot make the
model smarter — but it can stop starving it, and that turned out to be the whole
story: all five runs carried this plugin's own **2 048-token output cap over the
preset's 128000**, and removing that cap makes the same questions answer. See
§3.1, which supersedes this record's first reading.

## 2. The three failure classes, now reported apart

`usage: null` + `status: failed` also means `isUnbilledFailure()` was true for
every one of the five, so each call should have spent its one
`MAX_UNBILLED_RETRIES` attempt. The run id a caller sees is the last attempt's,
which points at "the retry happened and failed the same way" — an inference from
the id, not a logged observation. The new error message no longer leaves that
inference to the reader: it lists **every** attempt's run id.

| class | what the caller now gets | what it does **not** look like |
|---|---|---|
| rate limit (HTTP 429) | `HTTP 429 after N attempts (…) …; server sent Retry-After: …`, `error.status === 429` | no `failureKind`, no run id, never an `AgentRunError` |
| connection failure | `Perplexity search request failed: <cause chain> [POST <url>] (pid=… uptime=… runtime=…)` | no `error.status`, no `failureKind` |
| **model stage produced nothing** | `AgentModelNoOutputError`, `failureKind: 'model_no_output'`, upstream code, run id(s), retrieval counts, `0 message items`, `usage: null`/billed, preset, retrieval URL | no `error.status`, no HTTP status of its own |

Fields on `AgentModelNoOutputError`: `failureKind`, `responseId`, `responseIds`,
`attempts`, `errorCode`, `preset`, `model`, `billed`, `retrievalCompleted`,
`messageItems`, `answerChars`, `searchResultBatches`, `fetchUrlBatches`, plus the
inherited `response` snapshot and `code: 'WEB_PROVIDER_ERROR'` (the seam's
routing category is unchanged; these fields are additive).

Two axes stay independent on purpose:

- **Retry safety** is decided by `usage` (`isUnbilledFailure`). Unbilled →
  repeated once. Billed → reported, never repeated, because the run may already
  hold the answer the caller wanted once.
- **Classification** is decided by the missing answer
  (`isModelNoOutputFailure`). A billed no-output run is still classified and
  still says it was billed.

## 3. What we can change, and what we cannot

**Cannot change (upstream).** What the model stage produces for a given budget.
This repository can identify such a failure, report it, keep the run id
retrievable, and refuse to repeat a billed run. It can also remove the
starvation that triggers one shape of it — which is §3.1, and which is the
single most important correction in this record.

**Deliberately not changed.** Two things look like levers and are not the fix:

1. **The request body.** `invalid_request` on a run that completed 9–12 search
   batches is a model-stage code. Rewriting the request to "fix" it would change
   the wrong thing and destroy the evidence.
2. **`max_output_tokens` — this one is no longer "leave alone".** We send
   `maxTokens` (live: 2048) over the preset's own 128000
   ([Presets](https://docs.perplexity.ai/docs/agent-api/presets.md)). It was
   first recorded here as an unforced deviation that was *not* the cause, on the
   strength of a 2048-cap measurement that produced 2379 tokens (commit
   `7d6ec8b`). **That reading did not survive being tested against the real
   incident questions** — see §3.1. The cap is now the leading *local*
   contributor to zero-answer runs, and it should be changed.

3. **`store`.** Left at its default `true`. That is the only reason these five
   snapshots were still inspectable hours later; setting `store: false` would
   trade away the forensic channel.

### 3.1 The shared output cap is implicated — measured 2026-09-16

The questions that failed were recovered from the harness's own session log
(the one `scripts/probe-run-timeline.mjs` decodes), so the retry is an exact
reproduction rather than a similar-looking prompt. Each question was run twice
through the documented background flow — once with the cap this plugin actually
sends, once with `max_output_tokens` omitted so the preset's own budget applies:

```
node scripts/probe-reasoning-only.mjs --input-file <question> --preset <name> --caps 2048,none
```

These are live, billable runs.

| real question | preset | arm | status | answer chars | output tokens (reasoning) | search batches |
|---|---|---|---|---|---|---|
| A (1322 ch) | high | cap 2048 | **`incomplete`** | **0** | none reported | 20 |
| A (1322 ch) | high | no cap | `completed` | 24 496 | 11 054 (2 718) | 27 |
| C (898 ch) | high | cap 2048 | **`failed` + `model_error` (reasoning_only)** | **0** | none reported | 16 (+11 URL fetches) |
| C (898 ch) | high | no cap | `completed` | 14 894 | 8 343 (2 096) | 22 (+11 URL fetches) |
| D (577 ch) | medium | cap 2048 | `completed` | 3 098 | 2 679 (977) | 9 |
| D (577 ch) | medium | no cap | `completed` | 11 095 | 4 196 (647) | 13 |
| B (524 ch) | medium | cap 2048 | `completed` | 2 120 | 2 514 (839) | 13 |
| B (524 ch) | medium | no cap | `completed` | 11 809 | 4 443 (692) | 10 |

Confirmed by this measurement:

- **On `high`, 2 of 2 capped runs produced no answer; 2 of 2 uncapped runs
  answered fully.** One capped run reproduced the incident *exactly* — `failed`
  with `model_error` and the upstream sentence `echolot: model produced no usable
  answer: no usable answer (reasoning_only)` — and the other ended `incomplete`
  (the documented truncation status). Both came back with **zero** `message`
  items, no answer and **no reported usage**, after completing their retrieval.
  The `failed`/`model_error` shape is therefore reproducible on demand. Why the
  same underlying condition surfaces as `incomplete` in one run and `failed` in
  another is an upstream question (§6).
- **The cap binds on both presets.** On `medium` the cap did not kill the run,
  but it shrank the answer to roughly a quarter: 2 120 vs 11 809 characters, and
  3 098 vs 11 095. On `high` it needed 8 343–11 054 output tokens — four to five
  times the cap.
- **Reasoning counts inside the budget.** The uncapped `high` run spent 2 718 of
  its 11 054 output tokens on reasoning
  (`output_tokens_details.reasoning_tokens`), which is exactly why a 2 048-token
  budget spread over a 15-step research loop can be gone before the final
  message is written.
- The cap is not enforced as a hard ceiling (the capped `medium` run reported
  2 514 output tokens against a 2 048 cap), but "not enforced exactly" is not
  "not binding".

Why the earlier measurement misled: it used a narrow synthetic question whose
answer fit under the cap, and the run passed. The real incident questions are
broad — 11k output tokens' worth of answer — which is precisely where a
2 048-token budget decides the outcome.

**Implemented 2026-09-16:**

1. **`perplexity_research` no longer sends the shared cap.**
   `agentRequestBody` and `agentImageRequestBody` take
   `{ applyMaxTokens: false }` and the research tool passes it, so each preset's
   own budget (128000 for `medium`/`high`/`wide-research`) applies. No new
   setting, no client change. The cost consequence, stated plainly: a research
   answer is now 4–6× longer and a `high` run takes ~5 minutes rather than ending
   early, so per-call token cost rises.
2. **`web_search` keeps the cap deliberately.** Short answers are that tool's
   point, its soft deadline bounds the run anyway (a too-slow `medium` search
   degrades to `fast`), and it has not been observed failing this way. The
   exposure is shared, so this is a decision to revisit if it ever is.
3. If a knob is wanted later, a separate `researchMaxTokens` setting would touch
   the config schema, the settings card, both locale dictionaries and the README.

Tests pin the asymmetry: `test/research.test.mjs` block 11 asserts that the
research body carries no `max_output_tokens` while the `web_search` body still
carries the configured cap, and `test/image-input.test.mjs` keeps the
image-search cap.

**Corrected verdict.** This record first listed the cap as *not* the cause and
therefore left it alone. That was wrong: it generalized from a narrow synthetic
question whose answer fit under the cap. Tested against the real incident
questions, the `reasoning_only` failure is **reproducible on demand** by our own
request parameter and **disappears** when it is removed — a local defect with a
local fix, not only an upstream outage.

## 4. Decision: no degraded-preset fallback for research

`web_search` degrades to `fast` when its own soft deadline expires.
`perplexity_research` has no fallback and now fails as a classified error. The
question was whether a model-stage no-output failure should retry on a shallower
preset. **Decision: no.** The argument, in the order that decided it:

1. **A shallower preset is not a different reasoning path.** Per
   [Presets](https://docs.perplexity.ai/docs/agent-api/presets.md), `fast` and
   `low` are the same model family with `reasoning: { effort: "minimal" }` and
   `max_steps: 1`/`5`; `medium` and `high` use `effort: "medium"` with
   `max_steps: 15`. Less effort and fewer steps is a *reduced exposure* to
   spending the output budget on reasoning, not a documented way around it.
   Nothing in the API description says a shallower preset bypasses the failure.
2. **It would stack on the existing unbilled retry.** Attempt 1 (requested
   preset) → retry (requested preset) → fallback (shallow) is up to three full
   research runs inside one tool call, on a tool whose entire reason to exist is
   its own long budget. The retry loop already refuses a further attempt when
   less than half the budget remains, so the fallback would usually be forbidden
   by the deadline arithmetic anyway — added branches, no coverage.
3. **The evidence is preset-independent.** `medium` and `high` both failed, with
   both error codes. There is no measured basis for "go shallower and it works".
4. **The documented remedy for availability is server-side.** `models: [...]`
   (up to 5, tried in order, `response.model` names the winner, billing follows
   the winner) is failover *inside one request*
   ([Model Fallback](https://docs.perplexity.ai/docs/agent-api/model-fallback.md)),
   so it adds no second client-side run to the budget. It is the one fallback
   worth pursuing — but only after upstream answers whether it applies to a
   model-stage no-output failure and whether it may be combined with `preset`.
   Adding a chain we cannot show works would be a guess wearing a fix's clothes.

What was adopted instead: the classified error (this change), and an upstream
report (`upstream-report-model-no-output.md`) so the fault is fixed where it
lives rather than papered over here.

### 4.1 Default research depth lowered to `low`

Recorded here because it is the same cost/latency fact §3.1 measured, applied to
the default. `RESEARCH_DEFAULT_DEPTH` was `medium`; it is now `low`, and `low` is
offered as a depth at all (it previously was not — only `medium`, `high`,
`wide`). A default is what most calls get, and an uncapped `high` run measurably
cost ~5 minutes and 8 343–11 054 output tokens where `low` answers in seconds, so
depth is now an explicit request rather than something a caller drifts into. The
tool schema, the system-prompt guidance and the skill were updated to say so, and
`high` remains available for an explicit request or a configured default.

A new setting, `researchDepth`, pins the default for a deployment (`low` when
blank or unrecognized). It is read **per call**, unlike `researchTimeoutMs` which
is read once at registration — a deliberate difference, because the depth decides
the shape of the request rather than the registration of the tool. Tests:
`test/research.test.mjs` block 2.

## 5. The `created_at` anomaly: resolved, and it was ours

The five runs' `created_at` values sat in one 11-second window
(2026-09-16T14:47:04Z–14:47:15Z), while the calls were believed to span about an
hour. The recorded hypothesis was server-side queueing: the API accepted the
requests during a degrading period and drained the backlog at 22:47 local.

**That hypothesis is refuted by local evidence.** DSH's own session log
(`~/.dsh/sessions/--C-Users-Administrator--/session-4c05e870-…`), which stores one
timestamped event per tool result, records the five run ids arriving as **failed
tool results** at:

| run id | local time the failure reached the harness |
|---|---|
| `resp_a15e2273-…` | 21:26:55 |
| `resp_fca3947a-…` | 22:20:52 |
| `resp_f7c6c900-…` | 22:28:31 |
| `resp_08f5e990-…` | 22:31:50 |
| `resp_0f9b7afc-…` | 22:41:42 |

That is a ~75-minute spread — consistent with the calls spanning an hour — and
**every one of them preceded the `created_at` timestamps**. The probe's own tool
call went out at **22:47:04.1** and returned at **22:47:16.8**; the five
`created_at` values (22:47:04, :07, :09, :11, :15) fall inside that 12.7-second
window, strictly increasing in the same order as the probe's five sequential
GETs.

Conclusion: for these retrieved `failed` snapshots, `created_at` tracks the
**retrieval**, not the original submission. The 11-second cluster is an artifact
of our own forensic GET loop. `created_at` must not be used as a submission-time
timeline for a stored run.

- **Confirmed by local evidence:** the run ids were reported to the caller before
  their `created_at`; the `created_at` order and spacing match the probe's GET
  order and window. Reproduce with `node scripts/probe-run-timeline.mjs <ids…>`.
- **Engineering inference:** the API stamps (or regenerates) a retrieved
  `failed` snapshot at retrieval time. Whether that is deliberate or a defect is
  an upstream question, not something this repository can establish.

## 6. Open questions (upstream)

1. Is a model-stage failure with `usage: null`, `status: failed` and no `message`
   item meant to be retried by the client at all, or is the run id the only
   recourse?
2. Does the `models` fallback chain cover this failure class, and may `models` be
   combined with `preset`? (The schema documents `models` as taking precedence
   over `model`; whether a preset's model is overridden by a chain is not stated.)
3. Does `max_output_tokens` bound reasoning tokens as well as answer tokens
   (our own measurement says it covers both: 2 718 of 11 054 output tokens were
   reasoning, §3.1), and is overriding a preset's own `max_output_tokens`
   (128000 for `medium`/`high`) a supported request? A cap that can starve the
   final answer should be documented as such.
4. When a run's output budget is exhausted before the final message, why does it
   surface as `failed` with `model_error`/`invalid_request` in one case and as
   `incomplete` in another (§3.1)? Both shapes leave a client with zero answer
   and, in the runs observed, no `usage` to account for the work.
4. Why does a retrieved `failed` run report `created_at` at retrieval time rather
   than at creation? (See §5.)
5. Can the API expose the distinction "retrieval completed, model emitted
   nothing" as a status or error code, so clients need not infer it from the
   absence of a `message` item?

## References

- [Presets](https://docs.perplexity.ai/docs/agent-api/presets.md) — dynamic,
  unversioned presets; current values per preset; `reasoning.effort`.
- [Background Mode](https://docs.perplexity.ai/docs/agent-api/background-mode.md)
  — submit/poll/cancel, terminal statuses.
- [Model Fallback](https://docs.perplexity.ai/docs/agent-api/model-fallback.md) —
  the `models` chain.
- [Create Agent Response](https://docs.perplexity.ai/api-reference/agent-post.md)
  — request/response schema, `max_output_tokens`, `reasoning`, `store`.
- In-repo: `src/agent-run.js` (`AgentModelNoOutputError`,
  `isModelNoOutputFailure`, `summarizeAgentOutput`),
  `test/agent-model-failure.test.mjs`, `scripts/probe-failed-run.mjs`,
  `scripts/probe-run-timeline.mjs`.
