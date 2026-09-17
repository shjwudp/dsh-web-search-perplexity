# Changelog

Notable changes to `@shjwudp/dsh-web-search-perplexity`, newest first. Entries
describe behaviour, not commits; the `v*` tags carry the full history.

## v0.1.7-rc.1

A release candidate. It replaces the plugin's backend wholesale and is not a
drop-in for 0.1.6: the Sonar Chat Completions API is gone.

### Added

- **`perplexity_research` tool** — one focused question, researched over
  `medium`, and up to `high` or `wide`, on a budget of its own (30 minutes by
  default, `researchTimeoutMs`) rather than `tool-web`'s. `depth` defaults to
  `low` and can be set per deployment with `researchDepth`.
- **Search API backend** (`POST /search`), selectable with
  `searchProvider: perplexity-search`: ranked results with the endpoint's own
  filters (domains, languages, country, publication dates, recency, result
  count, per-page content budget). It returns sources and no generated answer.
- **Image input** on the Agent API: a query naming a local image file or a public
  `https://` image URL is sent as an `input_image` part beside its text question,
  guarded by media-type, signature, size, and `imageRoots` checks.
- **Machine-readable result markers**, because `content` is the only field
  `dsh-tool-web` forwards: `[DEGRADED] {json}` for a degraded answer and
  `[IMAGE] {json}` / `[SEARCH] {json}` to name what answered.
- **A `degradation` object on the seam result** — `degraded`,
  `requestedPreset`, `actualPreset`, `softTimeoutMs` — so a direct
  `ctx.web.search` caller can tell a full-depth answer from a shallow retry
  without reading prose.
- **An independent failure class for a model-stage no-output run**
  (`AgentModelNoOutputError`): it names the upstream `error.code`, the run id,
  how much retrieval completed, that zero answer messages came back, and whether
  anything was billed — and states that it is neither a rate limit nor a
  connection failure.

### Changed

- **Long runs submit in the background and poll** (`background: true`, then
  `GET /v1/agent/{id}`), for `web_search` and `perplexity_research` alike. A
  synchronous request held one connection for the whole run and the network
  closed it first — measured at ~180 s with
  `fetch failed <- SocketError: other side closed`. A polled run also lets an
  expired call cancel what it can no longer wait for, instead of abandoning it.
- **`softTimeoutMs` unset is now derived from the configured `preset`** rather
  than being one flat constant: `fast`/`low` `12000`, and
  `medium`/`high`/`xhigh`/`wide-research`/unset `40000`. The previous flat
  `25000` sat below `medium`'s own measured 25.3 s narrow latency, so *every*
  `medium` narrow query degraded. An explicit value still wins, and `0` still
  disables the deadline.
- **`perplexity_research` sends no `max_output_tokens`**, leaving the output
  budget to the preset, which is sized for its own job. On a 2048-token cap the
  incident's own `high` questions reproducibly ended with no answer at all.
- **A 429's diagnostics are reported on two tracks**: the message names the HTTP
  status, the attempts made of the budget, the elapsed time, the backoff spent
  and whether `Retry-After` was sent, and then preserves the upstream sentence
  verbatim; the same facts are also attached to the error as fields.
- **`truncated` now reflects the API's `incomplete` status** instead of being
  hardcoded `false` next to a prose line saying the answer was truncated.

### Fixed

- **A connection failure says what failed**: the full `cause` chain with its
  `code`/`errno`/`syscall`, the endpoint, the HTTP method actually used, and the
  process (`pid`, uptime, start time, Node version, redacted proxy variables).
- **A failed run is retried at most once, and only when nothing was produced**:
  the gate is the API reporting `status: failed` with `usage: null`, so a resend
  cannot duplicate or re-bill work.
- **An exhausted 429 no longer loses its status code**: the retry budget, the
  capped wait, and the server's own `Retry-After` are all reported, and a
  deliberate `retries = 0` no longer reads the same as a budget that ran out.
- **A cancelling call cancels its remote run** and names the id, so a run that
  was already paid for can still be collected.
- **`Retry-After` is quoted only from the response that ended the call**, never
  from an earlier 429 in the same retry chain.
- **The image extension is read from the file name**, so a dot in a directory
  name (`shots.v2/attachment-object`) no longer hides an extensionless image.
- **The README install pin is checked against `package.json`**, and so is
  `USER_AGENT`; both had drifted before and nothing caught it.

### Removed

- **The Sonar Chat Completions backend and the `apiMode` switch.** Both agent
  paths now use the Agent API, which is the API Perplexity replaced Sonar with —
  Sonar stays supported until 2026-09-27, which is why no fallback is kept.
