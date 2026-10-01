# Changelog

Notable changes to `@shjwudp/dsh-web-search-perplexity`, newest first. Entries
describe behaviour, not commits; the `v*` tags carry the full history.

## v0.2.0-rc.1

**Compatible with DSH 0.2.0-rc.2** (`@deepseek-ai/dsh-web` / `@deepseek-ai/dsh-tools`
0.2.0-rc.2, `@deepseek-ai/schemastery` 3.18.4). Requires DSH **0.2.0-rc.2 or newer
within 0.2.x**; use v0.1.7-rc.2 for DSH 0.1.x.

A release candidate that ports the plugin to **DSH 0.2**, which replaced the
per-plugin settings section with Loader-entry configuration. The plugin did not
merely warn on 0.2.0-rc.2: its `apply()` threw
`settingsCtx.settings.installSection is not a function` and the entry never
activated, so neither the search providers nor `perplexity_research` existed.
DSH 0.1.x is no longer supported by this line — the settings API it used is
gone, and no compatibility branch was kept for it.

### Changed

- **Configuration is now the profile entry's config.** The plugin exports its
  `Config` schema (DSH derives an entry's settings page from the loaded module's
  `Config` export) and every field is `volatile()`, which is what resolves it
  into a live reference the plugin reads through `liveConfig()`. The
  `settings.installSection` call, the `setSource`/`onChange` hooks, and the
  per-plugin namespace are all gone. A committed edit now restarts the entry, so
  the `enabled` master switch is applied from the config each `apply` sees — and
  the seam id it releases is remembered **beside `ctx.web`** rather than in
  `apply`'s closure, because a restart would otherwise forget the id and could
  never give it back.
- **The settings card is one tab of Settings → Built-in plugins**, registered
  into `settings.plugins.tab` and backed by `ctx.configForms.get(...)` instead of
  the removed `settingsScope` / `settings.plugin.item` pair. `whileServed` keeps
  the tab absent in a deployment that installed the package without composing its
  row, rather than showing a page that can only say "unavailable". The card's
  behaviour is otherwise unchanged: same fields, same Save/Discard model, same
  write-only API key.
- **`apiKey` is the one non-volatile field.** DSH's generated form renders
  exactly the volatile fields and persists a form write into the profile's
  `cordis.patch.yml`; leaving the literal key out of that form is what keeps the
  plugin's existing promise that the key lives in the credentials domain and
  never in a patch file. A hand-written `apiKey` in the patch is still honoured.
- **Settings moved from `~/.dsh/settings.yaml` to the profile patch.** DSH 0.2
  removed that document; a `web-search-perplexity` section in a surviving
  `settings.yaml.imported` has to be restated as `config:` on the plugin's row in
  `~/.dsh/profiles/<profile>/cordis.patch.yml`.
- Peer dependencies moved to `^0.2.0-rc.2`, which is what DSH's compatibility
  gate reads: the plugin now installs into a 0.2.0-rc.2 profile with no
  exact-version exemption.

### Fixed

- **`apply()` threw `settingsCtx.settings.installSection is not a function` on
  DSH 0.2**, leaving the entry unactivated and both `web_search` backends and
  `perplexity_research` unregistered.
- **The version gate rejected the package on DSH 0.2.0-rc.2** with
  `peerDependencies {"@deepseek-ai/dsh-web":"^0.1.2-rc.1"}`.

### Verification

`npm test` — 11 suites, 0 failures; `npm run check` clean. Booted an isolated
0.2.0-rc.2 profile with the plugin mounted: `stderr` is empty and every entry
activates (a deliberately broken copy of the same tree prints
`dsh: warning: 1 entry did not activate`, which is the signal being ruled out).
The client half is composed into the served bundle.

Verified live on DSH 0.2.0-rc.2, with the plugin mounted in a profile and a
Perplexity key in the host environment:

- `web_search` is served by this provider, and answered under the migrated
  `preset: medium` / `softTimeoutMs: 40000` — the result carried this plugin's
  own `[DEGRADED] {...}` marker, which no other provider emits.
- `perplexity_research` answered, with the configured `researchDepth: medium`
  visible as its default depth.
- A committed settings edit reached the running plugin without a restart: setting
  `enabled: false` made `perplexity_research` refuse within seconds, and
  restoring it lifted the refusal.
- Pinning `web.searchProvider` to a backend this plugin reports unusable made the
  seam answer `configured web provider "perplexity" is registered but
  unavailable`, confirming the selection is this plugin's.

## v0.1.7-rc.2

A release candidate. It fixes saving the API key and adds a way to hand search
back to the composition's own provider without uninstalling the plugin.

### Added

- **An `enabled` master switch**, led by a one-click button at the top of the
  settings card: *Disable Perplexity, use built-in search* / *Enable Perplexity
  search*. While it is off the plugin releases the seam's configured provider id
  (`ctx.web.searchProviderId`), so the composition's own provider — the shipped
  `deepseek-official` — serves `web_search` again, and both Perplexity backends
  report themselves unusable. Releasing the id is what makes it work: the seam
  answers a configured-but-unavailable provider by throwing
  (`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`), never by falling back. The released id
  is remembered, so re-enabling restores exactly what the deployment had
  configured rather than assuming `perplexity`. The switch is durable, applies to
  the next call without a restart, writes without going through Save/Discard so
  unrelated drafts are untouched, and also makes `perplexity_research` refuse —
  a plugin the user turned off should stop issuing requests and billing them.

### Fixed

- **Saving the API key failed with `cannot get property "remote" without
  inject`.** The browser half read the parent `ctx.remote` service while
  declaring only the `remote.credentials` namespace. Cordis registers
  `remote.credentials` as a service of its own, so injecting the namespace never
  covered `remote`. The card still rendered because the constructor's credential
  read swallows its own errors; only Save surfaced it. `exports.inject` now names
  `remote` as well, which is what the host's own plugin-configuration card does.

### Changed

- **The button hides itself until the Host half declares `enabled`**, so a browser
  half that reloads ahead of a DSH restart cannot offer a control that would fail.
  The Host HMR watcher ignores `node_modules/`, so that window is the normal case
  rather than an edge one.

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
