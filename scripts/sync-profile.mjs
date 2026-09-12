/**
 * Re-install this working tree into every DSH profile that depends on it.
 *
 * A `file:` dependency is not reliably live. pnpm may hardlink the package into
 * the profile, in which case an in-place edit here does propagate — but any tool
 * that writes a file by replacing it (write to a temp file, then rename) breaks
 * that link, after which the installed copy silently goes stale. This script
 * re-runs the same `pnpm add file:<this repo>` per profile and then compares
 * content, so a pnpm no-op cannot be mistaken for a sync.
 *
 * `link:` is not an alternative: a symlink makes the plugin resolve from this
 * repository, where `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-web` cannot
 * be found, and the plugin fails to load with ERR_MODULE_NOT_FOUND.
 *
 * The host half is loaded per process, so a changed `src/index.js` needs a DSH
 * restart; `src/client.js` is re-served to the browser on reload.
 *
 * Usage:
 *   npm run sync:profile                 all profiles that depend on this package
 *   npm run sync:profile -- <name|path>  one profile, by name or directory path
 *
 * Override the profile root with `DSH_PROFILES_DIR`, or the DSH home with `DSH_HOME`.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This repository root: the parent of `scripts/`. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
/** The package name this repository provides, read rather than repeated. */
const PACKAGE_NAME = repoManifest.name
/**
 * Files whose content decides whether the installed copy is current. `package.json`
 * is deliberately excluded: pnpm rewrites the installed manifest (field order,
 * resolved metadata), so comparing it would report a permanent false mismatch.
 * Version drift is checked separately through the package's own `version` field.
 */
const COMPARED_FILES = ['src/index.js', 'src/client.js', 'src/skill.js']

const profilesRoot = process.env.DSH_PROFILES_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles')

function fail(message) {
  console.error(`sync:profile: ${message}`)
  process.exit(1)
}

/** True when this directory is a DSH profile whose dependencies include `PACKAGE_NAME`. */
function dependsOnPackage(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return manifest?.dependencies?.[PACKAGE_NAME] !== undefined
  } catch {
    return false
  }
}

/** Hash a file's contents, or `undefined` when it is absent. */
function hashFile(path) {
  if (!existsSync(path)) return undefined
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The named profile, or the profile at that path, or `undefined` when unknown. */
function resolveRequestedProfile(requested) {
  const asPath = resolve(requested)
  if (existsSync(asPath) && statSync(asPath).isDirectory()) return asPath
  const asName = join(profilesRoot, requested)
  if (existsSync(asName) && statSync(asName).isDirectory()) return asName
  return undefined
}

/** Every profile directory that depends on this package, in name order. */
function discoverProfiles() {
  if (!existsSync(profilesRoot)) fail(`profiles root not found: ${profilesRoot}`)
  return readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(profilesRoot, entry.name))
    .filter(dependsOnPackage)
    .sort()
}

/**
 * Publish this package's files into one profile's installed copy.
 *
 * `pnpm add file:<repo>` is a no-op once the dependency specifier and lockfile
 * entry already match, so it does NOT refresh contents after an edit; that is why
 * this copies the published set directly and then proves the result loads. The
 * installed `package.json` is left alone: pnpm's rewritten manifest carries the
 * profile's own dependency metadata, and DSH reads the profile manifest rather
 * than this one.
 *
 * @param profileDir - the profile whose `node_modules` receives the files.
 * @returns `undefined` on success, or the failure message.
 */
function copyIntoProfile(profileDir) {
  const installedRoot = join(profileDir, 'node_modules', ...PACKAGE_NAME.split('/'))
  try {
    // `src`, `skills`, and the patch file are the published runtime set declared in
    // package.json's `files`. Removing each destination before copying keeps renamed
    // or deleted modules from surviving as stale code, and breaks any pre-existing
    // hardlink — copying onto the same inode is an error, and a hardlink would keep
    // the installed copy stale the moment an editor replaces a file atomically.
    for (const directory of ['src', 'skills']) {
      rmSync(join(installedRoot, directory), { recursive: true, force: true })
      cpSync(join(repoRoot, directory), join(installedRoot, directory), { recursive: true })
    }
    for (const file of ['cordis.patch.yml', 'LICENSE', 'README.md']) {
      const source = join(repoRoot, file)
      if (!existsSync(source)) continue
      const destination = join(installedRoot, file)
      rmSync(destination, { force: true })
      cpSync(source, destination)
    }
    syncInstalledVersion(installedRoot)
  } catch (error) {
    return `copy failed: ${error.message}`
  }
  return undefined
}

/**
 * Bring the installed manifest's `version` in line with this repository.
 *
 * Only that one field is touched. The installed manifest is pnpm's own copy, and
 * the `dsh` block DSH reads (`bundle.patch` and `client`) is written by pnpm at
 * install time; rewriting the whole file would discard whatever else it carries.
 * pnpm treats a `file:` dependency as already installed once the specifier and
 * lockfile entry match, so it will not refresh this itself.
 *
 * @param installedRoot - the installed package root.
 */
function syncInstalledVersion(installedRoot) {
  const manifestPath = join(installedRoot, 'package.json')
  if (!existsSync(manifestPath)) return
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version === repoManifest.version) return
  manifest.version = repoManifest.version
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Import the installed plugin the way DSH resolves it, so a copy that broke peer
 * resolution is caught here rather than at the next DSH start.
 *
 * @param profileDir - the profile whose installed copy to load.
 * @returns `undefined` when the plugin loads and exports `apply`, else the reason.
 */
function verifyLoadable(profileDir) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(PACKAGE_NAME)})`
        + '.then((m) => { if (typeof m.apply !== "function") { console.error("no apply export"); process.exit(1) } })'
        + '.catch((e) => { console.error(e.code ?? e.message); process.exit(1) })',
    ],
    { cwd: profileDir, encoding: 'utf8', shell: false },
  )
  if (result.status !== 0) return `import failed: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`
  return undefined
}

/**
 * Compare this repository against the installed copy: which of `COMPARED_FILES`
 * differ, and whether the installed manifest still declares this version.
 */
function reportDivergence(profileDir) {
  const installedRoot = join(profileDir, 'node_modules', ...PACKAGE_NAME.split('/'))
  if (!existsSync(installedRoot)) return { installed: false, differing: COMPARED_FILES, versionMismatch: undefined }
  const differing = COMPARED_FILES.filter(
    (file) => hashFile(join(repoRoot, file)) !== hashFile(join(installedRoot, file)),
  )
  let installedVersion
  try {
    installedVersion = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')).version
  } catch {
    installedVersion = undefined
  }
  return {
    installed: true,
    differing,
    versionMismatch: installedVersion === repoManifest.version
      ? undefined
      : `installed ${installedVersion ?? 'unreadable'} vs source ${repoManifest.version}`,
  }
}

/** Newest mtime among this repository's tracked sources, in ms. */
function newestSourceMtime() {
  const candidates = ['package.json', 'src/index.js', 'src/client.js', 'src/skill.js', 'cordis.patch.yml']
  return candidates.reduce((newest, file) => {
    const path = join(repoRoot, file)
    return existsSync(path) ? Math.max(newest, statSync(path).mtimeMs) : newest
  }, 0)
}

const requested = process.argv[2]
let profiles
if (requested !== undefined) {
  const resolvedRequested = resolveRequestedProfile(requested)
  if (resolvedRequested === undefined) {
    fail(`no profile named or located at "${requested}" under ${profilesRoot}`)
  }
  if (!dependsOnPackage(resolvedRequested)) {
    fail(`${resolvedRequested}/package.json does not depend on ${PACKAGE_NAME}`)
  }
  profiles = [resolvedRequested]
} else {
  profiles = discoverProfiles()
  if (profiles.length === 0) fail(`no profile under ${profilesRoot} depends on ${PACKAGE_NAME}`)
}

console.log(`sync:profile — ${PACKAGE_NAME}`)
console.log(`  source:   ${repoRoot}`)
console.log(`  profiles: ${profiles.length}`)

let failed = 0
const results = []
for (const profileDir of profiles) {
  console.log(`  ${profileDir}`)
  const copyError = copyIntoProfile(profileDir)
  if (copyError !== undefined) {
    console.error(`    ${copyError}`)
    failed += 1
    continue
  }
  const loadError = verifyLoadable(profileDir)
  if (loadError !== undefined) {
    console.error(`    ${loadError}`)
    failed += 1
    continue
  }
  results.push({ profileDir, ...reportDivergence(profileDir) })
}

console.log('')
for (const { profileDir, installed, differing, versionMismatch } of results) {
  const name = profileDir.slice(profilesRoot.length + 1)
  if (!installed) {
    console.log(`  ${name}: installed copy missing under node_modules`)
    failed += 1
  } else if (differing.length > 0 || versionMismatch !== undefined) {
    console.log(`  ${name}: STILL OUT OF SYNC${differing.length > 0 ? ` — ${differing.join(', ')}` : ''}`)
    if (versionMismatch !== undefined) console.log(`    version: ${versionMismatch}`)
    failed += 1
  } else {
    console.log(`  ${name}: in sync (${COMPARED_FILES.length} files compared, version ${repoManifest.version})`)
  }
}

if (failed > 0) fail(`${failed} profile(s) did not sync`)

console.log('')
console.log('Restart DSH to load a changed src/index.js; a browser reload is enough for src/client.js.')
console.log(`Sources last modified: ${new Date(newestSourceMtime()).toISOString()}`)
