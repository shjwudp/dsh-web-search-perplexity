/**
 * Deterministic tests for the Perplexity Search API provider (`POST /search`).
 *
 * `globalThis.fetch` is stubbed, so these tests never touch the network and
 * never consume Perplexity quota. The provider module is loaded from a DSH
 * profile install for the same reason as `image-input.test.mjs`: the peers are
 * not installed in a plain checkout.
 *
 * Run: npm test
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoEntry = resolve(repoRoot, 'src/index.js')

/** Machine-specific fallback: a DSH profile install on the author's machine. */
const PROFILE_ROOT = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules',
  '@shjwudp', 'dsh-web-search-perplexity')

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

/**
 * The plugin entry under test. A package entry cannot be imported by path from
 * the repository (peer resolution follows the real path), so the profile copy is
 * the default and `PPLX_PLUGIN_ENTRY` overrides it.
 */
async function chooseEntry() {
  const override = process.env.PPLX_PLUGIN_ENTRY
  if (override !== undefined && override !== '') return override
  if (existsSync(repoEntry) && await isImportable(pathToFileURL(repoEntry).href)) {
    return pathToFileURL(repoEntry).href
  }
  return pathToFileURL(join(PROFILE_ROOT, 'src', 'index.js')).href
}

const MODULE = await chooseEntry()
console.log(`\nentry: ${MODULE}`)
const plugin = await import(MODULE)
const {
  apply,
  SEARCH_API_PROVIDER_ID,
  SEARCH_API_MARKER_PREFIX,
  SEARCH_API_MAX_RESULTS_WEB,
  SEARCH_API_MAX_RESULTS_PEOPLE,
  SEARCH_API_MAX_DOMAINS,
  resolveSearchApiOptions,
  searchApiRequestBody,
  mapSearchApiResponse,
} = plugin
if (typeof apply !== 'function' || typeof SEARCH_API_PROVIDER_ID !== 'string') {
  console.error('This copy does not export the Search API surface; sync the working tree first.')
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

/** Register the plugin with a minimal fake cordis context and capture providers. */
function makeProviders(config, options = {}) {
  const providers = new Map()
  const ctx = {
    on() {},
    get(name) {
      return name === 'credentials' && options.credentials === true
        ? { resolve: async () => undefined }
        : undefined
    },
    inject() {},
    web: { registerSearchProvider(provider) { providers.set(provider.id, provider) } },
  }
  apply(ctx, config)
  return providers
}

/** A fetch stub that records each parsed request body and answers `200`. */
function stubFetch(responder) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const body = init?.body !== undefined ? JSON.parse(init.body) : undefined
    calls.push({ url, body, signal: init?.signal })
    return responder(init?.signal, body)
  }
  return calls
}

function searchOk(results) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ id: 'search-1', results }),
  }
}

const baseConfig = {
  apiKey: 'test-key',
  baseURL: 'https://api.perplexity.ai',
  searchProvider: SEARCH_API_PROVIDER_ID,
}

// ── 1. The seam's maxResults becomes the endpoint's native max_results ───────
// This is the one control the Agent API lacks: it returns as many sources as it
// likes and the seam truncates afterwards.
console.log('\n1. maxResults is sent as max_results')
{
  const calls = stubFetch(() => searchOk([{ title: 'A', url: 'https://example.com/a', snippet: 'a' }]))
  const provider = makeProviders(baseConfig).get(SEARCH_API_PROVIDER_ID)
  await provider.search({ query: 'a narrow question', maxResults: 4 })

  check('the request went to the search endpoint',
    String(calls[0]?.url).endsWith('/search'), calls[0]?.url)
  check('the query is the request query', calls[0]?.body?.query === 'a narrow question',
    JSON.stringify(calls[0]?.body?.query))
  check('maxResults is forwarded as max_results', calls[0]?.body?.max_results === 4,
    JSON.stringify(calls[0]?.body?.max_results))
  check('no model field is sent (this endpoint takes none)',
    calls[0]?.body?.model === undefined, JSON.stringify(calls[0]?.body?.model))
}

// ── 2. Result bounds differ by search type ──────────────────────────────────
console.log('\n2. max_results is bounded per search type')
{
  const webCalls = stubFetch(() => searchOk([]))
  await makeProviders({ ...baseConfig, searchType: 'web' })
    .get(SEARCH_API_PROVIDER_ID).search({ query: 'q', maxResults: 999 })
  check('a web search is capped at the published 20',
    webCalls[0]?.body?.max_results === SEARCH_API_MAX_RESULTS_WEB,
    JSON.stringify(webCalls[0]?.body?.max_results))

  const peopleCalls = stubFetch(() => searchOk([]))
  await makeProviders({ ...baseConfig, searchType: 'people' })
    .get(SEARCH_API_PROVIDER_ID).search({ query: 'q', maxResults: 999 })
  check('a people search may ask for the published 50',
    peopleCalls[0]?.body?.max_results === SEARCH_API_MAX_RESULTS_PEOPLE,
    JSON.stringify(peopleCalls[0]?.body?.max_results))
  check('the type is sent on the body', peopleCalls[0]?.body?.search_type === 'people')
  // The endpoint rejects a people search that carries a content budget, while a
  // web search accepts it, so this field is conditional rather than uniform.
  check('a people search sends no search_context_size',
    peopleCalls[0]?.body?.search_context_size === undefined,
    JSON.stringify(peopleCalls[0]?.body?.search_context_size))
  check('a web search does send a content budget',
    webCalls[0]?.body?.search_context_size !== undefined,
    JSON.stringify(webCalls[0]?.body))
}

// ── 3. Filters are sent only when configured ────────────────────────────────
console.log('\n3. filters appear only when configured')
{
  const bare = stubFetch(() => searchOk([]))
  await makeProviders(baseConfig).get(SEARCH_API_PROVIDER_ID).search({ query: 'q' })
  const body = bare[0]?.body ?? {}
  check('no domain filter by default', body.search_domain_filter === undefined)
  check('no language filter by default', body.search_language_filter === undefined)
  check('no country by default', body.country === undefined)
  check('no date filters by default',
    body.search_after_date_filter === undefined && body.search_before_date_filter === undefined)
  check('no recency filter by default', body.search_recency_filter === undefined)
  check('the content budget always has a value',
    ['low', 'medium', 'high'].includes(body.search_context_size), JSON.stringify(body.search_context_size))

  const filtered = stubFetch(() => searchOk([]))
  await makeProviders({
    ...baseConfig,
    searchDomains: ['docs.perplexity.ai', 'arxiv.org'],
    searchLanguages: ['EN'],
    searchCountry: 'us',
    searchContextSize: 'high',
    searchRecency: 'month',
    searchAfterDate: '3/1/2025',
    searchBeforeDate: '3/5/2025',
  }).get(SEARCH_API_PROVIDER_ID).search({ query: 'q' })
  const withFilters = filtered[0]?.body ?? {}
  check('domains are sent as search_domain_filter',
    JSON.stringify(withFilters.search_domain_filter) === JSON.stringify(['docs.perplexity.ai', 'arxiv.org']),
    JSON.stringify(withFilters.search_domain_filter))
  check('a language is lowercased into search_language_filter',
    JSON.stringify(withFilters.search_language_filter) === JSON.stringify(['en']),
    JSON.stringify(withFilters.search_language_filter))
  check('a country is uppercased', withFilters.country === 'US', JSON.stringify(withFilters.country))
  check('the content budget is forwarded', withFilters.search_context_size === 'high')
  check('recency is forwarded', withFilters.search_recency_filter === 'month')
  check('publication dates keep the required MM/DD/YYYY',
    withFilters.search_after_date_filter === '3/1/2025'
      && withFilters.search_before_date_filter === '3/5/2025',
    JSON.stringify([withFilters.search_after_date_filter, withFilters.search_before_date_filter]))
}

// ── 4. Malformed configuration is dropped, never sent as a 422 ──────────────
console.log('\n4. invalid filter values are dropped rather than sent')
{
  const calls = stubFetch(() => searchOk([]))
  await makeProviders({
    ...baseConfig,
    searchCountry: 'USA',
    searchLanguages: ['english', 'e'],
    searchAfterDate: '2025-03-01',
    searchDomains: ['  ', 'ok.example'],
  }).get(SEARCH_API_PROVIDER_ID).search({ query: 'q' })
  const body = calls[0]?.body ?? {}
  check('a three-letter country is not sent', body.country === undefined, JSON.stringify(body.country))
  check('non-ISO language codes are not sent', body.search_language_filter === undefined,
    JSON.stringify(body.search_language_filter))
  check('an ISO date is not sent as an MM/DD/YYYY filter',
    body.search_after_date_filter === undefined, JSON.stringify(body.search_after_date_filter))
  check('blank domains are dropped, valid ones kept',
    JSON.stringify(body.search_domain_filter) === JSON.stringify(['ok.example']),
    JSON.stringify(body.search_domain_filter))
}

// ── 5. The domain list is bounded by the published maximum ─────────────────
console.log('\n5. at most 20 domains are sent')
{
  const domains = Array.from({ length: 30 }, (_, index) => `d${index}.example`)
  const calls = stubFetch(() => searchOk([]))
  await makeProviders({ ...baseConfig, searchDomains: domains })
    .get(SEARCH_API_PROVIDER_ID).search({ query: 'q' })
  check('the list is truncated to the published bound',
    calls[0]?.body?.search_domain_filter?.length === SEARCH_API_MAX_DOMAINS,
    String(calls[0]?.body?.search_domain_filter?.length))
}

// ── 6. Response mapping ────────────────────────────────────────────────────
console.log('\n6. results map onto the seam source vocabulary')
{
  const mapped = mapSearchApiResponse({
    results: [
      { title: 'T', url: 'https://example.com/a', snippet: 's', date: '2026-01-05' },
      { title: 'No date', url: 'https://example.com/b', snippet: 's2', last_updated: '2026-02-01' },
      { title: 'Bare', url: 'https://example.com/c' },
      { title: 'Bad', url: '', snippet: 'ignored' },
      { title: 'Dup', url: 'https://example.com/a', snippet: 'dup' },
      { title: 'No url' },
    ],
  })
  check('only usable URLs become sources', mapped.sources.length === 3,
    JSON.stringify(mapped.sources.map((source) => source.url)))
  check('title, snippet, and publication date are carried',
    mapped.sources[0]?.title === 'T' && mapped.sources[0]?.snippet === 's'
      && mapped.sources[0]?.publishedAt === '2026-01-05',
    JSON.stringify(mapped.sources[0]))
  check('last_updated substitutes when the publication date is absent',
    mapped.sources[1]?.publishedAt === '2026-02-01', JSON.stringify(mapped.sources[1]))
  check('a missing snippet or date is omitted, not set empty',
    mapped.sources[2]?.snippet === undefined && mapped.sources[2]?.publishedAt === undefined,
    JSON.stringify(mapped.sources[2]))
  check('duplicate URLs are collapsed', mapped.sources.filter((s) => s.url.endsWith('/a')).length === 1)
  check('the seam result is never flagged truncated by the provider', mapped.truncated === false)

  const empty = mapSearchApiResponse({ results: [] })
  check('an empty result set maps to no sources', empty.sources.length === 0)
}

// ── 7. The result announces itself as ranked hits, not an answer ────────────
// This endpoint generates no answer, and `content` is the only field the
// model-facing tool forwards, so the marker is the only way the model can tell
// a hit list from a synthesized answer.
console.log('\n7. the content marker identifies the backend')
{
  stubFetch(() => searchOk([{ title: 'A', url: 'https://example.com/a', snippet: 'a' }]))
  const result = await makeProviders(baseConfig).get(SEARCH_API_PROVIDER_ID)
    .search({ query: 'q', maxResults: 3 })
  const line = String(result.content).split('\n', 1)[0]
  check('content starts with the search marker', line.startsWith(SEARCH_API_MARKER_PREFIX),
    line.slice(0, 80))
  const marker = JSON.parse(line.slice(SEARCH_API_MARKER_PREFIX.length))
  check('the marker names the backend', marker.provider === SEARCH_API_PROVIDER_ID,
    JSON.stringify(marker))
  check('the marker reports the source count', marker.sources === 1, JSON.stringify(marker))
  check('a plain web search adds no searchType field', marker.searchType === undefined,
    JSON.stringify(marker))
}

// ── 8. Exactly one backend is ever usable ──────────────────────────────────
// The seam refuses a call when more than one registered provider is usable, so
// the two providers must answer `available()` from the same configuration.
console.log('\n8. the two backends are mutually exclusive')
{
  const agentOnly = makeProviders({ ...baseConfig, apiKey: 'k', searchProvider: '' }, { credentials: true })
  check('with no selection the Agent provider is usable',
    agentOnly.get('perplexity')?.available() === true)
  check('with no selection the Search provider is not',
    agentOnly.get(SEARCH_API_PROVIDER_ID)?.available() === false)

  const searchOnly = makeProviders({ ...baseConfig, apiKey: 'k' }, { credentials: true })
  check('selecting the Search API makes it usable',
    searchOnly.get(SEARCH_API_PROVIDER_ID)?.available() === true)
  check('selecting the Search API makes the Agent provider unusable',
    searchOnly.get('perplexity')?.available() === false)

  const noCredential = makeProviders({ ...baseConfig, apiKey: '' }, { credentials: false })
  check('without any credential source the Search provider is unusable',
    noCredential.get(SEARCH_API_PROVIDER_ID)?.available() === false)
}

// ── 8b. One deadline governs this backend too ──────────────────────────────
// There is no separate Search API deadline to configure: `softTimeoutMs` bounds
// this backend as well, and `0` disables it here exactly as it does for the
// Agent API. A stalled search must end with an actionable error, not hang.
console.log('\n8b. softTimeoutMs bounds a Search API request')
{
  /** A 200 response whose body never arrives until the signal aborts. */
  const slowResponse = (signal) => {
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
    return { ok: true, status: 200, headers: { get: () => null }, json: () => hang }
  }

  stubFetch((signal) => slowResponse(signal))
  let error
  const started = Date.now()
  try {
    await makeProviders({ ...baseConfig, softTimeoutMs: 1000 })
      .get(SEARCH_API_PROVIDER_ID).search({ query: 'q' }, new AbortController().signal)
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - started
  check('a stalled search ends at the configured deadline',
    error?.code === 'WEB_PROVIDER_ERROR', `${error?.code} after ${elapsed}ms`)
  check('the error names the deadline that was in force',
    String(error?.message).includes('1s'), String(error?.message).slice(0, 120))
  check('it did not wait the internal fallback deadline',
    elapsed < 5000, `elapsed=${elapsed}ms`)

  // `0` disables the deadline: the request is left to the caller's signal.
  const calls = stubFetch(() => searchOk([]))
  await makeProviders({ ...baseConfig, softTimeoutMs: 0 })
    .get(SEARCH_API_PROVIDER_ID).search({ query: 'q' })
  check('0 disables the deadline rather than firing immediately',
    calls.length === 1, `calls=${calls.length}`)
}

// ── 9. Failures surface as seam errors ─────────────────────────────────────
console.log('\n9. a missing key and a rejected request are provider errors')
{
  stubFetch(() => searchOk([]))
  let keyError
  try {
    await makeProviders({ ...baseConfig, apiKey: '' }).get(SEARCH_API_PROVIDER_ID)
      .search({ query: 'q' })
  } catch (error) {
    keyError = error
  }
  check('a missing key is a provider error', keyError?.code === 'WEB_PROVIDER_ERROR', String(keyError?.code))
  check('the message names the remedy',
    String(keyError?.message).includes('PERPLEXITY_API_KEY'), String(keyError?.message).slice(0, 80))

  stubFetch(() => ({
    ok: false,
    status: 422,
    headers: { get: () => null },
    json: async () => ({ error: { message: 'invalid request' } }),
  }))
  let httpError
  try {
    await makeProviders(baseConfig).get(SEARCH_API_PROVIDER_ID).search({ query: 'q' })
  } catch (error) {
    httpError = error
  }
  check('an HTTP failure keeps the provider message',
    httpError?.code === 'WEB_PROVIDER_ERROR' && String(httpError?.message).includes('invalid request'),
    `${httpError?.code} ${httpError?.message}`)
}

// ── 10. The configured endpoint base is respected ──────────────────────────
console.log('\n10. the request uses the configured base URL')
{
  const calls = stubFetch(() => searchOk([]))
  await makeProviders({ ...baseConfig, baseURL: 'https://gateway.example/v1' })
    .get(SEARCH_API_PROVIDER_ID).search({ query: 'q' })
  check('the path is appended to the configured base',
    calls[0]?.url === 'https://gateway.example/v1/search', calls[0]?.url)
  const options = resolveSearchApiOptions({ baseURL: 'https://gateway.example/v1' })
  check('options resolve the same base', options.baseURL === 'https://gateway.example/v1')
  check('no base means the Perplexity default',
    resolveSearchApiOptions({}).baseURL === 'https://api.perplexity.ai')
  check('the request body builder is usable on its own',
    searchApiRequestBody({ query: 'q', maxResults: 2 }, options).max_results === 2)
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
