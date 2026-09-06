/**
 * Generate src/skill.js from the canonical markdown skill source.
 *
 * The skill is authored as skills/perplexity-research/SKILL.md so it
 * can be reviewed and edited as plain markdown. This script reads that file,
 * extracts the YAML frontmatter, and writes the embedded ESM module the plugin
 * imports at runtime. Run it before publishing or after editing the skill:
 *
 *   npm run build:skill
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(root, 'skills/perplexity-research/SKILL.md')
const targetPath = resolve(root, 'src/skill.js')

const text = readFileSync(sourcePath, 'utf8')
if (!text.startsWith('---\n')) {
  throw new Error(`${sourcePath} must start with YAML frontmatter (---)`)
}
const end = text.indexOf('\n---', 3)
if (end === -1) {
  throw new Error(`${sourcePath} has no closing --- for the frontmatter`)
}

const frontmatter = {}
for (const line of text.slice(3, end).split(/\r?\n/)) {
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

const content = text.slice(end + 4).trimEnd() + '\n'
const generated = [
  '/** Generated from skills/perplexity-research/SKILL.md — do not edit by hand.',
  ' * Regenerate with: npm run build:skill',
  ' */',
  'export const PERPLEXITY_RESEARCH_SKILL = {',
  `  name: ${JSON.stringify(frontmatter.name)},`,
  `  description: ${JSON.stringify(frontmatter.description)},`,
  `  content: ${JSON.stringify(content)},`,
  '  invocation: { modelInvocable: true, userInvocable: true },',
  '}',
  '',
].join('\n')

writeFileSync(targetPath, generated, 'utf8')
console.log(`wrote ${targetPath} (${content.length} chars of skill content)`)
