/**
 * Deterministic tests for image input: a query naming a local image file or a
 * public https image URL becomes the request's image content.
 *
 * `globalThis.fetch` is stubbed, so these tests never touch the network and
 * never consume Perplexity quota. The local-image cases write their own files
 * under the OS temp directory, and every path they use is declared in
 * `imageRoots`, so no test depends on the developer's home directory.
 *
 * Run: npm test
 *
 * The host module is chosen exactly as in `soft-deadline.test.mjs`: set
 * `PPLX_PLUGIN_ENTRY` to test a specific copy, otherwise this repository's own
 * `src/index.js` is used when its peers resolve, and the installed profile copy
 * is the fallback. The chosen entry is printed so a surprising result is
 * visible rather than implied.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoEntry = resolve(repoRoot, 'src/index.js')

/** Machine-specific fallback: a DSH profile install on the author's machine. */
const PROFILE_ENTRY =
  'file:///C:/Users/Administrator/.dsh/profiles/dsh-web-search-perplexity-placeholder/src/index.js'
const INSTALLED_ENTRY =
  'file:///C:/Users/Administrator/.dsh/profiles/web/node_modules/@shjwudp/dsh-web-search-perplexity/src/index.js'

async function isImportable(specifier) {
  try {
    await import(specifier)
    return true
  } catch (error) {
    const unresolved = error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ERR_UNSUPPORTED_DIR_IMPORT'
    if (unresolved) return false
    return true
  }
}

async function chooseEntry() {
  const override = process.env.PPLX_PLUGIN_ENTRY
  if (override !== undefined && override !== '') return override
  if (existsSync(repoEntry) && await isImportable(pathToFileURL(repoEntry).href)) {
    return pathToFileURL(repoEntry).href
  }
  return existsSync(PROFILE_ENTRY.replace('file:///', '').replace(/\//g, '\\')) ? PROFILE_ENTRY : INSTALLED_ENTRY
}

const MODULE = await chooseEntry()
if (process.env.PPLX_PLUGIN_ENTRY === undefined) {
  const fromWorkingTree = MODULE.includes(repoRoot.replace(/\\/g, '/'))
  console.log(`\nentry: ${MODULE}`)
  console.log(fromWorkingTree
    ? "       (this repository's working tree — tests the code under review)"
    : '       (installed profile copy — NOT the working tree)')
}

const { apply, IMAGE_MARKER_PREFIX } = await import(MODULE)
if (typeof apply !== 'function' || typeof IMAGE_MARKER_PREFIX !== 'string') {
  console.error(`\nentry: ${MODULE}`)
  console.error('This copy does not export the image-input surface, so these tests would check')
  console.error('stale code. Sync the working tree into a profile (npm run sync:profile), or point')
  console.error('PPLX_PLUGIN_ENTRY at the copy under review.')
  process.exit(1)
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Register the provider with a minimal fake cordis context. */
function makeProvider(config) {
  let provider
  const ctx = {
    on() {},
    get() { return undefined },
    inject() {},
    web: { registerSearchProvider(p) { provider = p } },
    tools: { register() {} },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
  }
  apply(ctx, config)
  if (provider === undefined) throw new Error('provider was not registered')
  return provider
}

/**
 * A fetch stub that records each parsed request body and lets the responder
 * decide the outcome. The responder receives the request's `AbortSignal`, so a
 * case that must observe which deadline was armed can hang until it aborts.
 */
function stubFetch(responder) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = init?.body !== undefined ? JSON.parse(init.body) : undefined
    calls.push({ url, body, signal: init?.signal })
    return responder(init?.signal, body)
  }
  return calls
}

function agentOk(text) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text }] },
        { type: 'search_results', results: [{ url: 'https://example.com/a', title: 'A' }] },
      ],
    }),
  }
}

function imageOk(text) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      search_results: [{ url: 'https://example.com/s', title: 'S' }],
    }),
  }
}

/** 1x1 PNG, the smallest valid raster the media-type sniffer accepts. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)
/** 1x1 GIF87a, for the format-detection cases. */
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** A 200 response whose body never arrives until `signal` aborts, like a slow backend. */
function slowResponse(signal) {
  const hang = new Promise((_resolve, reject) => {
    const abort = () => {
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal === undefined) return
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  // The headers arrive immediately (so `!response.ok` is false and the body is
  // actually read); only the body hangs, which is what a deadline interrupts.
  return { ok: true, status: 200, headers: { get: () => null }, json: () => hang }
}

const imageDir = mkdtempSync(join(tmpdir(), 'pplx-image-'))
const pngPath = join(imageDir, 'shot.png')
const gifPath = join(imageDir, 'anim.gif')
const extensionlessPath = join(imageDir, 'attachment-object')
// A dotted DIRECTORY name, to prove the extension is read from the file name and
// not from a dot anywhere in the path.
const dottedDir = join(imageDir, 'shots.v2')
const dottedExtensionlessPath = join(dottedDir, 'attachment-object')
const textAsPngPath = join(imageDir, 'notes.png')
const bigPath = join(imageDir, 'huge.png')
const outsideDir = mkdtempSync(join(tmpdir(), 'pplx-outside-'))
const outsidePath = join(outsideDir, 'private.png')
try {
  writeFileSync(pngPath, PNG_1X1)
  writeFileSync(gifPath, GIF_1X1)
  writeFileSync(extensionlessPath, PNG_1X1)
  mkdirSync(dottedDir, { recursive: true })
  writeFileSync(dottedExtensionlessPath, PNG_1X1)
  writeFileSync(textAsPngPath, 'this is not a raster image\n')
  writeFileSync(bigPath, Buffer.concat([PNG_1X1, Buffer.alloc(4096)]))
  writeFileSync(outsidePath, PNG_1X1)

  const baseConfig = {
    apiKey: 'test-key',
    preset: 'medium',
    baseURL: 'https://api.perplexity.ai',
    maxTokens: 100,
    softTimeoutMs: 0,
    imageRoots: [imageDir],
  }

  // ── 1. A local image path becomes an inline Agent API image ──────────────────
  console.log('\n1. a local image path is sent as an Agent API input_image')
  {
    const calls = stubFetch(() => agentOk('the screenshot shows a login form'))
    const provider = makeProvider(baseConfig)
    const result = await provider.search({ query: pngPath, maxResults: 5 })

    check('the request went to the agent endpoint', String(calls[0]?.url).endsWith('/v1/agent'), calls[0]?.url)
    const content = calls[0]?.body?.input?.[0]?.content
    check('input is a user message array', Array.isArray(content), JSON.stringify(calls[0]?.body?.input))
    check('the text part precedes the image',
      content?.[0]?.type === 'input_text' && typeof content?.[0]?.text === 'string',
      JSON.stringify(content?.[0]))
    check('the image part is input_image with a PNG data URI',
      content?.[1]?.type === 'input_image'
        && String(content?.[1]?.image_url).startsWith('data:image/png;base64,')
        && String(content?.[1]?.image_url).slice('data:image/png;base64,'.length) === PNG_1X1.toString('base64'),
      JSON.stringify(content?.[1])?.slice(0, 100))
    // An image request carries the same model selector as a text request: the
    // configured preset, or the configured model when no preset is set. Measured
    // against the Agent API, a preset's own model reads images correctly, so
    // there is no separate image model to disagree with it.
    check('the image request keeps the configured preset selector',
      calls[0]?.body?.preset === 'medium' && calls[0]?.body?.model === undefined,
      `model=${calls[0]?.body?.model} preset=${calls[0]?.body?.preset}`)
    check('the web search tool is still enabled',
      calls[0]?.body?.tools?.[0]?.type === 'web_search', JSON.stringify(calls[0]?.body?.tools))
    check('the token cap is preserved', calls[0]?.body?.max_output_tokens === 100)
    check('the answer is returned', String(result.content).includes('login form'))

    const markerLine = String(result.content).split('\n', 1)[0]
    check('the image marker is the first line of content',
      markerLine.startsWith(IMAGE_MARKER_PREFIX), markerLine.slice(0, 90))
    const marker = JSON.parse(markerLine.slice(IMAGE_MARKER_PREFIX.length))
    check('the marker reports one image', marker.images === 1, JSON.stringify(marker))
    check('the marker names the file on disk', marker.source[0] === pngPath, JSON.stringify(marker.source))
    check('the marker reports the uploaded byte count',
      marker.bytes === PNG_1X1.length, JSON.stringify(marker))
    check('the seam result carries the same marker',
      JSON.stringify(result.images) === JSON.stringify(marker),
      `${JSON.stringify(result.images)} vs ${JSON.stringify(marker)}`)
    check('image input does not degrade a normal result',
      result.degradation?.degraded === false, JSON.stringify(result.degradation))
  }

  // ── 1b. With no preset, an image request falls back to the configured model ─
  console.log('\n1b. without a preset an image request names the configured model')
  {
    const calls = stubFetch(() => agentOk('answer'))
    await makeProvider({ ...baseConfig, preset: '', model: 'openai/gpt-5.6-sol' })
      .search({ query: pngPath, maxResults: 5 })
    check('the configured model is sent with no preset',
      calls[0]?.body?.model === 'openai/gpt-5.6-sol' && calls[0]?.body?.preset === undefined,
      `model=${calls[0]?.body?.model} preset=${calls[0]?.body?.preset}`)
  }

  // ── 2. A public https image URL is passed through, never fetched locally ─────
  console.log('\n2. an https image URL is passed through as the image URL')
  {
    const url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/boardwalk.jpg'
    const calls = stubFetch(() => agentOk('described from the URL'))
    const provider = makeProvider(baseConfig)
    const result = await provider.search({ query: url, maxResults: 5 })

    const content = calls[0]?.body?.input?.[0]?.content
    check('the URL is the image reference, not base64',
      content?.[1]?.image_url === url, JSON.stringify(content?.[1]))
    check('no local read was attempted for a URL', calls.length === 1)
    check('the marker records the URL as the source',
      JSON.parse(String(result.content).split('\n', 1)[0].slice(IMAGE_MARKER_PREFIX.length)).source[0] === url)
  }

  // ── 3. A plain text query is untouched ───────────────────────────────────────
  console.log('\n3. an ordinary text query keeps the text-only body')
  {
    const calls = stubFetch(() => agentOk('plain answer'))
    const provider = makeProvider(baseConfig)
    const result = await provider.search({ query: 'what is a ledger', maxResults: 5 })

    check('the model is still governed by the preset', calls[0]?.body?.preset === 'medium', JSON.stringify(calls[0]?.body))
    check('input is a plain string', calls[0]?.body?.input === 'what is a ledger', JSON.stringify(calls[0]?.body?.input))
    check('no image marker is added', !String(result.content).includes(IMAGE_MARKER_PREFIX))
    check('no images field is set on the result', result.images === undefined)
  }

  // ── 4. Formats and extensionless files ──────────────────────────────────────
  console.log('\n4. media types come from the bytes, not only the extension')
  {
    const calls = stubFetch(() => agentOk('gif answer'))
    const provider = makeProvider(baseConfig)
    await provider.search({ query: gifPath, maxResults: 5 })
    const gifPart = calls[0]?.body?.input?.[0]?.content?.[1]
    check('a .gif is sent as image/gif',
      String(gifPart?.image_url).startsWith('data:image/gif;base64,'), JSON.stringify(gifPart)?.slice(0, 80))

    const signatureCalls = stubFetch(() => agentOk('signature answer'))
    await makeProvider(baseConfig).search({ query: extensionlessPath, maxResults: 5 })
    const signaturePart = signatureCalls[0]?.body?.input?.[0]?.content?.[1]
    check('an extensionless file is identified from its signature',
      signaturePart?.type === 'input_image'
        && String(signaturePart?.image_url).startsWith('data:image/png;base64,'),
      JSON.stringify(signaturePart)?.slice(0, 80))

    // The extension belongs to the file NAME. Reading it from the whole path let
    // a dot in a directory name stand in for one, so this path looked like it had
    // the extension `.v2\attachment-object` and was sent as ordinary text.
    const dottedCalls = stubFetch(() => agentOk('dotted answer'))
    await makeProvider(baseConfig).search({ query: dottedExtensionlessPath, maxResults: 5 })
    const dottedPart = dottedCalls[0]?.body?.input?.[0]?.content?.[1]
    check('an extensionless image under a dotted directory is still an image',
      dottedPart?.type === 'input_image'
        && String(dottedPart?.image_url).startsWith('data:image/png;base64,'),
      JSON.stringify(dottedPart)?.slice(0, 80))
  }

  // ── 5. A mismatched extension is refused loudly, not sent as text ────────────
  console.log('\n5. a .png whose bytes are not a PNG is refused')
  {
    stubFetch(() => agentOk('must not be called'))
    const provider = makeProvider(baseConfig)
    let error
    try {
      await provider.search({ query: textAsPngPath, maxResults: 5 })
    } catch (caught) {
      error = caught
    }
    check('the call rejected', error !== undefined)
    check('the error is a provider error', error?.code === 'WEB_PROVIDER_ERROR', `code=${error?.code}`)
    check('the error names the extension mismatch',
      String(error?.message).includes('extension'), String(error?.message))
  }

  // ── 6. Over-budget images are refused before any upload ─────────────────────
  console.log('\n6. an image above imageMaxBytes is refused')
  {
    const calls = stubFetch(() => agentOk('must not be called'))
    const provider = makeProvider({ ...baseConfig, imageMaxBytes: 64 })
    let error
    try {
      await provider.search({ query: bigPath, maxResults: 5 })
    } catch (caught) {
      error = caught
    }
    check('no request was issued', calls.length === 0, `calls=${calls.length}`)
    check('the error names the byte ceiling',
      String(error?.message).includes('imageMaxBytes'), String(error?.message))
  }

  // ── 7. imageRoots confines a read to declared directories ───────────────────
  console.log('\n7. a path outside imageRoots is refused')
  {
    const calls = stubFetch(() => agentOk('must not be called'))
    const provider = makeProvider({ ...baseConfig, imageRoots: [imageDir] })
    let error
    try {
      await provider.search({ query: outsidePath, maxResults: 5 })
    } catch (caught) {
      error = caught
    }
    check('no request was issued', calls.length === 0, `calls=${calls.length}`)
    check('the error names imageRoots', String(error?.message).includes('imageRoots'), String(error?.message))
  }

  // ── 8. imageInput off restores the text-only behavior ───────────────────────
  console.log('\n8. imageInput off sends the path as ordinary search text')
  {
    const calls = stubFetch(() => agentOk('text answer'))
    const provider = makeProvider({ ...baseConfig, imageInput: 'off' })
    await provider.search({ query: pngPath, maxResults: 5 })
    check('the query is sent as text',
      calls[0]?.body?.input === pngPath, JSON.stringify(calls[0]?.body?.input))
    check('no image part is present', calls[0]?.body?.preset === 'medium')
  }

  // ── 9. A missing file stays an ordinary text query ──────────────────────────
  console.log('\n9. a nonexistent path is not an image error')
  {
    const missing = join(imageDir, 'not-here.png')
    const calls = stubFetch(() => agentOk('text answer'))
    const provider = makeProvider(baseConfig)
    await provider.search({ query: missing, maxResults: 5 })
    check('the query is sent as text', calls[0]?.body?.input === missing, JSON.stringify(calls[0]?.body?.input))
  }

  // ── 10. An image search gets a longer deadline than a text search ───────────
  // An image is uploaded and then read before the search runs, so reusing the
  // text deadline would degrade image searches that are behaving normally. The
  // derived deadline adds a named margin, and `0` still means "no deadline".
  console.log('\n10. an image search gets the text deadline plus the analysis margin')
  {
    stubFetch((signal) => slowResponse(signal))
    let error
    try {
      await makeProvider({ ...baseConfig, softTimeoutMs: 3000, fallbackPreset: 'fast' })
        .search({ query: pngPath, maxResults: 5 }, new AbortController().signal)
    } catch (caught) {
      error = caught
    }
    // 3000 text + 12000 margin = 15000; the retry then adds its own 15s.
    check('the image deadline is the text deadline plus the margin',
      String(error?.message).includes('15s soft deadline'), String(error?.message).slice(0, 140))

    // The margin is internal: there is no separate image deadline to configure.
    // A leftover `imageSoftTimeoutMs` from an earlier version must be inert,
    // which is what proves the console has one deadline rather than two.
    stubFetch((signal) => slowResponse(signal))
    let staleError
    try {
      await makeProvider({ ...baseConfig, softTimeoutMs: 3000, imageSoftTimeoutMs: 6000, fallbackPreset: 'fast' })
        .search({ query: pngPath, maxResults: 5 }, new AbortController().signal)
    } catch (caught) {
      staleError = caught
    }
    check('a leftover imageSoftTimeoutMs cannot change the image deadline',
      String(staleError?.message).includes('15s soft deadline'), String(staleError?.message).slice(0, 140))

    // softTimeoutMs 0 disables the deadline; images must not re-enable it.
    const calls = stubFetch(() => agentOk('no deadline'))
    const started = Date.now()
    const result = await makeProvider({ ...baseConfig, softTimeoutMs: 0 })
      .search({ query: pngPath, maxResults: 5 })
    check('disabling the deadline disables it for images too',
      result.degradation?.softTimeoutMs === 0 && calls.length === 1 && Date.now() - started < 2000,
      JSON.stringify(result.degradation))
  }

  // ── 11. searchRecency rides on the web_search tool filter ───────────────────
  // Sonar mode took `search_recency_filter` as a top-level request field. The
  // Agent API that replaced it has no such field: the window belongs to the
  // `web_search` tool, so the same setting must arrive as a tool filter.
  console.log('\n11. searchRecency is sent as the web_search tool filter')
  {
    const calls = stubFetch(() => agentOk('recent answer'))
    const provider = makeProvider({ ...baseConfig, searchRecency: 'month' })
    await provider.search({ query: 'recent news', maxResults: 5 })

    check('the tool still carries its type',
      calls[0]?.body?.tools?.[0]?.type === 'web_search', JSON.stringify(calls[0]?.body?.tools))
    check('the recency window is a tool filter, not a top-level field',
      calls[0]?.body?.tools?.[0]?.filters?.search_recency_filter === 'month'
        && calls[0]?.body?.search_recency_filter === undefined,
      JSON.stringify(calls[0]?.body))
  }

  // ── 12. An unset recency adds no filter at all ──────────────────────────────
  console.log('\n12. an unset searchRecency sends a bare web_search tool')
  {
    const calls = stubFetch(() => agentOk('plain answer'))
    await makeProvider(baseConfig).search({ query: 'plain question', maxResults: 5 })
    check('no filters object is sent',
      calls[0]?.body?.tools?.[0]?.filters === undefined, JSON.stringify(calls[0]?.body?.tools))
  }

  // ── 13. The removed chat-completions response shape is not accepted ─────────
  // Sonar Chat Completions was deleted, so a response in its shape must not be
  // mistaken for an Agent API answer: silently reading `choices[0]` would
  // reintroduce the format the provider no longer speaks.
  console.log('\n13. a chat-completions-shaped response yields no answer')
  {
    const calls = stubFetch(() => imageOk('legacy answer'))
    const result = await makeProvider(baseConfig).search({ query: 'legacy question', maxResults: 5 })

    check("the request went to the Agent API, not chat/completions",
      String(calls[0]?.url).endsWith('/v1/agent'), calls[0]?.url)
    check('a choices/content body is not read as an answer',
      !String(result.content ?? '').includes('legacy answer'), String(result.content))
  }
} finally {
  rmSync(imageDir, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
