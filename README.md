# @shjwudp/dsh-web-search-perplexity

A Perplexity-backed search provider for the DeepSeek Harness `ctx.web` seam. It gives
a DSH agent quick web lookups, and a second tool for research that takes minutes.

## What it does

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/architecture-light.svg">
  <img alt="Three layers — the DSH host, this plugin, and the Perplexity API — crossed by two capability lanes. In the web search lane the host's own web_search tool is answered by a provider this plugin registers into the ctx.web seam, which calls Perplexity's Agent API by default or its Search API when selected. In the research lane the plugin adds a perplexity_research tool with its own 30-minute budget, and a skill that is guidance for the model rather than a call; that lane reaches Perplexity through the Agent API only. Perplexity publishes four APIs, of which Router and Embeddings are outside this plugin's scope." src="docs/architecture-light.svg">
</picture>

The plugin provides **two capabilities that stay separate**, and it is worth knowing
which is which before configuring anything.

**Web search — this plugin is a backend, not a tool.** It registers a Perplexity
provider into the host's web-search seam. The host's existing `web_search` tool stays
the tool the model calls; this plugin supplies the provider behind it, so the agent's
tool list never changes. That tool runs under the host's own budget — 60 s with the
shipped agent presets.

**Research — the plugin adds a tool, and a skill to guide it.** `perplexity_research`
is a second tool, contributed here, that declares its own 30-minute budget, because no
search bounded to 60 s can finish a multi-round question. It ships with the
`perplexity-research` skill: markdown loaded into the model's context that says when to
search and when to research, how to read a degraded result, and how to cite sources.
The skill is guidance, not a call — it never reaches Perplexity itself.

- **Answers, not just links.** Searches go to Perplexity's Agent API by default, which
  returns a synthesized answer with its sources, mapped into the seam's normalized
  result.
- **A second backend when you want raw hits.** Set `searchProvider` and the same
  `web_search` tool is served by Perplexity's Search API instead: ranked results with
  domain, language, country, date, and recency filters.
- **Images work.** A query naming a local image file or a public image URL is sent to
  Perplexity as an image, so "what is wrong with this board" is a supported question.
- **Failures say what happened.** A rate limit, a connection failure, and a backend that
  researched but returned no answer are three distinct classes, each naming what a
  reader needs to decide what to do next.
- **A slow answer is labelled.** When a query is retried on a faster preset, the result
  says so in a machine-readable field, not only in prose.

**Why this package exists:** the official `@deepseek-ai/dsh-web-search-perplexity`
imports `@deepseek-ai/dsh-environment`, which is not published on the npm registry
(E404) for current dsh releases. This plugin has no internal-only dependencies.

## Install

```bash
dsh plugin --profile web add github:shjwudp/dsh-web-search-perplexity#v0.1.7-rc.1
```

Tell the web seam to use the Perplexity provider in
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: perplexity
    fetchProvider: http
```

The `web` profile ships with the model-facing tools disabled, so enable them in the
same patch with `- id: tool-web, disabled: false`.

Set the API key where DSH will read it — in the terminal that starts DSH, or later in
the web UI at Settings → Plugins → Plugin configuration → Perplexity web search:

```powershell
# Windows PowerShell
$env:PERPLEXITY_API_KEY = "pplx-..."
```

```bash
# macOS / Linux (bash/zsh)
export PERPLEXITY_API_KEY="pplx-..."
```

Never put the key in a patch file. Restart DSH, and the agent has both tools.

## Common settings

A quick-start subset. The full 23-key reference, the settings card, and how to switch
backends are in [configuration](docs/configuration.md).

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | unset | Perplexity API key; normally saved in the UI instead |
| `preset` | unset | Agent preset: `fast`, `low`, `medium`, `high`, `xhigh`, `wide-research` |
| `searchProvider` | `''` | Blank or `perplexity` = Agent API; `perplexity-search` = Search API |
| `researchDepth` | `low` | Default depth for `perplexity_research` |
| `softTimeoutMs` | derived from `preset` | Deadline before one degraded retry; `0` disables it |
| `imageInput` | enabled | Set to `off` to send image paths as ordinary text |

## Use it

The model chooses the tool; nothing is configured per call.

- Quick, single-fact lookups go through `web_search`, answered by whichever backend
  `searchProvider` selects.
- A question that needs many sources, or several rounds of reading, goes to
  `perplexity_research` with an optional depth — `low` (the default), `medium`, `high`,
  or `wide`:

  ```js
  perplexity_research({ question: 'Which EU AI Act obligations apply to GPAI providers from 2026?', depth: 'medium' })
  ```

## Compatibility

- Needs a DSH profile with the `ctx.web` seam mounted. The plugin injects `web`,
  `tools`, and `systemPrompt` — all three are required, since it also contributes a
  tool and a prompt section. A composition missing one fails at load with a message
  naming it, rather than registering nothing.
- Needs a Perplexity API key: the `PERPLEXITY_API_KEY` environment variable, or one
  saved in the settings card.
- Node ≥ 18. Peer dependencies `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-web`, and
  `@deepseek-ai/schemastery` are all optional and declared as `^0.1.2-rc.1` /
  `^3.18.1-rc.1`; older `0.1.2-rc.x` hosts are within range.
- Tested with **DSH 0.1.5-rc.1** (`@deepseek-ai/dsh-web` 0.1.5-rc.2,
  `@deepseek-ai/schemastery` 3.18.2). The host version numbers are DSH's, not this
  plugin's; this package's own versions are the `v*` tags.
- Perplexity has replaced its Sonar Chat Completions API with the Agent API (Sonar
  stays supported until 2026-09-27), so there is no `apiMode` switch and no Sonar
  fallback.

## Documentation

**Install and configure**

- [Configuration](docs/configuration.md) — every setting, the settings card, and how to
  choose between the two Perplexity backends
- [Development](docs/development.md) — the test suites, `sync:profile`, localization,
  and the two places the skill can live

**Understand the behavior**

- [The two tools](docs/tools.md) — `web_search` vs `perplexity_research`, the depth
  ladder, the background lifecycle, and the response mapping
- [Timeouts and degradation](docs/timeouts.md) — the tool budget, measured latency, the
  derived soft deadline, and the machine-readable degradation markers
- [Image input](docs/images.md) — sending an image, the three read guards, and what it
  costs
- [Failures](docs/failures.md) — how a rate limit, a connection failure, and a
  no-output research run each report themselves

**Why it works this way**

- [Model-stage incident](docs/model-stage-no-output.md) — the evidence, and the A/B that
  found the output cap starving a research run
- [Upstream report](docs/upstream-report-model-no-output.md) — the report sent to
  Perplexity, with reproducible run ids

The diagram is an SVG with an editable source in the same directory: the authored
`docs/architecture.svg` carries both palettes, and
`npm run build:diagram` derives `architecture-light.svg` and `architecture-dark.svg`
from it, which is what the `<picture>` above loads.

## Development

```bash
npm run check          # syntax-check the host, client, and generated skill module
npm test               # ten suites, all offline, no API quota
npm run build:skill    # regenerate src/skill.js from the markdown skill source
npm run build:diagram  # regenerate the light and dark architecture SVGs
npm run sync:profile   # copy this working tree into every DSH profile that depends on it
```

## Help

Open an [issue](https://github.com/shjwudp/dsh-web-search-perplexity/issues) for a bug
or a question. Licensed under MIT.
