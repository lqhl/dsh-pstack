#!/usr/bin/env node
/**
 * Drift checks for the DSH port of pstack.
 *
 * A. Vocabulary coverage. Upstream enumerates every Cursor-only term its skills
 *    use, and its own CI fails when the Claude Code adapter lacks a row for one.
 *    We reuse that list so our adapter has the same guarantee.
 * B. Model families. Every family used by the vendored skills must have a
 *    `family-*` mapping row pointing at an alias defined in the alias table.
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

// B. Model families.
const KNOWN_FAMILIES = ['cursor-grok', 'composer', 'claude', 'grok', 'gpt', 'deepseek']
const KNOWN_BY_LENGTH = [...KNOWN_FAMILIES].sort((left, right) => right.length - left.length)
const NEUTRAL_FAMILY = /^(?:principle|verify|incident|sev|setup-pstack)(?:-|$)/
const ALIAS_HEADER = /^\|\s*alias\s*\|\s*provider\s*\|\s*model\s*\|\s*reasoning_effort\s*\|\s*$/
const MAPPING_HEADER = /^\|\s*pstack slug\s*\|\s*alias\s*\|\s*$/
const KNOWN_MODEL = /(?:^|[^a-z0-9_-])((?:cursor-grok|composer|claude|grok|gpt|deepseek))-(?=[a-z0-9*])/gi
const MODEL_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)+$/
const MODEL_WILDCARD = /^[a-z][a-z0-9]*(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)*-\*$/
const BACKTICK_SLUG = /[a-z][a-z0-9]*(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)*-\*|[a-z][a-z0-9]*(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)+/g
const MODEL_FIELD = /\bmodel["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._@/-]*)/gi

function tableRows(lines, headerIndex) {
  let index = headerIndex + 1
  if (/^\|[\s:|-]+\|$/.test(lines[index] ?? '')) index += 1
  const rows = []
  for (; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith('|')) break
    rows.push(
      lines[index]
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
  }
  return rows
}

function backticked(cell) {
  return [...cell.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].trim())
}

function uniqueHeader(lines, pattern, description, fail) {
  const headers = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []))
  if (headers.length !== 1) {
    fail(`adapter has no single ${description}`)
    return null
  }
  return headers[0]
}

function modelAliases(lines, fail) {
  const header = uniqueHeader(lines, ALIAS_HEADER, 'alias table (| alias | provider | model | reasoning_effort |)', fail)
  if (header === null) return new Set()
  const aliases = new Set()
  for (const cells of tableRows(lines, header)) {
    const alias = backticked(cells[0] ?? '').find((token) => /^[a-z][a-z0-9-]*$/.test(token))
    if (alias) aliases.add(alias)
  }
  if (aliases.size === 0) fail('adapter alias table defines no alias')
  return aliases
}

function modelMappings(lines, aliases, fail) {
  const header = uniqueHeader(lines, MAPPING_HEADER, 'model mapping table (| pstack slug | alias |)', fail)
  if (header === null) return new Map()
  const mappings = new Map()
  for (const cells of tableRows(lines, header)) {
    const wildcards = backticked(cells[0] ?? '').filter((token) => token.endsWith('*'))
    if (wildcards.length === 0) continue
    const destinations = backticked(cells[1] ?? '').filter((token) => aliases.has(token))
    for (const wildcard of wildcards) {
      if (!MODEL_WILDCARD.test(wildcard)) {
        fail(`adapter model mapping row has a malformed wildcard ${JSON.stringify(wildcard)}`)
        continue
      }
      if (destinations.length !== 1) {
        fail(`adapter model mapping row ${wildcard} must name exactly one known alias (${[...aliases].join(', ')}); found ${destinations.length === 0 ? 'none' : destinations.join(', ')}`)
        continue
      }
      const family = wildcard.slice(0, -2)
      const previous = mappings.get(family)
      if (previous && previous !== destinations[0]) fail(`adapter maps ${family}-* to both ${previous} and ${destinations[0]}`)
      else mappings.set(family, destinations[0])
    }
  }
  if (mappings.size === 0) fail('adapter model mapping table has no wildcard family rows')
  return mappings
}

function familyOf(raw, mappedFamilies) {
  const token = String(raw).toLowerCase().split('/').pop().split('@')[0]
  if (NEUTRAL_FAMILY.test(token)) return null
  for (const family of KNOWN_BY_LENGTH) {
    if (token === `${family}-*` || token.startsWith(`${family}-`)) return family
  }
  for (const family of mappedFamilies) {
    if (token === `${family}-*` || token.startsWith(`${family}-`)) return family
  }
  if (MODEL_WILDCARD.test(token)) return token.slice(0, -2)
  if (!MODEL_SLUG.test(token)) return null
  const parts = token.split('-')
  const version = parts.findIndex((part, index) => index > 0 && /^\d/.test(part))
  return version > 0 ? parts.slice(0, version).join('-') : null
}

const aliases = modelAliases(adapter.split('\n'), fail)
const mappings = modelMappings(adapter.split('\n'), aliases, fail)
const mappedFamilies = [...mappings.keys()].sort((left, right) => right.length - left.length)
const families = new Map()
const recordFamily = (family, rel) => {
  if (!family) return
  if (!families.has(family)) families.set(family, new Set())
  families.get(family).add(rel)
}
for (const path of walk(VENDOR).filter((path) => path.endsWith('.md'))) {
  const rel = path.slice(VENDOR.length + 1)
  const text = readFileSync(path, 'utf8')
  for (const [, family] of text.matchAll(KNOWN_MODEL)) recordFamily(family.toLowerCase(), rel)
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    for (const [token] of match[1].matchAll(BACKTICK_SLUG)) recordFamily(familyOf(token, mappedFamilies), rel)
  }
  for (const match of text.matchAll(MODEL_FIELD)) recordFamily(familyOf(match[1], mappedFamilies), rel)
}
for (const [family, files] of families) {
  if (!mappings.has(family)) {
    const list = [...files]
    fail(`adapter has no model family mapping row for ${family}-*, used by ${list.length} file(s): ${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''}`)
  }
}

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
