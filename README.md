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

## Install

```bash
dsh plugin --profile web add github:shjwudp/dsh-web-search-perplexity#v0.1.0
```

Then tell the web seam to use the Perplexity provider in
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: perplexity
    fetchProvider: http
```

Set the API key in the terminal that starts DSH (never in a patch file):

```powershell
$env:PERPLEXITY_API_KEY = "pplx-..."
```

Restart DSH. The provider registers itself as `perplexity`; the model-facing
tools remain the standard `web_search` / `web_fetch` from `dsh-tool-web`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$PERPLEXITY_API_KEY` | Perplexity API key; provider is unavailable when empty |
| `baseURL` | `https://api.perplexity.ai` | Endpoint base; `/chat/completions` is appended |
| `model` | `sonar` | Search model |
| `maxTokens` | `1024` | `max_tokens` for the generated answer |
| `searchRecency` | unset | Optional `search_recency_filter` — `day`, `week`, `month`, or `year` |

`apiKey` is read from the plugin config first, then the `PERPLEXITY_API_KEY`
environment variable. The bundled patch layer already sets
`apiKey: !!js process.env.PERPLEXITY_API_KEY`, so the environment variable is
sufficient.

## Response mapping

- `content` ← `choices[0].message.content` (the generated answer)
- `sources[]` ← structured `search_results[]` (`url`, `title`, `snippet`,
  `publishedAt` from `date`)
- If `search_results` is absent, `sources[]` ← URL-only `citations[]`

HTTP redirects are rejected. Failures surface as `WebError` with
`WEB_PROVIDER_ERROR` (or `WEB_ABORTED` for abort signals).

## Development

```bash
node --check src/index.js
```
