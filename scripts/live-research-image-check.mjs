/**
 * Live check for the `perplexity_research` tool's explicit `image` argument.
 *
 * This is a manual verification aid, not a test suite: it uses the network and
 * the user's real quota. `npm test` stays offline and stubbed.
 *
 * It drives the tool the plugin registers (no model, no harness) with a real
 * image, and prints the first line of the answer so the `[IMAGE]` marker can be
 * read directly.
 *
 * IMPORTANT: the tool is registered when the host loads the plugin. A running
 * `dsh web` keeps the definition it loaded at startup, so this script proves the
 * request the tool builds — not that a live session has been reloaded onto it.
 * It is equivalent evidence for the code path, and explicitly NOT the chain that
 * requires a `dsh web` reload.
 *
 * The API key is resolved through the same chain the plugin uses — environment,
 * then the stored credential in `~/.dsh/.credentials.yaml` — and is never
 * printed.
 *
 * Run:
 *   node scripts/live-research-image-check.mjs [image] [question]
 *
 * Defaults to the probe contact sheet:
 *   /data/data/com.termux/files/home/.tv-tools/deck-fix/contact.png
 *
 * Exit codes: 0 = the marker was produced, 1 = the call failed, 2 = no key.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')
const entry = process.env.PPLX_PLUGIN_ENTRY ?? join(repoRoot, 'src', 'index.js')
if (!existsSync(entry)) {
  console.error(`plugin entry not found: ${entry}`)
  console.error('Set PPLX_PLUGIN_ENTRY to the src/index.js of the copy under test.')
  process.exit(2)
}
console.log(`entry: ${resolve(entry)}`)
const { apply } = await import(pathToFileURL(entry).href)

const image = resolve(process.argv[2]
  ?? '/data/data/com.termux/files/home/.tv-tools/deck-fix/contact.png')
const question = process.argv[3]
  ?? 'This is a contact sheet of generated slide pages. Describe what it shows.'
if (!existsSync(image)) {
  console.error(`probe image not found: ${image}`)
  process.exit(2)
}

/** The stored credential ref, read without ever printing the value. */
function storedRef(ref) {
  const credentialsPath = join(process.env.HOME ?? '', '.dsh', '.credentials.yaml')
  try {
    const text = readFileSync(credentialsPath, 'utf8')
    const match = new RegExp(`^\\s+${ref}:\\s*(.+?)\\s*$`, 'm').exec(text)
    const value = match?.[1]?.replace(/^['"]|['"]$/g, '')
    return value !== undefined && value.length > 0 ? { value } : undefined
  } catch {
    return undefined
  }
}

/** Register `perplexity_research` with a minimal fake cordis context. */
function makeTool(config) {
  const registered = []
  const ctx = {
    on() {},
    inject() {},
    get(name) {
      if (name === 'credentials') return { resolve: async (ref) => storedRef(ref) }
      if (name === 'skills') return undefined
      return undefined
    },
    web: { registerSearchProvider() {} },
    tools: { register(tool) { registered.push(tool); return () => {} } },
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
  }
  apply(ctx, config)
  const tool = registered.find((candidate) => candidate.name === 'perplexity_research')
  if (tool === undefined) throw new Error('perplexity_research was not registered')
  return tool
}

const config = {
  baseURL: 'https://api.perplexity.ai',
  researchDepth: 'low',
  // Bound the wait well below the 30-minute default for a manual check.
  researchTimeoutMs: 600_000,
  // The probe image's own directory is the only allowed root.
  imageRoots: [dirname(image)],
}
console.log(`image   : ${image}`)
console.log(`question: ${question}`)

let tool
try {
  tool = makeTool(config)
} catch (error) {
  console.error(`registration failed: ${String(error?.message)}`)
  process.exit(1)
}

const started = Date.now()
try {
  const value = await tool.execute(
    { question, image, depth: 'low' },
    { signal: new AbortController().signal },
  )
  const content = String(value?.content ?? '')
  const firstLine = content.split('\n', 1)[0]
  let marker
  try {
    marker = firstLine.startsWith('[IMAGE] ') ? JSON.parse(firstLine.slice('[IMAGE] '.length)) : undefined
  } catch {
    marker = undefined
  }
  console.log(`\nOK in ${Date.now() - started}ms`)
  console.log('first line :', firstLine)
  console.log('images     :', JSON.stringify(value?.images))
  console.log('marker ok  :', marker?.images === 1 && Array.isArray(marker?.source))
  console.log('sources    :', Array.isArray(value?.sources) ? value.sources.length : 'n/a')
  console.log('answer     :\n' + content.slice(0, 800))
  process.exit(marker?.images === 1 ? 0 : 1)
} catch (error) {
  console.log(`\nFAILED in ${Date.now() - started}ms`)
  console.log('code    :', error?.code)
  console.log('message :', String(error?.message).slice(0, 800))
  console.log('cause   :', String(error?.cause?.message ?? error?.cause ?? '').slice(0, 300))
  process.exit(1)
}
