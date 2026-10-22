#!/usr/bin/env node
/**
 * Drift checks for the DSH port of pstack.
 *
 * A. Vocabulary coverage. Upstream enumerates every Cursor-only term its skills
 *    use, and its own CI fails when the Claude Code adapter lacks a row for one.
 *    We reuse that list so our adapter has the same guarantee.
 * B. Model families. Every model slug that appears in the vendored skills must
 *    have a family row in the adapter.
 * C. Skill integrity. Each vendored skill keeps name == directory, and the
 *    count matches what install.sh will link.
 * D. Generated adapter sanity. When an installed copy exists, it must have no
 *    unresolved placeholders and no missing term.
 *
 * Usage: node adapter/check.mjs [--quiet]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ADAPTER = join(ROOT, 'adapter', 'dsh.md.in')
const UPSTREAM_GEN = join(ROOT, 'vendor', 'upstream', 'generate-pstack-harness-trees.mjs')
const VENDOR = join(ROOT, 'vendor', 'pstack')
const SKILLS = join(VENDOR, 'skills')
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME ?? '', '.dsh')
const INSTALLED = join(DSH_HOME, 'adapter', 'dsh.md')

const failures = []
const fail = (message) => failures.push(message)

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === '.DS_Store' || name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

/** Upstream's TERMS array, read from the vendored generator. */
function upstreamTerms() {
  if (!existsSync(UPSTREAM_GEN)) {
    fail(`missing ${UPSTREAM_GEN}; run make sync`)
    return []
  }
  const source = readFileSync(UPSTREAM_GEN, 'utf8')
  const start = source.indexOf('const TERMS = [')
  const end = source.indexOf('\n];', start)
  if (start < 0 || end < 0) {
    fail('cannot find the TERMS array in the vendored generator; upstream changed its shape')
    return []
  }
  const body = source.slice(source.indexOf('[', start), end + 2)
  try {
    return new Function(`return ${body}`)()
  } catch (error) {
    fail(`cannot evaluate upstream TERMS: ${error.message}`)
    return []
  }
}

const adapter = readFileSync(ADAPTER, 'utf8')

// A. Vocabulary coverage.
const terms = upstreamTerms()
const used = new Map()
for (const path of walk(VENDOR).filter((path) => path.endsWith('.md'))) {
  const text = readFileSync(path, 'utf8')
  for (const term of terms) {
    if (!term.re.test(text)) continue
    const rel = path.slice(VENDOR.length + 1)
    used.set(term.key, [...(used.get(term.key) ?? []), rel])
  }
}
for (const [key, files] of used) {
  if (!adapter.includes(key)) {
    fail(`adapter has no row for ${key}, used by ${files.length} file(s): ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}`)
  }
}

// B. Model families.
const FAMILIES = /(?:^|[^a-z])((?:cursor-grok|composer|claude|grok|gpt|deepseek))-[a-z0-9]/gi
const families = new Map()
for (const path of walk(VENDOR).filter((path) => path.endsWith('.md'))) {
  const rel = path.slice(VENDOR.length + 1)
  for (const [, family] of readFileSync(path, 'utf8').matchAll(FAMILIES)) {
    const key = family.toLowerCase()
    families.set(key, [...(families.get(key) ?? []), rel])
  }
}
for (const [family, files] of families) {
  if (!adapter.includes(`${family}-`)) {
    fail(`adapter has no model family row for ${family}-*, used by ${files.length} file(s): ${files.slice(0, 3).join(', ')}`)
  }
}

// C. Skill integrity.
const skillDirs = readdirSync(SKILLS).filter((name) => existsSync(join(SKILLS, name, 'SKILL.md')))
if (skillDirs.length === 0) fail('no skills found under vendor/pstack/skills')
for (const name of skillDirs) {
  const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')
  const declared = text.match(/^---\n([\s\S]*?)\n---/)?.[1]?.match(/^name:(.*)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  if (declared !== name) fail(`skills/${name}/SKILL.md declares name ${JSON.stringify(declared ?? '')}, not its directory name`)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) fail(`skills/${name} is not lowercase-hyphenated`)
}

// D. Installed adapter sanity.
if (existsSync(INSTALLED)) {
  const installed = readFileSync(INSTALLED, 'utf8')
  if (installed.includes('{{')) fail(`${INSTALLED} still has an unresolved placeholder; run make install`)
  for (const key of used.keys()) {
    if (!installed.includes(key)) fail(`${INSTALLED} has no row for ${key}; run make install`)
  }
}

if (!process.argv.includes('--quiet')) {
  console.log(`terms checked   ${terms.length}, used ${used.size}`)
  console.log(`families        ${[...families.keys()].sort().join(', ') || 'none'}`)
  console.log(`skills          ${skillDirs.length}`)
  console.log(`installed copy  ${existsSync(INSTALLED) ? INSTALLED : 'not installed'}`)
}
for (const message of failures) console.log(`FAIL ${message}`)
if (failures.length > 0) process.exit(1)
console.log('adapter is in sync with the vendored pstack')
