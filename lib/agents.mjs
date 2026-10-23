import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const BEGIN_MARKER = '<!-- pstack:begin -->'
export const END_MARKER = '<!-- pstack:end -->'

const BUDGET_PREFIX = '# budget'

/**
 * Resolve the DSH home once, so every caller renders and inspects the same
 * absolute path. os.homedir() honors $HOME where the platform sets one.
 */
export function resolveDshHome(env = process.env) {
  return resolve(env.DSH_HOME || join(homedir(), '.dsh'))
}

/** Literal replacement: a replacement string would expand $$, $&, $`, and $' in the home path. */
export function renderTemplate(text, dshHome) {
  return text.replaceAll('{{DSH_HOME}}', () => dshHome)
}

function lineRecords(text) {
  const records = []
  let start = 0
  for (;;) {
    const newline = text.indexOf('\n', start)
    const raw = newline < 0 ? text.slice(start) : text.slice(start, newline)
    records.push({
      raw,
      content: raw.endsWith('\r') ? raw.slice(0, -1) : raw,
      start,
      end: start + raw.length,
    })
    if (newline < 0) return records
    start = newline + 1
  }
}

function markerPair(text, label) {
  const records = lineRecords(text)
  const begins = records.filter((record) => record.content === BEGIN_MARKER)
  const ends = records.filter((record) => record.content === END_MARKER)
  const inline =
    text.split(BEGIN_MARKER).length - 1 - begins.length + (text.split(END_MARKER).length - 1 - ends.length)
  if (inline > 0) throw new Error(`${label} markers must each stand alone on their own line`)
  if (begins.length === 0 && ends.length === 0) return null
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(`${label} needs one begin and one end marker; found ${begins.length} begin and ${ends.length} end`)
  }
  if (begins[0].start > ends[0].start) throw new Error(`${label} end marker comes before the begin marker`)
  return { begin: begins[0], end: ends[0] }
}

function splitAgents(text) {
  const pair = markerPair(text, 'AGENTS.md')
  if (pair === null) return { kind: 'fresh', before: text, after: '' }
  return {
    kind: 'block',
    before: text.slice(0, pair.begin.start),
    block: text.slice(pair.begin.start, pair.end.end),
    after: text.slice(pair.end.end),
  }
}

function parseRoleLine(record, label, lineNumber) {
  const colon = record.content.indexOf(':')
  if (colon < 0) throw new Error(`${label} line ${lineNumber} is not a role assignment: ${record.content.trim()}`)
  const labels = record.content.slice(0, colon).trim()
  const value = record.content.slice(colon + 1).trim()
  if (labels === '') throw new Error(`${label} line ${lineNumber} has no role label`)
  if (value === '') throw new Error(`${label} line ${lineNumber} has no value for ${labels}`)
  const roles = labels.split(',').map((role) => role.trim())
  if (roles.some((role) => role === '')) throw new Error(`${label} line ${lineNumber} has an empty role label`)
  if (new Set(roles).size !== roles.length) {
    throw new Error(`${label} line ${lineNumber} assigns the same role twice: ${labels}`)
  }
  return { content: record.content, roles, value }
}

function hasRoleAssignment(content, supported) {
  if (content.trimStart().startsWith('#')) return false
  const colon = content.indexOf(':')
  if (colon < 0) return false
  const roles = content.slice(0, colon).split(',').map((role) => role.trim())
  return roles.every((role) => supported.has(role))
}

function parseBlock(block, label, { template, supported }) {
  const records = lineRecords(block)
  if (records.length < 2 || records.at(-1).content !== END_MARKER) {
    throw new Error(`${label} marker pair is malformed`)
  }
  const inner = records.slice(1, -1)
  const budgetIndexes = []
  inner.forEach((record, index) => {
    if (record.content.startsWith(BUDGET_PREFIX)) budgetIndexes.push(index)
  })
  if (budgetIndexes.length > 1) {
    throw new Error(`${label} has ${budgetIndexes.length} '# budget' lines; expected at most one`)
  }
  if (template && budgetIndexes.length === 0) throw new Error(`${label} has no '# budget' line`)
  const budgetIndex = budgetIndexes[0] ?? -1
  if (!template && budgetIndex < 0 && supported) {
    const assigned = inner.find((record) => hasRoleAssignment(record.content, supported))
    if (assigned) {
      throw new Error(`${label} has role assignments but no '# budget' line; add the line or reinstall with a restored block`)
    }
  }
  const prefix = budgetIndex < 0 ? inner : inner.slice(0, budgetIndex)
  const tail = budgetIndex < 0 ? [] : inner.slice(budgetIndex + 1)
  const roleLines = []
  const seen = new Map()
  for (const [index, record] of tail.entries()) {
    if (record.content.trim() === '') continue
    const line = parseRoleLine(record, label, budgetIndex + 2 + index)
    for (const role of line.roles) {
      if (supported && !supported.has(role)) {
        throw new Error(`${label} assigns unsupported role ${role}; roles come from agents-fragment.md.in`)
      }
      if (seen.has(role)) throw new Error(`${label} assigns role ${role} more than once`)
      seen.set(role, line)
    }
    roleLines.push(line)
  }
  const known = supported ?? new Set(seen.keys())
  const misplaced = prefix.find((record) => hasRoleAssignment(record.content, known))
  if (misplaced) throw new Error(`${label} has a role assignment before its '# budget' line: ${misplaced.content.trim()}`)
  return {
    prefix,
    budgetLine: budgetIndex < 0 ? null : inner[budgetIndex],
    roleLines,
  }
}

export function parseTemplate(text) {
  const pair = markerPair(text, 'agents fragment')
  if (pair === null) throw new Error('agents fragment has no pstack marker pair')
  if (text.slice(0, pair.begin.start).trim() !== '' || text.slice(pair.end.end).trim() !== '') {
    throw new Error('agents fragment has content outside its marker pair')
  }
  const block = text.slice(pair.begin.start, pair.end.end)
  const parsed = parseBlock(block, 'agents fragment', { template: true, supported: null })
  const roles = new Set(parsed.roleLines.flatMap((line) => line.roles))
  return { ...parsed, roles, block }
}

function parseInstalled(block, template, { requireComplete }) {
  const parsed = parseBlock(block, 'AGENTS.md', { template: false, supported: template.roles })
  const present = new Set(parsed.roleLines.flatMap((line) => line.roles))
  if (requireComplete) {
    for (const role of template.roles) {
      if (!present.has(role)) throw new Error(`AGENTS.md is missing the role assignment for ${role}; run make install`)
    }
  }
  return { ...parsed, roles: present }
}

function renderBlock(template, installed) {
  const budget = installed?.budgetLine?.content ?? template.budgetLine.content
  const roleLines = installed?.roleLines.map((line) => line.content) ?? []
  const present = new Set(installed?.roles ?? [])
  const missing = []
  for (const line of template.roleLines) {
    const roles = line.roles.filter((role) => !present.has(role))
    if (roles.length > 0) missing.push(`${roles.join(', ')}: ${line.value}`)
  }
  return [
    BEGIN_MARKER,
    ...template.prefix.map((record) => record.content),
    budget,
    ...roleLines,
    ...missing,
    END_MARKER,
  ].join('\n')
}

export function renderAgents(existingText, templateText) {
  const template = parseTemplate(templateText)
  const split = splitAgents(existingText)
  if (split.kind === 'fresh') {
    const block = renderBlock(template, null)
    return existingText === '' ? `${block}\n` : `${existingText}${existingText.endsWith('\n') ? '' : '\n'}\n${block}\n`
  }
  const installed = parseInstalled(split.block, template, { requireComplete: false })
  return `${split.before}${renderBlock(template, installed)}${split.after}`
}

export function validateInstalledAgents(text, templateText) {
  const template = parseTemplate(templateText)
  const split = splitAgents(text)
  if (split.kind === 'fresh') throw new Error('AGENTS.md has no pstack block; run make install')
  const installed = parseInstalled(split.block, template, { requireComplete: true })
  if (installed.budgetLine === null) throw new Error('AGENTS.md block has no # budget line; run make install')

  const expected = template.prefix.map((record) => record.content.trimEnd()).filter((line) => line.trim() !== '')
  const actual = installed.prefix.map((record) => record.content.trimEnd()).filter((line) => line.trim() !== '')
  const length = Math.max(expected.length, actual.length)
  for (let index = 0; index < length; index += 1) {
    if (expected[index] === actual[index]) continue
    const detail = `expected ${JSON.stringify(expected[index] ?? '(end)')}, found ${JSON.stringify(actual[index] ?? '(end)')}`
    throw new Error(`AGENTS.md block managed content differs from agents-fragment.md.in at line ${index + 1}: ${detail}`)
  }
}
