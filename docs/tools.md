# The two tools

The plugin contributes one tool, `perplexity_research`, and supplies the search
provider behind `web_search`. Both reach Perplexity through the same code path, so
they submit, poll, cancel, and report failures identically — they differ in budget
and in what you should ask them.

| | `web_search` | `perplexity_research` |
|---|---|---|
| Budget | `tool-web.searchTimeoutMs` (60 s under the shipped presets) | `researchTimeoutMs` (default 30 minutes) |
| Input | 1–4 queries | one focused question, plus a depth |
| Preset | the configured one | chosen by `depth` |
| Output budget | `maxTokens` (`max_output_tokens`) | the preset's own (128000 for `medium`/`high`); `maxTokens` does **not** apply |
| Backend | Agent or Search API | Agent API only |
| Use it for | quick facts, several lookups | one question needing many sources or many rounds |

`perplexity_research` exists because `web_search` cannot run a minutes-long
question: its budget is `tool-web.searchTimeoutMs`, and that row lives in each
session's agent preset, which a plugin cannot reach. A tool declares its own
`timeoutMs` — enforced by `@deepseek-ai/dsh-tool-call-timeout-policy` — so this
tool carries its own budget and never runs through `tool-web`'s.

It is registered through `ctx.tools`, so it is available in every session of a
profile that mounts this plugin, including sessions composed from an agent preset.
`researchTimeoutMs` is read once, when the tool registers, so changing it takes
effect on the next DSH start; `researchDepth` is read on every call. `0` declares
no deadline at all.

A long call is still a *synchronous* call: nothing is streamed while it runs. If
you need unattended research that outlives a turn, that is the Agent API's
`background` mode and would be a different tool shape (submit, then collect).

## Choosing a depth

`depth` selects the Agent preset:

| `depth` | Preset | What it is for |
|---|---|---|
| `low` | `low` | Light multi-step lookups. **The default.** Answers in seconds |
| `medium` | `medium` | Multi-hop browsing: chains evidence across sources over several rounds |
| `high` | `high` | Exhaustive coverage. The longest reasoning, and the slowest |
| `wide` | `wide-research` | Large evidence-backed collections, researched item by item. Minutes-long |

The default is `low` on purpose: a default is what most calls get, and depth is not
free. Measured against the live API on this plugin's own incident questions, an
uncapped `high` run took ~5 minutes and spent 8 343–11 054 output tokens, where
`low` answers in seconds. Ask for `medium` when the question genuinely needs
several rounds, `high` when it is exhaustive, and `wide` when the answer needs a
large collection. A deployment can change the default with `researchDepth`.

## Why research is not capped by `maxTokens`

A preset is sized for its own job, and overriding that budget with the shared cap
starves a multi-step run. Measured 2026-09-16 against the live API, on the very
questions whose runs had failed, a 2048-token cap made a `high` research run end
with **no answer at all** — once as `incomplete` (the API's truncation status) and
once as `failed` + `model_error … (reasoning_only)`, the incident's exact error —
while the same question with the budget left to the preset answered fully
(8 343–11 054 output tokens, 2 096–2 718 of them reasoning).

This is our own measurement rather than documented API behavior: no Perplexity page
states that `max_output_tokens` covers reasoning tokens, so the mechanism is
inferred from these runs rather than quoted from the docs. Even when the cap did not
kill the run it cut the answer to roughly a quarter of its length.

`web_search` keeps the cap: a short answer is that tool's point. The full A/B is in
[model-stage-no-output.md](model-stage-no-output.md) §3.1.

## The background lifecycle

Every agent-backed call — `web_search` and `perplexity_research` alike — submits
with `background: true` and then polls `GET /v1/agent/{id}`. A run is terminal when
its `status` is `completed`, `failed`, `cancelled`, or `incomplete`; `queued` and
`in_progress` are the two non-terminal states. Submitting in the background is what
keeps a minutes-long run from depending on one long-lived connection, which the
network closes first.

When a deadline expires, the plugin cancels the run it can no longer wait for with
`POST /v1/agent/{id}/cancel`, and names the id in the error, so a run that was
already paid for can still be collected with `GET /v1/agent/{id}`.

That cancel call is deliberately best-effort and its failures are swallowed — the
run may be collectable later by id, and the caller is already receiving the reason
the call ended early. Two documented responses are therefore worth knowing, because
a swallowed failure is otherwise invisible:

- cancelling a run that has already reached a terminal status returns `400`, which
  is expected rather than a fault;
- an unknown id, or one belonging to another account, returns `404`.

A `200` acknowledges asynchronously with `status: "cancelling"`; the run stops
shortly after.

## Response mapping

Agent API:

- `content` ← the answer, joined from the `output_text` parts of the `output[]` item
  whose `type` is `message`
- `sources[]` ← `search_results[].results[]` plus `fetch_url_results[].contents[]`
  (`url`, `title`, `snippet`, `publishedAt` from `date`), deduplicated by URL
- `truncated` ← `true` when the response's `status` is `incomplete`, the API's own
  truncation signal; the content also carries a line saying so

Search API: `sources[]` ← `results[]`, and there is no generated answer, so
`content` is only the `[SEARCH]` marker and `truncated` is always `false`.

Neither backend reads a top-level `citations[]` array: that was the Sonar Chat
Completions shape, which is no longer used. HTTP redirects are rejected, and
failures surface as `WebError` with `WEB_PROVIDER_ERROR` (or `WEB_ABORTED` for
abort signals) — see [failures](failures.md).
