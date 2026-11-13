#!/usr/bin/env node
/**
 * Build the agent-preset patch from the shipped `standard` preset plus the
 * pstack deltas. Keeping it generated makes the delta explicit and lets a DSH
 * upgrade refresh the base instead of hand-merging 150 lines.
 *
 *   node preset/build.mjs --refresh   # re-extract the base from the live profile
 *   node preset/build.mjs             # regenerate the local patch
 *
 * `buildPatch('package')` produces the npm-bundle variant: personas read files
 * inside the installed package and skill-filesystem points at ./skills.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractStandardPlugins } from '../lib/standard-preset.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const BASELINE = join(ROOT, 'vendor', 'baseline', 'standard.plugins.yml')
const OUT = join(HERE, 'cordis.patch.yml')
const DSH_HOME = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const PROFILE = process.env.DSH_PROFILE || 'web'
const PACKAGE = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
const PACKAGE_NAME = PACKAGE.name

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

/**
 * DSH 0.2.2 registers `list_agents` from `@deepseek-ai/dsh-tool-subagent-control`
 * and stops exporting `./list-agents`. DSH 0.2.1 kept that tool on a standalone
 * `tool-subagent-list-agents` row. Drop the row at build time so a baseline that
 * still contains it cannot emit the unexported subpath.
 */
const RETIRED_LIST_AGENTS_ID = 'tool-subagent-list-agents'
const RETIRED_LIST_AGENTS_PACKAGE = '@deepseek-ai/dsh-tool-subagent-control/list-agents'

function omitPluginId(text, id) {
  let current = text
  for (;;) {
    const lines = current.split('\n')
    const header = lines.find((line) => line.trim() === `- id: ${id}`)
    if (header === undefined) return current
    const indent = header.match(/^ */)[0].length
    const range = findEntry(lines, id, indent)
    if (!range) return current
    lines.splice(range.start, range.end - range.start)
    current = lines.join('\n')
  }
}

function omitRetiredListAgents(text) {
  let current = omitPluginId(text, RETIRED_LIST_AGENTS_ID)
  if (!current.includes(RETIRED_LIST_AGENTS_PACKAGE)) return current
  const lines = current.split('\n')
  const nameIndex = lines.findIndex((line) => line.includes(RETIRED_LIST_AGENTS_PACKAGE))
  let start = nameIndex
  while (start >= 0 && !/^- id: \S/.test(lines[start].trim())) start -= 1
  if (start < 0) throw new Error(`retired list-agents package has no plugin id at line ${nameIndex + 1}`)
  const id = lines[start].trim().slice('- id: '.length)
  current = omitPluginId(current, id)
  if (current.includes(RETIRED_LIST_AGENTS_PACKAGE) || current.includes(RETIRED_LIST_AGENTS_ID)) {
    throw new Error('baseline still references the retired list-agents plugin after removal')
  }
  return current
}

function assertNoRetiredListAgents(patch) {
  if (patch.includes(RETIRED_LIST_AGENTS_ID) || patch.includes(RETIRED_LIST_AGENTS_PACKAGE)) {
    throw new Error('generated preset still references the retired list-agents plugin')
  }
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

function personaRow(prefix) {
  return [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    `    prefix: ${prefix}`,
  ].join('\n')
}

/** Resolve the installed package root at mount time. */
function packageRootExpression() {
  return [
    "process.getBuiltinModule('node:path').join(",
    "process.getBuiltinModule('node:path').dirname(",
    `process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('${PACKAGE_NAME}/package.json')`,
    "), 'skills')",
  ].join('')
}

function personaExpression(file) {
  return [
    '!!js (() => { ',
    "const path = process.getBuiltinModule('node:path'); ",
    "const fs = process.getBuiltinModule('node:fs'); ",
    "const { createRequire } = process.getBuiltinModule('node:module'); ",
    `const root = path.dirname(createRequire(baseUrl).resolve('${PACKAGE_NAME}/package.json')); `,
    `return fs.readFileSync(path.join(root, 'personas/${file}.md'), 'utf8').replaceAll('{{PSTACK_SKILLS}}', path.join(root, 'skills')) `,
    '})()',
  ].join('')
}

function skillFilesystemRow() {
  return [
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '  config:',
    '    customSkillDirs:',
    `      - !!js ${packageRootExpression()}`,
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

function personaFor(mode, file, local) {
  return mode === 'package' ? personaRow(personaExpression(file)) : persona(local)
}

function buildPstackPlugins(base, mode) {
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
      // maxDepth 0 blocks this top-level child; the readonly-worker preset
      // mounts no delegation tool, so depth 1 still cannot fan out further.
      '    maxDepth: 1',
      '    agentPreset: readonly-worker',
    ].join('\n'),
    4,
  )

  // persona is a top-level row; the delegation rows live inside the `delegation` group at indent 4.
  let text = replaceEntry(base, 'persona', 0, personaFor(mode, 'pstack', PSTACK_PERSONA))
  if (mode === 'package') text = replaceEntry(text, 'skill-filesystem', 0, skillFilesystemRow())
  text = replaceEntry(text, 'tool-subagent', 4, subagent)
  text = insertAfter(text, 'tool-subagent-fork', 4, readonlyTool)
  return text.replace(/\n+$/, '')
}

function buildDelegatePlugins(base, mode) {
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
  const skillRow = mode === 'package' ? skillFilesystemRow() : entries.get('skill-filesystem').text
  const rows = keep.map((id) => (id === 'skill-filesystem' ? skillRow : entries.get(id).text))
  return [personaFor(mode, 'poteto-agent', DELEGATE_PERSONA), ...rows].join('\n')
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

function buildReadonlyPlugins(base, mode) {
  const entries = new Map(splitEntries(base).map((entry) => [entry.id, entry]))
  return [
    personaFor(mode, 'readonly-worker', READONLY_PERSONA),
    entries.get('tool-fs').text,
    entries.get('tool-fs-search').text,
    entries.get('tool-todo').text,
  ].join('\n')
}

function failureDetail(error) {
  const stderr = error?.stderr?.toString().trim().split('\n')[0]
  return stderr || error?.message || String(error)
}

export function refresh() {
  let dump
  try {
    dump = execFileSync('dsh', ['--profile', PROFILE, '--dump-config'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(`cannot run \`dsh --profile ${PROFILE} --dump-config\`: ${failureDetail(error)}`)
  }
  const { lines } = extractStandardPlugins(dump)
  mkdirSync(dirname(BASELINE), { recursive: true })
  writeFileSync(BASELINE, `${lines.join('\n')}\n`)
  console.log(`baseline refreshed from profile ${PROFILE}: ${lines.length} lines`)
}

/** @param {'local'|'package'} mode */
export function buildPatch(mode = 'local') {
  if (!existsSync(BASELINE)) throw new Error(`missing ${BASELINE}; run node preset/build.mjs --refresh`)
  const base = omitRetiredListAgents(readFileSync(BASELINE, 'utf8'))
  const presets = [
    {
      id: 'pstack',
      name: 'pstack',
      description: 'Poteto mode: rigorous pstack workflows with per-role subagent models.',
      order: 10,
      plugins: buildPstackPlugins(base, mode),
    },
    {
      id: 'poteto-agent',
      name: 'poteto agent',
      description: 'pstack delegate for one scoped task. Cannot spawn further subagents.',
      order: 11,
      plugins: buildDelegatePlugins(base, mode),
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
      plugins: buildReadonlyPlugins(base, mode),
    },
  ]

  const out = mode === 'package'
    ? [
        '# Generated by preset/build.mjs in package mode from vendor/baseline/standard.plugins.yml.',
        '# Do not edit by hand: edit build.mjs, then run `make package`.',
        '#',
        '# Package mode: personas read files inside the installed package, and',
        '# skill-filesystem points at the package skills directory.',
        '- insert:',
      ]
    : [
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
  const patch = `${out.join('\n')}\n`
  assertNoRetiredListAgents(patch)
  return patch
}

function buildLocal() {
  const patch = buildPatch('local')
  writeFileSync(OUT, patch)
  console.log(`wrote ${OUT} (${patch.split('\n').length - 1} lines, 4 presets)`)
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    if (process.argv.includes('--refresh')) refresh()
    else buildLocal()
  } catch (error) {
    console.error(`FAIL ${error.message}`)
    process.exit(1)
  }
}
