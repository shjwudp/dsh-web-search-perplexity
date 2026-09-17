/**
 * Tests for release metadata, which has drifted before and is not covered by
 * `node --check`.
 *
 * The version lives in three places, and they are independent copies:
 *
 * 1. `package.json` — the version the plugin is installed and tagged as.
 * 2. `USER_AGENT` in `src/shared.js` — the same version, restated as an
 *    attribution string. These two silently disagreed once already (0.1.1
 *    against 0.1.4) and nothing noticed.
 * 3. The README's install line — a pinned tag. Bumping the version without
 *    updating that pin tells every reader to install the *previous* release,
 *    which is what happened to the 0.1.6-rc.1 pin while this package was already
 *    at 0.1.7-rc.1.
 *
 * Offline and deterministic: three local files are read, nothing is fetched, and
 * no API quota is touched. `src/shared.js` imports nothing, so this runs with no
 * peers resolved.
 *
 * Run: npm test
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USER_AGENT } from '../src/shared.js'
import { DARK_PATH, LIGHT_PATH, SOURCE_PATH, darkVariant, lightVariant } from '../scripts/build-diagram.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
/** The bare package name, without the scope: what `USER_AGENT` is built from. */
const bareName = String(manifest.name).split('/').pop()

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── 1. package.json and USER_AGENT are one version, not two ─────────────────
console.log('\n1. the package version has exactly one value')
{
  check('package.json declares a semver version', /^\d+\.\d+\.\d+/.test(String(manifest.version)), String(manifest.version))
  check('USER_AGENT names this package, not another',
    USER_AGENT.startsWith(`${bareName}/`), USER_AGENT)
  check('USER_AGENT carries the manifest version verbatim',
    USER_AGENT === `${bareName}/${manifest.version}`,
    `USER_AGENT=${USER_AGENT} package.json=${manifest.version}`)
}

// ── 2. The README installs the version this package actually is ─────────────
console.log('\n2. the README install pin matches the version being released')
{
  const pins = [...readme.matchAll(/#v(\d+\.\d+\.\d+[^\s`)\]]*)/g)].map((match) => match[1])
  check('the README pins a release tag at all', pins.length > 0, JSON.stringify(pins))
  check('every pinned tag is the current version',
    pins.every((pin) => pin === manifest.version),
    `pinned=${JSON.stringify(pins)} version=${manifest.version}`)
}

// ── 3. Documentation links resolve ─────────────────────────────────────────
// The README is a landing page that delegates its detail to `docs/`, so its links
// are load-bearing: a relative link that points at a renamed or deleted page is a
// dead end for the reader, and nothing else in the build notices.
console.log('\n3. every relative documentation link points at a file that exists')
{
  const docFiles = [
    'README.md',
    ...readdirSync(join(repoRoot, 'docs'))
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => join('docs', entry)),
  ]
  const missing = []
  let checked = 0
  for (const file of docFiles) {
    const text = readFileSync(join(repoRoot, file), 'utf8')
    const targets = []
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) targets.push(match[1])
    // The README's hero image is a <picture>, not a markdown image, so its src and
    // srcset are relative references too and deserve the same check. A srcset may
    // carry several candidates; each is its own reference.
    for (const match of text.matchAll(/\b(?:src|srcset)="([^"]+)"/g)) {
      for (const candidate of match[1].split(',')) targets.push(candidate.trim().split(/\s+/)[0])
    }
    for (const target of targets) {
      if (target === undefined || target === '') continue
      // Absolute URLs and in-page anchors have nothing to resolve on disk.
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
      const path = target.split('#')[0]
      if (path === '') continue
      checked += 1
      if (!existsSync(join(repoRoot, dirname(join(file)), path))) {
        missing.push(`${file} -> ${target}`)
      }
    }
  }
  check('the documentation contains relative links to check', checked > 0, String(checked))
  check('every relative link resolves to an existing file', missing.length === 0, missing.join('; '))
  // Printed rather than only asserted: a guard that scanned nothing would pass the
  // check above, so the count is what shows this one is doing work.
  console.log(`        (checked ${checked} relative links across ${docFiles.length} files)`)
}

// ── 4. The generated diagram variants match their source ───────────────────
// `docs/architecture.svg` is the only diagram a human edits; the light and dark
// files the README's <picture> loads are generated from it. Editing a generated
// file by hand would leave the two palettes describing different diagrams, and
// nothing else in the build would notice.
console.log('\n4. the light and dark diagrams are current')
{
  const source = readFileSync(SOURCE_PATH, 'utf8')
  check('the authored diagram still carries a dark palette',
    source.includes('prefers-color-scheme: dark'))
  for (const [label, path, produce] of [
    ['light', LIGHT_PATH, lightVariant],
    ['dark', DARK_PATH, darkVariant],
  ]) {
    const generated = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    check(`the ${label} variant exists`, generated !== undefined, path)
    check(`the ${label} variant matches the authored source`,
      generated === produce(source),
      generated === undefined ? 'missing' : 'differs — run npm run build:diagram')
    check(`the ${label} variant carries no media query`,
      generated !== undefined && !generated.includes('prefers-color-scheme'))
  }
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
