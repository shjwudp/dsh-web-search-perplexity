/**
 * Generate src/skill.js from the canonical markdown skill source.
 *
 * The skill is authored as skills/perplexity-research/SKILL.md so it
 * can be reviewed and edited as plain markdown. This script reads that file,
 * extracts the YAML frontmatter, and writes the embedded ESM module the plugin
 * imports at runtime. Run it before publishing or after editing the skill:
 *
 *   npm run build:skill
 *
 * `renderSkillModule()` is exported because scripts/check-skill.mjs re-renders
 * the module and compares it with the checked-in src/skill.js, so the generated
 * artifact cannot go stale (or be hand-edited) unnoticed.
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(root, 'skills/perplexity-research/SKILL.md')
const targetPath = resolve(root, 'src/skill.js')

// `source` is a required string on the dsh-skill runtime registration path:
// registries list runtime skills without it, but loading one throws
// `loaded skill "<name>" source must be a string`. Keep it a stable origin
// label in the style of the built-in filesystem provider ("bundled",
// "project-dsh", "user-dsh", "custom") so warnings read as
// `<name> from plugin:web-search-perplexity`.
//
// The markdown frontmatter deliberately carries no `source`: a copy served by
// the built-in filesystem provider gets one from the root it was discovered
// under, and this embedded copy gets the label below.
export const SKILL_SOURCE = 'plugin:web-search-perplexity'

/**
 * Render the embedded ESM module for skills/perplexity-research/SKILL.md.
 * Reads the markdown source and returns the file text; writes nothing.
 *
 * @returns {{ file: string, contentChars: number }}
 */
export function renderSkillModule() {
  const text = readFileSync(sourcePath, 'utf8')
  // Tolerate CRLF working trees: the canonical source is LF in the git index,
  // but a Windows checkout with core.autocrlf=true hands us CRLF.
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text)
  if (frontmatterMatch === null) {
    throw new Error(`${sourcePath} must start with YAML frontmatter (---)`)
  }

  const frontmatter = {}
  for (const line of frontmatterMatch[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const raw = line.slice(idx + 1).trim()
    const value = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw
    frontmatter[key] = value
  }

  if (frontmatter.name !== 'perplexity-research') {
    throw new Error(`unexpected skill name in frontmatter: ${frontmatter.name}`)
  }
  if (typeof frontmatter.description !== 'string' || frontmatter.description.length === 0) {
    throw new Error('skill frontmatter must contain a non-empty description')
  }

  const content = text.slice(frontmatterMatch[0].length).replace(/\r\n/g, '\n').trimEnd() + '\n'
  const file = [
    '/** Generated from skills/perplexity-research/SKILL.md — do not edit by hand.',
    ' * Regenerate with: npm run build:skill',
    ' */',
    'export const PERPLEXITY_RESEARCH_SKILL = {',
    `  name: ${JSON.stringify(frontmatter.name)},`,
    `  description: ${JSON.stringify(frontmatter.description)},`,
    `  source: ${JSON.stringify(SKILL_SOURCE)},`,
    `  content: ${JSON.stringify(content)},`,
    '  invocation: { modelInvocable: true, userInvocable: true },',
    '}',
    '',
  ].join('\n')
  return { file, contentChars: content.length }
}

/** True when this module was started directly (`npm run build:skill`). */
function isMain() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  const { file, contentChars } = renderSkillModule()
  writeFileSync(targetPath, file, 'utf8')
  console.log(`wrote ${targetPath} (${contentChars} chars of skill content)`)
}
