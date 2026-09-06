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

- Tested with **DSH 0.1.2-rc.1** (`@deepseek-ai/dsh-web` 0.1.2-rc.1)
- Peer dependency: `@deepseek-ai/dsh-web: ^0.1.2-rc.1`
- Requires a DSH profile with the `ctx.web` seam mounted and the model-facing
  tools `web_search` / `web_fetch` enabled (`dsh-tool-web`). In the `web`
  profile, `dsh-tool-web` is disabled by the web-app layer by default; enable
  it with `- id: tool-web, disabled: false` in the profile patch.
- Node ≥ 18

## Install

```bash
dsh plugin --profile web add github:shjwudp/dsh-web-search-perplexity#v0.1.2
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
  `maxTokens`, `searchRecency` (Sonar mode only), and the API key (write-only
  secret field).

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
npm run build:skill  # regenerate src/skill.js from the markdown skill source
```

The embedded `perplexity-research` skill is authored as plain markdown at
`skills/perplexity-research/SKILL.md`. `src/skill.js` is generated
from that file; edit the markdown, then run `npm run build:skill` (also run
automatically before packing/publishing via `prepack`).
