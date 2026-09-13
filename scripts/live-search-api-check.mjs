/**
 * Live check for the Search API backend: does the real `POST /search` accept the
 * request this plugin builds, and does the response map onto the seam's sources?
 *
 * Manual verification aid, not a test suite: it uses the network and the user's
 * real quota, while `npm test` stays offline and stubbed. The key is resolved
 * through the provider's own credential chain and is never printed.
 *
 * Run (the installed copy is what a running harness loads, so it is the default):
 *   cd $DSH_HOME/profiles/web
 *   $env:PERPLEXITY_API_KEY = "pplx-..."
 *   node C:/path/to/repo/scripts/live-search-api-check.mjs [query]
 *
 * Exit codes: 0 = the provider returned sources, 1 = the call failed,
 * 2 = no plugin entry or no API key.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileRoot = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const installedEntry = join(profileRoot, 'profiles', 'web', 'node_modules',
  '@shjwudp', 'dsh-web-search-perplexity', 'src', 'index.js')
const entry = process.env.PPLX_PLUGIN_ENTRY ?? installedEntry
if (!existsSync(entry)) {
  console.error(`plugin entry not found: ${entry}`)
  process.exit(2)
}
console.log(`entry: ${resolve(entry)}`)
const { apply, SEARCH_API_PROVIDER_ID, SEARCH_API_MARKER_PREFIX } = await import(pathToFileURL(entry).href)

// The plugin registers both of its backends, so collect them by id rather than
// taking whichever registered last.
const registered = new Map()
const ctx = {
  on() {},
  get(name) {
    if (name !== 'credentials') return undefined
    return {
      resolve: async (ref) => {
        const value = process.env[ref]
        return typeof value === 'string' && value.length > 0 ? { value } : undefined
      },
    }
  },
  inject() {},
  web: { registerSearchProvider(candidate) { registered.set(candidate.id, candidate) } },
}
const config = {
  searchProvider: SEARCH_API_PROVIDER_ID,
  // A domain filter and a recency window, so the run also proves the filters
  // reach the endpoint rather than being silently dropped.
  searchDomains: (process.env.PPLX_DOMAINS ?? '').split(',').filter((domain) => domain.length > 0),
  searchRecency: process.env.PPLX_RECENCY ?? '',
  searchType: process.env.PPLX_TYPE ?? 'web',
  searchContextSize: 'medium',
}
apply(ctx, config)
const provider = registered.get(SEARCH_API_PROVIDER_ID)
if (provider === undefined) {
  console.error(`the plugin registered no ${SEARCH_API_PROVIDER_ID} provider`)
  process.exit(2)
}
console.log(`registered: ${[...registered.keys()].join(', ')}`)
console.log(`provider=${provider.id} usable=${provider.available()} `
  + `type=${config.searchType} domains=[${config.searchDomains.join(', ')}] `
  + `recency=${config.searchRecency || '(none)'}`)
if (!provider.available()) {
  console.error('the provider reports itself unusable (no key, or a bad baseURL)')
  process.exit(2)
}

const query = process.argv[2] ?? 'Perplexity Search API max_results parameter'
const started = Date.now()
try {
  const result = await provider.search({ query, maxResults: 5 }, new AbortController().signal)
  console.log(`\nOK in ${Date.now() - started}ms`)
  console.log(`sources: ${result.sources.length}  truncated: ${result.truncated}`)
  console.log(`content: ${String(result.content).slice(0, 200)}`)
  for (const [index, source] of result.sources.entries()) {
    console.log(`  ${index + 1}. ${source.title ?? '(no title)'} — ${source.url}`
      + `${source.publishedAt !== undefined ? ` (${source.publishedAt})` : ''}`)
    console.log(`     ${(source.snippet ?? '').slice(0, 140).replace(/\s+/g, ' ')}`)
  }
  if (typeof SEARCH_API_MARKER_PREFIX === 'string'
    && !String(result.content).startsWith(SEARCH_API_MARKER_PREFIX)) {
    console.log('\nwarning: content does not start with the search marker')
  }
  process.exit(result.sources.length > 0 ? 0 : 1)
} catch (error) {
  console.log(`\nFAILED in ${Date.now() - started}ms`)
  console.log('code    :', error?.code)
  console.log('message :', String(error?.message).slice(0, 500))
  process.exit(1)
}
