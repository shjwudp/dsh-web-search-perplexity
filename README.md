# @shjwudp/dsh-web-search-perplexity

Standalone Perplexity search provider for the DeepSeek Harness web seam
(`ctx.web`). It registers a `WebSearchProvider` with id `perplexity` and maps
Perplexity's OpenAI-compatible `POST /chat/completions` response into the
seam's normalized `WebSearchResult`.

This package exists because the official
`@deepseek-ai/dsh-web-search-perplexity` package imports
`@deepseek-ai/dsh-environment`, which is not published on the npm registry
(E404) for current dsh releases. This plugin has no internal-only
dependencies.

## Compatibility

- Tested with **DSH 0.1.5-rc.2** (`@deepseek-ai/dsh-web` 0.1.5-rc.2,
  `@deepseek-ai/schemastery` 3.18.2). The host version numbers below are DSH's,
  not this plugin's; this package's own versions are the `v*` tags.
- Peer dependencies: `@deepseek-ai/dsh-web: ^0.1.2-rc.1`,
  `@deepseek-ai/schemastery: ^3.18.1-rc.1`. The declared range is unchanged and
  its lower bound is where this plugin was first written, so an older 0.1.2-rc.x
  host satisfies it too.
- Requires a DSH profile with the `ctx.web` seam mounted and the model-facing
  tools `web_search` / `web_fetch` enabled (`dsh-tool-web`). In the `web`
  profile, `dsh-tool-web` is disabled by the web-app layer by default; enable
  it with `- id: tool-web, disabled: false` in the profile patch.
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

Restart DSH. The provider registers itself as `perplexity`; the model-facing
tools remain the standard `web_search` / `web_fetch` from `dsh-tool-web`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | unset | Literal Perplexity API key (secret role; normally configured in the UI instead) |
| `apiKeyEnv` | `PERPLEXITY_API_KEY` | Credential reference used by the UI-stored key |
| `apiMode` | `agent` | `agent` = Agent API (`/v1/agent`, default); `sonar` = Sonar Chat Completions (`/chat/completions`) |
| `preset` | unset | Agent mode only: dynamic preset `fast`, `low`, `medium`, `high`, `xhigh`, or `wide-research`. When set, Perplexity picks the model; `model` is only sent as an override if it is a `provider/model` slug. |
| `baseURL` | `https://api.perplexity.ai` | Endpoint base; the mode appends its own path |
| `model` | `sonar` | `sonar` / `sonar-pro` / `sonar-reasoning-pro` / `sonar-deep-research` in Sonar mode; any Agent API model id (e.g. `openai/gpt-5.6-luna`) in Agent mode |
| `maxTokens` | `1024` | `max_tokens` (Sonar mode) or `max_output_tokens` (Agent mode) for the generated answer |
| `searchRecency` | unset | Sonar-mode only: `day`, `week`, `month`, or `year` |
| `softTimeoutMs` | per preset (see below) | Agent mode only: soft deadline (ms) for one search before one degraded retry. Unset = derived from the configured `preset` (`fast`/`low` `12000`; `medium`/`high`/`xhigh`/`wide-research`/unset `40000`). `0` disables it. Keep `softTimeoutMs` + 15 s below the tool budget. |
| `fallbackPreset` | `fast` | Agent mode only: preset used for the single degraded retry (any preset except `wide-research`) |

> **Sonar deprecation note**: Perplexity's Sonar Chat Completions API is
> deprecated and will be supported until **September 27, 2026**; the
> replacement is the Agent API. Switch `apiMode` to `agent` before that date.

The provider resolves the API key in this order:

1. a literal `apiKey` config value (not recommended);
2. the credentials domain entry named by `apiKeyEnv` — this is what the web UI
   writes when you save the key in the Perplexity card;
3. the `PERPLEXITY_API_KEY` process environment variable.

The bundled patch layer deliberately does NOT list `apiKey`; the UI or the
environment variable are the intended key sources.

## UI surfaces

- **Plugin configuration card**: Settings → Plugins → Plugin configuration
  shows a collapsible, editable `Perplexity web search` card for the
  `web-search-perplexity` settings namespace. It edits `baseURL`, `apiMode`,
  `preset` (Agent mode), `model` (Sonar or Agent API model dropdowns),
  `maxTokens`, `searchRecency` (Sonar mode only), the Agent-mode soft deadline
  and its fallback preset, and the API key (write-only secret field).

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

1. **Soft deadline (this plugin).** In Agent mode, `softTimeoutMs` bounds one
   request. When it expires the provider makes exactly one bounded retry on
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
(`sonar-pro`, preset names, model ids) are deliberately not translated. This
README and the embedded skill are English-only.

The embedded `perplexity-research` skill is authored as plain markdown at
`skills/perplexity-research/SKILL.md`. `src/skill.js` is generated
from that file; edit the markdown, then run `npm run build:skill` (also run
automatically before packing/publishing via `prepack`).
