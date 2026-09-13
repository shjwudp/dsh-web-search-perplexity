# @shjwudp/dsh-web-search-perplexity

Standalone Perplexity search provider for the DeepSeek Harness web seam
(`ctx.web`). It registers search providers for Perplexity, contributes one
long-research tool, and ships two interchangeable backends:

- **Agent API** (`POST /v1/agent`, default) — a model-generated, cited answer plus
  its `search_results[]`, and image input.
- **Search API** (`POST /search`) — ranked `results[]` with titles, URLs, snippets,
  and dates, no generated answer, and the filters that endpoint publishes
  (domains, languages, country, publication dates, recency, result count).

Both map onto the seam's normalized `WebSearchResult`. Text questions and images
go through the Agent API; the Search API is search-only by design.

This package exists because the official
`@deepseek-ai/dsh-web-search-perplexity` package imports
`@deepseek-ai/dsh-environment`, which is not published on the npm registry
(E404) for current dsh releases. This plugin has no internal-only
dependencies.

## Compatibility

- Tested with **DSH 0.1.5-rc.2** (`@deepseek-ai/dsh-web` 0.1.5-rc.2,
  `@deepseek-ai/schemastery` 3.18.2). The host version numbers below are DSH's,
  not this plugin's; this package's own versions are the `v*` tags.
- Peer dependencies: `@deepseek-ai/dsh-tools: ^0.1.2-rc.1`,
  `@deepseek-ai/dsh-web: ^0.1.2-rc.1`,
  `@deepseek-ai/schemastery: ^3.18.1-rc.1`. The declared range is unchanged and
  its lower bound is where this plugin was first written, so an older 0.1.2-rc.x
  host satisfies it too.
- Requires a DSH profile with the `ctx.web` seam mounted and the model-facing
  tools `web_search` / `web_fetch` enabled (`dsh-tool-web`). In the `web`
  profile, `dsh-tool-web` is disabled by the web-app layer by default; enable
  it with `- id: tool-web, disabled: false` in the profile patch.
- Injects `web`, `tools`, and `systemPrompt`. The latter two are required since
  the plugin also contributes the `perplexity_research` tool; a composition
  without either registry fails at load with a message naming the missing
  service rather than registering nothing.
- Node ≥ 18
- The settings card's translations are registered through the client locale
  service (`ctx.locale.register`, `@deepseek-ai/dsh-client-locale`). On a host
  without that service the card falls back to English instead of failing, so the
  plugin stays usable but untranslated.
- `web_search` applies its own tool budget (`dsh-tool-web`'s `searchTimeoutMs`,
  30000 by default, 60000 under the shipped agent presets). The soft deadline
  and its degraded retry are derived to stay inside it — see
  [Timeouts and latency](#timeouts-and-latency).

## Install

```bash
dsh plugin --profile web add github:shjwudp/dsh-web-search-perplexity#v0.1.6-rc.1
```

Then tell the web seam to use the Perplexity provider in
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: perplexity
    fetchProvider: http
```

Set the API key either in the terminal that starts DSH, or later in the web UI
(Settings → Plugins → Plugin configuration → Perplexity web search). Never put
it in a patch file:

```powershell
# Windows PowerShell
$env:PERPLEXITY_API_KEY = "pplx-..."
```

```bash
# macOS / Linux (bash/zsh)
export PERPLEXITY_API_KEY="pplx-..."
```

Restart DSH. The plugin registers both backends — `perplexity` (Agent API) and
`perplexity-search` (Search API) — but only the selected one reports itself
usable, so the seam never sees two candidates. The model-facing tools remain the
standard `web_search` / `web_fetch` from `dsh-tool-web`.

## Choosing a backend

| | Agent API (default) | Search API |
|---|---|---|
| Endpoint | `POST /v1/agent` | `POST /search` |
| Returns | generated answer + `search_results[]` | ranked `results[]` only |
| `content` | the answer | a `[SEARCH]` marker line, no answer |
| Result count | none on the wire; the seam truncates | native `max_results` (1–20 web, 1–50 people) |
| Images | yes (`input_image`) | no |
| Latency (measured) | ~4 s `fast` … ~25 s `medium` narrow | ~1–4 s |
| Extra filters | recency (via the `web_search` tool) | domains, languages, country, publication dates, recency, `search_type: people` |

Pick the Agent API when the model should get a synthesized, cited answer, or when
it must read an image. Pick the Search API when you want raw ranked hits with
control over result count and filtering, and intend to read the pages yourself.

Set `searchProvider` to `perplexity-search` to switch; leave it blank (or set
`perplexity`) to keep the Agent API. In a profile patch:

```yaml
- id: web-search-perplexity
  config:
    searchProvider: perplexity-search
    searchDomains: [docs.perplexity.ai, arxiv.org]
    searchContextSize: medium
```

The two backends are mutually exclusive by construction: while `perplexity-search`
is selected the Agent provider reports itself unusable, because the seam refuses a
call when more than one registered provider is usable.

### The Search API backend

- **No generated answer.** `content` carries one machine-readable marker line,
  `[SEARCH] {"provider":"perplexity-search","sources":8}`, and the sources carry
  the endpoint's snippets. `web_search` renders those snippets to the model, which
  is expected to read and reconcile them rather than cite an answer.
- **`max_results` is native.** The seam's `maxResults` is forwarded, bounded by
  what the endpoint accepts for the configured `searchType` (20 for web, 50 for
  people). The seam still truncates on the way back.
- **`search_context_size` is web-only.** A people search that carries it is
  rejected with `Invalid request`, so the backend omits it for `searchType:
  people`.
- **Invalid filters are dropped, not sent.** A malformed country code, language
  code, or date is omitted rather than forwarded, because the endpoint answers a
  bad filter with `422`. Dates must be `MM/DD/YYYY`; domains are capped at 20 and
  language codes at 20 two-letter codes.
- **Images are unsupported.** With this backend selected, an image query is sent
  as ordinary search text; there is no `input_image` on this endpoint.

A live smoke test for this backend:

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
$env:PERPLEXITY_API_KEY = "pplx-..."
$env:PPLX_TYPE = "people"          # optional: web (default) or people
$env:PPLX_RECENCY = "month"        # optional
node C:\path\to\repo\scripts\live-search-api-check.mjs "your query"
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | unset | Literal Perplexity API key (secret role; normally configured in the UI instead) |
| `apiKeyEnv` | `PERPLEXITY_API_KEY` | Credential reference used by the UI-stored key |
| `preset` | unset | Dynamic preset `fast`, `low`, `medium`, `high`, `xhigh`, or `wide-research`. When set, Perplexity picks the model; `model` is only sent as an override if it is a `provider/model` slug. |
| `baseURL` | `https://api.perplexity.ai` | Endpoint base; `/v1/agent` is appended |
| `model` | `openai/gpt-5.6-luna` | Agent API model id (`provider/model`, e.g. `openai/gpt-5.6-sol`). Used when no preset is set; a value without `/` falls back to the default |
| `maxTokens` | `1024` | `max_output_tokens` for the generated answer |
| `searchRecency` | unset | Recency window for the search tool's filter: `day`, `week`, `month`, or `year`. Unset sends no filter |
| `softTimeoutMs` | per preset, or 40 s for the Search API | One deadline for both backends. On the Agent API it bounds one search before one degraded retry; on the Search API it bounds the request. `0` disables it. Unset = derived from the configured `preset` (`fast`/`low` `12000`; `medium`/`high`/`xhigh`/`wide-research`/unset `40000`). `0` disables it. Keep `softTimeoutMs` + 15 s below the tool budget. |
| `fallbackPreset` | `fast` | Preset used for the single degraded retry (any preset except `wide-research`) |
| `imageInput` | enabled | Image input. Only the literal `off`/`false`/`0` disables it |
| `imageMaxBytes` | `10485760` | Per-image byte ceiling for a local image; an oversized image is refused before it is read |
| `imageRoots` | `[]` (no restriction) | Directory allowlist for local image reads; a path outside every entry is refused |
| `researchTimeoutMs` | `600000` | Budget for one `perplexity_research` call, independent of `tool-web`'s search budget. `0` declares no deadline. Read once when the tool registers, so a change takes effect on the next DSH start |
| `searchProvider` | `''` (Agent API) | Which backend serves searches: blank or `perplexity` = Agent API; `perplexity-search` = Search API. Only the selected one is usable |
| `searchType` | `web` | Search API only: `web` or `people`. `people` also raises the result bound to 50 |
| `searchDomains` | `[]` | Search API only: up to 20 domains or URLs to restrict results to |
| `searchLanguages` | `[]` | Search API only: up to 20 two-letter ISO 639-1 codes; sent lowercased |
| `searchCountry` | unset | Search API only: two-letter ISO 3166-1 code, sent uppercased |
| `searchContextSize` | `medium` | Search API only: `low`, `medium`, or `high` — how much page content each result returns. Omitted for `searchType: people`, which rejects it |
| `searchMaxTokensPerPage` | unset | Search API only: explicit per-page content budget (`max_tokens_per_page`) |
| `searchAfterDate` / `searchBeforeDate` | unset | Search API only: publication-date window as `MM/DD/YYYY` |

> **Only the Agent API and the Search API are used.** Perplexity deprecated its
> Sonar Chat Completions API (supported only until **2026-09-27**) in favor of the
> Agent API, so this plugin has no `apiMode` switch. `searchRecency` works on both
> backends: on the Agent API the window belongs to the `web_search` tool and is
> sent as `tools[].filters.search_recency_filter` (`day`/`week`/`month`/`year`);
> on the Search API it is a top-level field and additionally accepts `hour`.

The provider resolves the API key in this order:

1. a literal `apiKey` config value (not recommended);
2. the credentials domain entry named by `apiKeyEnv` — this is what the web UI
   writes when you save the key in the Perplexity card;
3. the `PERPLEXITY_API_KEY` process environment variable.

The bundled patch layer deliberately does NOT list `apiKey`; the UI or the
environment variable are the intended key sources.

## Image input

The provider can send an image to Perplexity for analysis, the same way the
Perplexity clients accept an attachment. `dsh-tool-web` gives a provider only
`request.query`, so an image reaches it as a query string:

- a public `https://` image URL ending in `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`,
  passed to Perplexity as the image URL, or
- an absolute path of a local image file, read and sent as a base64 data URI.

A second query in the same call is the text question; with no other query the
provider asks for an analysis of what the image shows.

```js
web_search({ queries: ['C:/Users/me/Pictures/board.png', 'identify this board and its documented pinout'] })
```

Reproduce the live path without a model in the loop — the key is resolved
through the same credential chain the provider uses (environment, then the
stored credential), and is never printed:

```powershell
$env:PERPLEXITY_API_KEY = "pplx-..."
node scripts/live-image-check.mjs            # optional 2nd arg: a model id
```

The image travels as `input_image` parts beside the `input_text` question inside
`/v1/agent`'s `input` array. Allowlisted formats and the 50 MB per-image cap are
Perplexity's; `imageMaxBytes` is enforced before the file is read.

Three rules keep this from becoming a file-exfiltration path:

1. **Only images are read.** A file is sent only when its extension names an
   image, its bytes really are that format (PNG/JPEG/GIF/WEBP signature check),
   and it is within `imageMaxBytes`. A `.png` holding something else is refused
   with an error rather than uploaded; a file with a non-image extension is left
   alone and treated as ordinary search text.
2. **`imageRoots` confines reads.** With entries configured, a path outside every
   entry is refused before any read, so a research session cannot walk the disk
   on its own.
3. **A URL is never fetched locally.** An http(s) query is passed to Perplexity
   as an image URL, never downloaded by this plugin.

A URL image is only as good as its address: Perplexity fetches it server-side, so
a URL its fetcher cannot retrieve (a stale thumbnail path, a host that rejects
hotlinking, an expired signed link) fails the whole request with `invalid
request`. A local file has no such dependency, because the bytes travel with the
request.

An image-bearing request keeps the configured preset (or `model`), exactly like a
text request: there is no separate image model. Measured against the Agent API, a
preset's own model reads images correctly — `preset: fast` answers an image
question with `openai/gpt-5.6-luna` and the right answer — so one model selector
cannot disagree with itself. The one thing to know is that with no preset set,
the configured `model` must be able to read images; an image sent to a text-only
model answers badly rather than failing loudly.

The result's `content` starts with a machine-readable marker, because
`dsh-tool-web`'s closed output schema forwards nothing else:

```
[IMAGE] {"images":1,"source":["C:/Users/me/Pictures/board.png"],"bytes":48211}
```

`source` echoes the URL when the image came from the web, and `bytes` is `0`
for a URL image (nothing was uploaded by this plugin). Direct `ctx.web.search`
callers also get the same object as `images` on the seam result.

Images are slower and costlier than text: the upload precedes the analysis, and
Perplexity bills image tokens as `(width × height) / 750` on top of the text
tokens. An image request therefore gets the text deadline plus
`IMAGE_ANALYSIS_MARGIN_MS` (12 s), capped where the degraded retry still fits the
tool budget. That margin is internal on purpose: one deadline is configured, so
no configuration can pair a text deadline with an image deadline that
contradicts it.

## Long research: the `perplexity_research` tool

`web_search` cannot run a minutes-long research question: its budget is
`tool-web.searchTimeoutMs` (60 s under the shipped agent presets), and that row
lives in each session's agent preset, which a plugin cannot reach. A tool
declares its own `timeoutMs` — enforced by
`@deepseek-ai/dsh-tool-call-timeout-policy` — so this plugin contributes a second
tool that carries its own budget and never runs through `tool-web`'s.

| | `web_search` | `perplexity_research` |
|---|---|---|
| Budget | `tool-web.searchTimeoutMs` (60 s shipped) | `researchTimeoutMs` (default 600000, i.e. 10 minutes) |
| Input | 1–4 queries | one focused question, plus a depth |
| Preset | the configured one | chosen by `depth` |
| Backend | Agent or Search API | Agent API only |
| Use it for | quick facts, several lookups | one question needing many sources or many rounds |

`depth` selects the Agent preset: `medium` (multi-hop browsing, the default),
`high` (exhaustive coverage), or `wide` (`wide-research`). The default is
`medium` on purpose: it is the deepest preset whose measured latency (~25 s
narrow) still fits a synchronous call, whereas `wide-research` is a minutes-long
collection workflow and has to be asked for. Ask for `wide` when the answer needs
a large evidence-backed collection.

The tool is registered through `ctx.tools`, so it is available in every session
of a profile that mounts this plugin — including sessions composed from an agent
preset, because the preset's `tool-web` row and this tool's budget are separate
things. `researchTimeoutMs` is read once, when the tool registers, so changing it
takes effect on the next DSH start. `0` declares no deadline at all.

A long call is still a *synchronous* call: nothing is streamed while it runs. If
you need unattended research that outlives a turn, that is the Agent API's
`background` mode and would be a different tool shape (submit, then collect).

## UI surfaces

- **Plugin configuration card**: Settings → Plugins → Plugin configuration
  shows a collapsible, editable `Perplexity web search` card for the
  `web-search-perplexity` settings namespace. It opens on the choices that decide
  behaviour — `baseURL`, the backend selector (`searchProvider`), the API key,
  and then the backend's own essentials (Agent API: `preset` or `model`,
  `searchRecency`, `imageInput`; Search API: `searchType`, `searchRecency`,
  `searchContextSize`). Everything else sits behind one `Advanced settings`
  disclosure: `maxTokens`, the soft deadline and its fallback preset, and the
  image settings (`imageMaxBytes`, `imageRoots`) for the Agent API;
  `searchDomains`, `searchLanguages`, `searchCountry`, the publication-date
  window, and `searchMaxTokensPerPage` for the Search API.
  The API key is a write-only secret field either way.

## Timeouts and latency

`web_search` runs under a harness deadline (`dsh-tool-web`'s
`searchTimeoutMs`, **default 30000**; the shipped agent presets raise it to
60000, so 60 s is not a safe assumption), and the Perplexity Agent API preset
decides how long a search actually takes. Measured against the Agent API from an
ordinary desktop connection:

| preset | measured latency |
|---|---|
| `fast` | ~4 s |
| `low` | ~5 s |
| `medium` | ~25 s for a narrow query, >180 s for a broad one |
| `wide-research` | minutes; an asynchronous workflow, not a synchronous search |

A broad query on `medium` therefore outlives even a 60 s tool budget. Two guards:

1. **Soft deadline (this plugin).** `softTimeoutMs` bounds one request. When it
   expires the provider makes exactly one bounded retry on
   `fallbackPreset` (default `fast`) and returns that answer marked as degraded
   (see *Degradation is machine-readable* below). Worst case is about
   `softTimeoutMs` + 15 s, and that sum must stay below the tool budget. Set
   `softTimeoutMs: 0` to restore the original single-request behavior. The
   retry is synchronous: no background request, no pending-task table, and no
   promise outliving the tool call.

   When unset, the deadline is **derived from the configured `preset`** rather
   than being one preset-independent constant, because no single value can suit
   presets that differ by two orders of magnitude in latency:

   | `preset` | default `softTimeoutMs` | why |
   |---|---|---|
   | `fast`, `low` | `12000` | ~4–5 s measured, so 12 s leaves >2x headroom and still fits the 30 s component budget (`12 + 15 ≤ 30`) |
   | `medium`, `high`, `xhigh`, `wide-research`, unset | `40000` | `medium` needs ~25 s (25.3 s measured) for a narrow query, so anything at or below that would degrade *every* narrow query; 40 s is the largest value that still leaves the 15 s retry inside the 60 s preset budget |

   A flat default is what made degradation the norm: the previous `25000` sat
   below `medium`'s own measured 25.3 s narrow latency, so every `medium` narrow
   query spent 25 s and was then answered by a `fast` retry — strictly worse
   than either lowering the preset or raising the deadline. `medium` (and
   slower) genuinely cannot fit a 30 s budget, so under one, lower the preset
   instead of the deadline.
2. **The tool budget lives in a `tool-web` row.** A session's model-facing
   `tool-web` row is supplied by the agent preset that session joins (and falls
   back to the 30 s component default when nothing sets it), so raising
   `searchTimeoutMs` in the profile patch alone does not change the deadline a
   preset-composed session enforces. Copy the shipped composition to
   `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`, change
   `tool-web.searchTimeoutMs` there, and select that preset.

When both attempts exceed their budgets, the provider raises a `WebError` that
names the soft deadline and suggests a narrower query, instead of letting the
caller see only the harness's opaque `tool call timed out after <ms>ms`.

### Degradation is machine-readable

A degraded answer is marked twice, so no consumer has to read prose:

1. **`degradation` on the seam result** (`ctx.web.search`), present on every
   result this provider returns:

   ```json
   {
     "degraded": true,
     "requestedPreset": "medium",
     "actualPreset": "fast",
     "softTimeoutMs": 40000,
     "fallbackTimeoutMs": 15000
   }
   ```

   `degraded` is `false` with `actualPreset === requestedPreset` for a
   full-depth answer, and `fallbackTimeoutMs` is `0` unless a retry ran.
2. **A `[DEGRADED] {json}` line** as the first line of `content`, carrying the
   same object. `dsh-tool-web` re-projects the seam result into its own closed
   `web_search` output schema (`content` / `sources` / `truncated`,
   `additionalProperties: false`), so `content` is the only field that reaches
   the model; this line is what survives that boundary.

Treat a result with `degraded: true` as a shallower source: re-verify material
claims or re-ask narrowly instead of citing it as full-depth research.

## Response mapping

- `content` ← `choices[0].message.content` (the generated answer, unchanged)
- `sources[]` ← structured `search_results[]` (`url`, `title`, `snippet`,
  `publishedAt` from `date`)
- If `search_results` is absent, `sources[]` ← URL-only `citations[]`

HTTP redirects are rejected. Failures surface as `WebError` with
`WEB_PROVIDER_ERROR` (or `WEB_ABORTED` for abort signals).

## Development

```bash
npm run check        # syntax-check the host, client, and generated skill module
npm test             # stubbed-fetch host tests, then the settings card's locale dictionaries
npm run build:skill  # regenerate src/skill.js from the markdown skill source
npm run sync:profile # copy this working tree into every DSH profile that depends on it
```

`npm test` runs two suites. `test/soft-deadline.test.mjs` stubs
`globalThis.fetch`, so it never touches the network; it loads the host module
from an installed DSH profile by default (the `schemastery` and `dsh-web` peers
are not installed in a plain checkout), so set `PPLX_PLUGIN_ENTRY` to test a
different built copy. `test/client-locale.test.mjs` stubs
`window.__ModuleLoader__` and drives the real browser half, checking that the
`zh`/`en` dictionaries stay complete and that `apply` registers them.

### Installing this checkout into a profile while developing

A `file:` dependency is not reliably live. pnpm may hardlink the package into the
profile, in which case an in-place edit propagates — but an editor that writes by
replacing a file (temp file plus rename) breaks that link, and the installed copy
then silently goes stale. `pnpm add file:<repo>` does not help afterwards: once
the specifier and lockfile entry match, it is a no-op and does not refresh
contents.

So after changing `src/`, run:

```bash
npm run sync:profile                 # every profile depending on this package
npm run sync:profile -- web          # one profile, by name or directory path
```

It copies the published file set into each profile's `node_modules`, then imports
the installed package the way DSH does and compares hashes, so a broken peer
resolution or a stale copy fails the command instead of surfacing at the next DSH
start. Set `DSH_PROFILES_DIR` to override the profile root (default
`$DSH_HOME/profiles`, then `~/.dsh/profiles`).

`link:` is not an alternative: a symlink makes the plugin resolve from this
repository, where `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-web` cannot be
found, and it fails to load with `ERR_MODULE_NOT_FOUND`.

A change to `src/index.js` needs a DSH restart, because the host half is loaded
per process. `src/client.js` is re-served to the browser, so a reload is enough.

### Localization

The settings card follows the harness language setting. Its copy lives in the
`DICTS` object in `src/client.js` and is registered through
`ctx.locale.register('web-search-perplexity', { zh, en })`, which requires both
shipped locales to carry the same key set. Option values that are identifiers
(preset names, `day`/`month`, Agent API model ids) are deliberately not
translated. This README and the embedded skill are English-only.

The embedded `perplexity-research` skill is authored as plain markdown at
`skills/perplexity-research/SKILL.md`. `src/skill.js` is generated
from that file; edit the markdown, then run `npm run build:skill` (also run
automatically before packing/publishing via `prepack`).

#### A deployment can serve the skill from two places

The plugin registers its embedded copy through `ctx.skills`, and a deployment
that also mounts `@deepseek-ai/dsh-skill-filesystem` serves whatever sits under
`$DSH_HOME/skills/`. Those are two independent copies of the same skill name, and
an edit lands in only one of them:

| Edited | Takes effect in |
|---|---|
| `skills/…/SKILL.md` + `npm run build:skill` | the plugin's embedded copy, after the host restarts |
| `$DSH_HOME/skills/perplexity-research/SKILL.md` | that filesystem copy, immediately (its watcher is on by default) |

A deployment that publishes the skill to `$DSH_HOME/skills/` therefore keeps
serving the published file however many times the repository copy is rebuilt, and
the two drift silently: a session can load instructions that no longer match the
plugin. After changing the markdown, publish it to both places:

```powershell
npm run build:skill
Copy-Item skills\perplexity-research\SKILL.md $env:USERPROFILE\.dsh\skills\perplexity-research\SKILL.md -Force
```

Skill bodies are read at load time and the filesystem provider watches its roots,
so a skill change needs no DSH restart either way — unlike the host half, which
only loads at process start.
