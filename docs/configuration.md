# Configuration

Every key lives in the durable `web-search-perplexity` settings namespace, so it
can be set in a profile patch or edited in the web UI. Nothing here needs a plugin
rebuild; anything marked *restart* is read when the plugin loads, so it takes
effect on the next DSH start.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | unset | Literal Perplexity API key (secret role; normally set in the UI instead) |
| `apiKeyEnv` | `PERPLEXITY_API_KEY` | Credential reference used by the UI-stored key |
| `baseURL` | `https://api.perplexity.ai` | Endpoint base; the path is appended to it |
| `preset` | unset | Agent preset: `fast`, `low`, `medium`, `high`, `xhigh`, or `wide-research`. When set, Perplexity picks the model; `model` is sent as an override only if it is a `provider/model` slug |
| `model` | `openai/gpt-5.6-luna` | Agent API model id, used when no preset is set. A value without `/` falls back to the default |
| `maxTokens` | `1024` | `max_output_tokens` for `web_search`. `perplexity_research` ignores it — see [tools](tools.md) |
| `searchRecency` | unset | Recency window: `day`, `week`, `month`, `year`. Unset sends no filter. `hour` is Search API only |
| `softTimeoutMs` | per preset, or 40 s for the Search API | One deadline for both backends. Unset = derived from `preset` (`fast`/`low` `12000`; `medium`/`high`/`xhigh`/`wide-research`/unset `40000`). `0` disables it. See [timeouts](timeouts.md) |
| `fallbackPreset` | `fast` | Preset for the single degraded retry (any preset except `wide-research`) |
| `imageInput` | enabled | Image input. Only the literal `off`/`false`/`0` disables it |
| `imageMaxBytes` | `10485760` | Per-image byte ceiling; an oversized image is refused before it is read |
| `imageRoots` | `[]` (no restriction) | Directory allowlist for local image reads; a path outside every entry is refused. See [images](images.md) |
| `researchTimeoutMs` | `1800000` | Budget for one `perplexity_research` call, independent of `tool-web`'s search budget. `0` declares no deadline. **Restart** |
| `researchDepth` | `low` | Default `depth` for a research call that names none. An unknown value falls back to `low`. Read per call |
| `searchProvider` | `''` (Agent API) | Which backend serves searches: blank or `perplexity` = Agent API; `perplexity-search` = Search API. Only the selected one is usable |
| `searchType` | `web` | Search API only: `web` or `people`. `people` also raises the result bound to 50 |
| `searchDomains` | `[]` | Search API only: up to 20 domains or URLs to restrict results to |
| `searchLanguages` | `[]` | Search API only: up to 20 two-letter ISO 639-1 codes; sent lowercased |
| `searchCountry` | unset | Search API only: two-letter ISO 3166-1 code, sent uppercased |
| `searchContextSize` | `medium` | Search API only: `low`, `medium`, or `high` — how much page content each result returns. Omitted for `searchType: people` |
| `searchMaxTokensPerPage` | unset | Search API only: explicit per-page content budget (`max_tokens_per_page`) |
| `searchAfterDate` / `searchBeforeDate` | unset | Search API only: publication-date window as `MM/DD/YYYY` |

`search_context_size` is sent only for a web search. A people search that carries
it is rejected against the live endpoint, so the backend omits it — that rejection
is our own observation rather than a documented rule. The published schema does
not forbid the combination, and the only validation code it documents for
`/search` is `422`.

> **Only the Agent API and the Search API are used.** Perplexity has replaced its
> Sonar Chat Completions API with the Agent API; Sonar stays supported until
> **2026-09-27**, so this plugin has no `apiMode` switch.

## Where the API key comes from

Resolved in this order:

1. a literal `apiKey` config value (not recommended);
2. the credentials-domain entry named by `apiKeyEnv` — what the web UI writes when
   you save the key in the Perplexity card;
3. the `PERPLEXITY_API_KEY` process environment variable.

The bundled patch layer deliberately does not list `apiKey`; the UI or the
environment variable are the intended sources. Never put the key in a patch file.

## The settings card

Settings → Plugins → Plugin configuration shows a collapsible, editable
`Perplexity web search` card for this namespace. It opens on the choices that
decide behaviour — `baseURL`, the backend selector (`searchProvider`), the API key,
and the backend's own essentials (Agent API: `preset` or `model`, `searchRecency`,
`imageInput`; Search API: `searchType`, `searchRecency`, `searchContextSize`).

Everything else sits behind one `Advanced settings` disclosure: `maxTokens`, the
soft deadline and its fallback preset, and the image settings (`imageMaxBytes`,
`imageRoots`) for the Agent API; `searchDomains`, `searchLanguages`,
`searchCountry`, the publication-date window, and `searchMaxTokensPerPage` for the
Search API. Under it also sit the two research settings, `researchDepth` and
`researchTimeoutMs`, outside the backend branch because the research tool always
runs through the Agent API whatever `searchProvider` selects.

The API key is a write-only secret field either way. Clearing `researchDepth`
unsets the key, which means "use the built-in default"; `researchTimeoutMs`
accepts `0`, which declares no deadline.

The card's copy is translated through the client locale service; on a host without
that service it falls back to English rather than failing. See
[development](development.md).

## Choosing a backend

| | Agent API (default) | Search API |
|---|---|---|
| Endpoint | `POST /v1/agent` | `POST /search` |
| Returns | generated answer + `search_results[]` | ranked `results[]` only |
| `content` | the answer | a `[SEARCH]` marker line, no answer |
| Result count | none on the wire; the seam truncates | native `max_results` (1–20 web, 1–50 people) |
| Images | yes | no |
| Latency (measured) | ~4 s `fast` … ~25 s `medium` narrow | ~1–4 s |
| Extra filters | recency, via the `web_search` tool | domains, languages, country, publication dates, recency, `search_type: people` |

Pick the Agent API when the model should get a synthesized, cited answer, or when
it must read an image. Pick the Search API when you want raw ranked hits with
control over result count and filtering, and intend to read the pages yourself.

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

### Search API specifics

- **No generated answer.** `content` carries one machine-readable marker line,
  `[SEARCH] {"provider":"perplexity-search","sources":8}`, and the sources carry
  the endpoint's snippets. `web_search` renders those snippets to the model, which
  is expected to read and reconcile them rather than cite an answer.
- **`max_results` is native.** The seam's `maxResults` is forwarded, bounded by
  what the endpoint accepts for the configured `searchType` (20 for web, 50 for
  people). The seam still truncates on the way back.
- **Invalid filters are dropped, not sent.** A malformed country code, language
  code, or date is omitted rather than forwarded, because the endpoint answers a
  bad filter with `422`. Dates must be `MM/DD/YYYY`; domains and language codes are
  capped at 20 each.
- **Images are unsupported.** With this backend selected, an image query is sent as
  ordinary search text; there is no `input_image` on this endpoint.
