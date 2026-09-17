# Image input

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

## The rules that keep this from becoming an exfiltration path

1. **Only images are read.** A file is sent only when its extension names an image,
   its bytes really are that format (PNG/JPEG/GIF/WEBP signature check), and it is
   within `imageMaxBytes`. A `.png` holding something else is refused with an error
   rather than uploaded; a file with a non-image extension is left alone and treated
   as ordinary search text.
2. **`imageRoots` confines reads.** With entries configured, a path outside every
   entry is refused before any read, so a research session cannot walk the disk on
   its own. The default is empty, which means no restriction — set it if the agent
   reads images from anywhere it should not.
3. **A URL is never fetched locally.** An http(s) query is passed to Perplexity as an
   image URL, never downloaded by this plugin.

Allowlisted formats and the 50 MB per-image cap are Perplexity's; `imageMaxBytes` is
enforced before the file is read.

A URL image is only as good as its address: Perplexity fetches it server-side, so a
URL its fetcher cannot retrieve — a stale thumbnail path, a host that rejects
hotlinking, an expired signed link — fails the whole request with `invalid request`.
A local file has no such dependency, because the bytes travel with the request.

## Which model answers

An image request keeps the configured preset (or `model`), exactly like a text
request: there is no separate image model. Measured against the Agent API, a preset's
own model reads images correctly — `preset: fast` answers an image question with
`openai/gpt-5.6-luna` and the right answer — so one model selector cannot disagree
with itself. The one thing to know is that with no preset set, the configured `model`
must be able to read images; an image sent to a text-only model answers badly rather
than failing loudly.

## The marker

The result's `content` starts with a machine-readable marker, because
`dsh-tool-web`'s closed output schema forwards nothing else:

```
[IMAGE] {"images":1,"source":["C:/Users/me/Pictures/board.png"],"bytes":48211}
```

`source` echoes the URL when the image came from the web, and `bytes` is `0` for a
URL image (nothing was uploaded by this plugin). Direct `ctx.web.search` callers also
get the same object as `images` on the seam result.

## Cost and latency

Images are slower and costlier than text: the upload precedes the analysis, and
Perplexity bills image tokens as `(width × height) / 750` on top of the text tokens.
An image request therefore gets the text deadline plus `IMAGE_ANALYSIS_MARGIN_MS`
(12 s), capped where the degraded retry still fits the tool budget. That margin is
internal on purpose: one deadline is configured, so no configuration can pair a text
deadline with an image deadline that contradicts it.

## Reproducing the live path without a model

The key is resolved through the same credential chain the provider uses (environment,
then the stored credential), and is never printed:

```powershell
$env:PERPLEXITY_API_KEY = "pplx-..."
node scripts/live-image-check.mjs            # optional 2nd arg: a model id
```
