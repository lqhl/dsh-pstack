#!/usr/bin/env node
/**
 * Build preset/cordis.patch.yml from the shipped `standard` preset plus the
 * pstack deltas. Keeping it generated makes the delta explicit and lets a DSH
 * upgrade refresh the base instead of hand-merging 150 lines.
 *
 *   node preset/build.mjs --refresh   # re-extract the base from the live profile
 *   node preset/build.mjs             # regenerate the patch
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const BASELINE = join(ROOT, 'vendor', 'baseline', 'standard.plugins.yml')
const OUT = join(HERE, 'cordis.patch.yml')
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME ?? '', '.dsh')
const PROFILE = process.env.DSH_PROFILE || 'web'

const bullets = (text, n) => {
  const lines = text.split('\n')
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
  return lines.map((line) => (line.trim() === '' ? '' : `${' '.repeat(n)}${line}`)).join('\n')
}

/** Split the base list into top-level entries, preserving each block verbatim. */
function splitEntries(text) {
  const entries = []
  for (const line of text.split('\n')) {
    if (line.startsWith('- id: ')) entries.push({ id: line.slice(6).trim(), lines: [line] })
    else if (entries.length > 0) entries.at(-1).lines.push(line)
    else if (line.trim() !== '') throw new Error(`unexpected line before the first entry: ${line}`)
  }
  return entries.map((entry) => ({ ...entry, text: entry.lines.join('\n').replace(/\n+$/, '') }))
}

/** Locate one entry by id at a known indent, since groups nest their children. */
function findEntry(lines, id, indent) {
  const target = `${' '.repeat(indent)}- id: ${id}`
  const start = lines.findIndex((line) => line === target)
  if (start < 0) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const entry = line.match(/^( *)- id: /)
    const lineIndent = line.match(/^ */)[0].length
    if (entry && entry[1].length <= indent) { end = index; break }
    if (!entry && lineIndent < indent) { end = index; break }
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  return { start, end }
}

function replaceEntry(text, id, indent, replacement) {
  const lines = text.split('\n')
  const range = findEntry(lines, id, indent)
  if (!range) throw new Error(`no ${' '.repeat(indent)}- id: ${id} row in the baseline`)
  lines.splice(range.start, range.end - range.start, ...replacement.split('\n'))
  return lines.join('\n')
}

function insertAfter(text, id, indent, block) {
  const lines = text.split('\n')
  const range = findEntry(lines, id, indent)
  if (!range) throw new Error(`no ${' '.repeat(indent)}- id: ${id} row in the baseline`)
  lines.splice(range.end, 0, ...block.split('\n'))
  return lines.join('\n')
}


function commentSicko() {
  const path = join(ROOT, 'vendor', 'pstack', 'agents', 'comment-sicko.md')
  const body = readFileSync(path, 'utf8').replace(/^---\n[\s\S]*?\n---\n+/, '')
  return body.trimEnd()
}

function persona(prefix) {
  return [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    prefix: |',
    bullets(
      prefix
        .trim()
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n'),
      6,
    ),
  ].join('\n')
}

const PSTACK_PERSONA = `
You are a coding agent powered by the {{model}} model.

You work in poteto mode. Before your first action on any task, read
${DSH_HOME}/skills/poteto-mode/SKILL.md in full and follow it, including its Principles
index and its playbooks, and resolve every relative path in those files against the
skill's own directory. Read ${DSH_HOME}/adapter/dsh.md once, before the first skill
step, and translate Cursor names with its tables. Name each principle that shaped a
decision and cite only principles whose leaf file you read this session.
`

const DELEGATE_PERSONA = `
You are operating as poteto-mode's full agent style. A parent owns the playbook, the
todo list, and every spawn; you are one delegate.

Before any work, read ${DSH_HOME}/skills/poteto-mode/SKILL.md in full, including its
Principles index, and read ${DSH_HOME}/adapter/dsh.md once. Navigate to a leaf
principle-* skill whenever you apply that principle. You cannot spawn subagents: own
the diff yourself, and report what you verified and how.
`

const READONLY_PERSONA = `
You investigate and report. You never write, edit, or delete a file, and you never run
a command that changes repository state. If the work needs a change, describe the
change in your report instead of making it.

Read ${DSH_HOME}/adapter/dsh.md once before your first tool call. Cite the file and
line for every claim about behavior, and say plainly when something is inferred
rather than observed.
`

function buildPstackPlugins(base) {
  const subagent = bullets(
    [
      '- id: tool-subagent',
      "  name: '@deepseek-ai/dsh-tool-subagent'",
      '  config:',
      '    provider: spawn',
      '    toolName: subagent',
      '    modelSelectionSettings: true',
      '    maxDepth: 2',
      '    agentPreset: poteto-agent',
      '    allowedAgentPresets:',
      '      - poteto-agent',
      '      - comment-sicko',
      '      - readonly-worker',
    ].join('\n'),
    4,
  )

  const readonlyTool = bullets(
    [
      '- id: subagent-readonly',
      "  name: '@deepseek-ai/dsh-tool-subagent'",
      '  config:',
      '    provider: spawn',
      '    toolName: subagent_readonly',
      '    maxDepth: 0',
      '    agentPreset: readonly-worker',
    ].join('\n'),
    4,
  )

  // persona is a top-level row; the delegation rows live inside the `delegation` group at indent 4.
  let text = replaceEntry(base, 'persona', 0, persona(PSTACK_PERSONA))
  text = replaceEntry(text, 'tool-subagent', 4, subagent)
  text = insertAfter(text, 'tool-subagent-fork', 4, readonlyTool)
  return text.replace(/\n+$/, '')
}

function buildDelegatePlugins(base) {
  const keep = [
    'agent-instructions',
    'time-context',
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'tool-jobs',
    'skill-filesystem',
    'tool-skill',
    'tool-ask-user',
    'tool-todo',
    'tool-web',
    'present',
    'compaction',
  ]
  const entries = new Map(splitEntries(base).map((entry) => [entry.id, entry]))
  const missing = keep.filter((id) => !entries.has(id))
  if (missing.length > 0) throw new Error(`the standard preset lost rows: ${missing.join(', ')}`)
  return [persona(DELEGATE_PERSONA), ...keep.map((id) => entries.get(id).text)].join('\n')
}

function buildCommentSickoPlugins(base) {
  const entries = new Map(splitEntries(base).map((entry) => [entry.id, entry]))
  return [
    persona(commentSicko()),
    entries.get('tool-bash').text,
    entries.get('tool-pwsh').text,
    entries.get('tool-fs').text,
    entries.get('tool-fs-search').text,
  ].join('\n')
}

function buildReadonlyPlugins(base) {
  const entries = new Map(splitEntries(base).map((entry) => [entry.id, entry]))
  return [
    persona(READONLY_PERSONA),
    entries.get('tool-fs').text,
    entries.get('tool-fs-search').text,
    entries.get('tool-todo').text,
  ].join('\n')
}

function refresh() {
  const dump = execFileSync('dsh', ['--profile', PROFILE, '--dump-config'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const lines = dump.split('\n')
  const start = lines.findIndex((line) => line.startsWith('- id: preset-standard'))
  if (start < 0) throw new Error(`profile ${PROFILE} has no preset-standard row`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('- id: preset-'))
  const block = lines.slice(start, end < 0 ? undefined : end)
  const plugins = block.findIndex((line) => line.trim() === 'plugins:')
  if (plugins < 0) throw new Error('preset-standard has no plugins list')
  const body = block
    .slice(plugins + 1)
    .filter((line) => line.trim() !== '')
    .map((line) => (line.startsWith('      ') ? line.slice(6) : line))
  mkdirSync(dirname(BASELINE), { recursive: true })
  writeFileSync(BASELINE, `${body.join('\n')}\n`)
  console.log(`baseline refreshed from profile ${PROFILE}: ${body.length} lines`)
}

if (process.argv.includes('--refresh')) {
  refresh()
} else {
  if (!existsSync(BASELINE)) throw new Error(`missing ${BASELINE}; run node preset/build.mjs --refresh`)
  const base = readFileSync(BASELINE, 'utf8')
  const presets = [
    {
      id: 'pstack',
      name: 'pstack',
      description: 'Poteto mode: rigorous pstack workflows with per-role subagent models.',
      order: 10,
      plugins: buildPstackPlugins(base),
    },
    {
      id: 'poteto-agent',
      name: 'poteto agent',
      description: 'pstack delegate for one scoped task. Cannot spawn further subagents.',
      order: 11,
      plugins: buildDelegatePlugins(base),
    },
    {
      id: 'comment-sicko',
      name: 'comment sicko',
      description: 'Reviews code and comments, deletes slop, and reports MUST KILL targets.',
      order: 12,
      plugins: buildCommentSickoPlugins(base),
    },
    {
      id: 'readonly-worker',
      name: 'readonly worker',
      description: 'Read-only investigator that reports evidence and never edits files.',
      order: 13,
      plugins: buildReadonlyPlugins(base),
    },
  ]

  const out = [
    '# Generated by preset/build.mjs from vendor/baseline/standard.plugins.yml.',
    '# Do not edit by hand: edit build.mjs, then run `make preset`.',
    '#',
    '# Delta against the shipped `standard` preset:',
    '#   1. persona carries the poteto-mode bootstrap (read the entry skill, then the adapter).',
    '#   2. tool-subagent selects a child preset, allows three, and raises depth to 2.',
    '#   3. subagent_readonly mounts a read-only child preset.',
    '#   4. four presets are declared: pstack, poteto-agent, comment-sicko, readonly-worker.',
    '- insert:',
  ]
  for (const preset of presets) {
    out.push(`    - id: preset-${preset.id}`)
    out.push("      name: '@deepseek-ai/dsh-agent-preset'")
    out.push('      config:')
    out.push(`        id: ${preset.id}`)
    out.push(`        name: '${preset.name.replaceAll("'", "''")}'`)
    out.push(`        description: '${preset.description.replaceAll("'", "''")}'`)
    out.push(`        order: ${preset.order}`)
    out.push('        plugins:')
    out.push(bullets(preset.plugins, 10))
  }
  writeFileSync(OUT, `${out.join('\n')}\n`)
  console.log(`wrote ${OUT} (${out.length} lines, ${presets.length} presets)`)
}
