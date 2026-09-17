/**
 * Generate the two README diagram variants from the authored SVG.
 *
 * `docs/architecture.svg` is the source of truth: it carries a
 * `prefers-color-scheme: dark` palette, so it also stands on its own in an editor
 * or when opened directly. GitHub's documented way to ship a theme-aware README
 * image is a `<picture>` element with a light and a dark `srcset`, which needs two
 * files — so those two are generated here rather than maintained by hand.
 *
 * The transforms are pure and exported so the freshness check in
 * `test/package-metadata.test.mjs` can regenerate both variants and compare them
 * with what is on disk; a hand-edited generated file therefore fails the suite
 * instead of silently diverging from the source.
 *
 * Usage: npm run build:diagram
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** The authored diagram: the only file a human edits. */
export const SOURCE_PATH = join(repoRoot, 'docs', 'architecture.svg')
/** Generated: the dark palette stripped out. */
export const LIGHT_PATH = join(repoRoot, 'docs', 'architecture-light.svg')
/** Generated: the dark palette applied unconditionally. */
export const DARK_PATH = join(repoRoot, 'docs', 'architecture-dark.svg')

const DARK_AT = /^[ \t]*@media \(prefers-color-scheme: dark\) \{\n/m
const DARK_BLOCK = /^[ \t]*@media \(prefers-color-scheme: dark\) \{[\s\S]*?^[ \t]*\}\n/m

/**
 * The light variant: the authored file with the dark media query removed.
 *
 * @param source - the authored SVG.
 * @returns the same SVG without its dark palette.
 */
export function lightVariant(source) {
  return source.replace(DARK_BLOCK, '')
}

/**
 * The dark variant: the dark palette, no longer behind a media query.
 *
 * Unwrapping rather than re-colouring means the two variants cannot drift: they
 * are the same geometry and the same two palettes, always.
 *
 * @param source - the authored SVG.
 * @returns the same SVG with the dark palette applied unconditionally.
 */
export function darkVariant(source) {
  return source
    .replace(DARK_AT, '')
    .replace(/\n[ \t]*\}\n([ \t]*)<\/style>/, '\n$1</style>')
}

function main() {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  if (!DARK_AT.test(source)) {
    console.error(`build:diagram: ${SOURCE_PATH} has no dark palette to unwrap`)
    process.exit(1)
  }
  const light = lightVariant(source)
  const dark = darkVariant(source)
  for (const [label, text] of [['light', light], ['dark', dark]]) {
    if (text.includes('prefers-color-scheme')) {
      console.error(`build:diagram: the ${label} variant still carries a media query`)
      process.exit(1)
    }
  }
  writeFileSync(LIGHT_PATH, light)
  writeFileSync(DARK_PATH, dark)
  console.log(`wrote ${LIGHT_PATH} (${light.length} bytes)`)
  console.log(`wrote ${DARK_PATH} (${dark.length} bytes)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
