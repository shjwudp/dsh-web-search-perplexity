/**
 * Live check for image input: does the real Perplexity API accept the image
 * requests this plugin builds?
 *
 * This is a manual verification aid, not a test suite: it uses the network and
 * the user's real quota. `npm test` stays offline and stubbed.
 *
 * It drives the provider directly (no model, no harness), with a 1x1 PNG it
 * writes to a temp directory. The API key is resolved through the provider's own
 * chain — environment, then the credentials domain — and is never printed.
 *
 * Run (the installed copy is what a running harness loads, so it is the default
 * target; the import must be a file URL because a `file:` install resolves the
 * real path, which would otherwise leave the peers unreachable):
 *
 *   cd $DSH_HOME/profiles/web
 *   $env:PERPLEXITY_API_KEY = "pplx-..."    # or rely on the stored credential
 *   node C:/path/to/repo/scripts/live-image-check.mjs [model-id]
 *
 * Exit codes: 0 = the provider returned an answer, 1 = the call failed,
 * 2 = no API key resolved.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

/** The copy a running harness loads: the package installed into a DSH profile. */
const defaultProfile = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const installedEntry = join(defaultProfile, 'profiles', 'web', 'node_modules',
  '@shjwudp', 'dsh-web-search-perplexity', 'src', 'index.js')
const entry = process.env.PPLX_PLUGIN_ENTRY ?? installedEntry
if (!existsSync(entry)) {
  console.error(`plugin entry not found: ${entry}`)
  console.error('Set PPLX_PLUGIN_ENTRY to the src/index.js of the copy under test.')
  process.exit(2)
}
console.log(`entry: ${resolve(entry)}`)
const { apply } = await import(pathToFileURL(entry).href)

/**
 * A 256x256 solid-colour PNG, assembled by hand so this script needs no image
 * library. The size matters: Perplexity bills image tokens as
 * `(width x height) / 750`, so a 1x1 pixel fixture asks the vision model to
 * read an image with no readable content, which is not a fair test of the path.
 */
function solidPng(size, [red, green, blue]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 2      // colour type: truecolour
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3)
    raw[row] = 0   // filter type
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3
      raw[at] = red
      raw[at + 1] = green
      raw[at + 2] = blue
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** CRC-32, required by the PNG chunk format. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

const directory = mkdtempSync(join(tmpdir(), 'pplx-live-image-'))
const imagePath = join(directory, 'solid-256.png')
writeFileSync(imagePath, solidPng(256, [20, 120, 220]))
console.log(`fixture: ${readFileSync(imagePath).length} bytes, 256x256, ~87 image tokens`)

/** Register the provider with a minimal fake cordis context. */
function makeProvider(config) {
  let provider
  const ctx = {
    on() {},
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        // Delegated to the DSH credential chain when the plugin calls it with no
        // literal key: this script never reads a secret itself.
        resolve: async (ref) => {
          const value = process.env[ref]
          return typeof value === 'string' && value.length > 0 ? { value } : undefined
        },
      }
    },
    inject() {},
    web: { registerSearchProvider(p) { provider = p } },
  }
  apply(ctx, config)
  if (provider === undefined) throw new Error('provider was not registered')
  return provider
}

const config = {
  // No literal key: the provider resolves PERPLEXITY_API_KEY from the ambient
  // environment, exactly as it does in a running harness.
  baseURL: 'https://api.perplexity.ai',
  maxTokens: 400,
  softTimeoutMs: 0,
  imageRoots: [directory],
  // No preset: an image request names its vision model directly.
  preset: '',
  imageModel: process.argv[2] ?? 'openai/gpt-5.4',
}
console.log(`model=${config.imageModel}  image=${imagePath}`)

const provider = makeProvider(config)
if (!provider.available()) {
  console.log('the provider reports itself unavailable (no key configured for the configured apiKeyEnv)')
  process.exit(2)
}

const started = Date.now()
try {
  const result = await provider.search({ query: imagePath, maxResults: 3 }, new AbortController().signal)
  console.log(`\nOK in ${Date.now() - started}ms`)
  console.log('images      :', JSON.stringify(result.images))
  console.log('degradation :', JSON.stringify(result.degradation))
  console.log('sources     :', result.sources.length)
  console.log('content     :\n' + String(result.content).slice(0, 1200))
  process.exit(0)
} catch (error) {
  console.log(`\nFAILED in ${Date.now() - started}ms`)
  console.log('code    :', error?.code)
  console.log('message :', String(error?.message).slice(0, 800))
  console.log('cause   :', String(error?.cause?.message ?? error?.cause ?? '').slice(0, 300))
  process.exit(1)
}
