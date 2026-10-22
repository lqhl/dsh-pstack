#!/usr/bin/env node
/**
 * Installed-state checks for the DSH port of pstack.
 *
 * `make check` proves the repo is internally consistent. This proves `make
 * install` produced what the adapter and the preset bundle promise: the stable
 * pstack path, one link per vendored skill, the rendered adapter and AGENTS.md
 * block, and the four preset rows in the repo and the live profile.
 *
 * Usage: node smoke.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const VENDOR = join(ROOT, 'vendor', 'pstack')
const SKILLS = join(VENDOR, 'skills')
const ADAPTER_IN = join(ROOT, 'adapter', 'dsh.md.in')
const FRAGMENT_IN = join(ROOT, 'agents-fragment.md.in')
const PRESET_FILE = join(ROOT, 'preset', 'cordis.patch.yml')
const DSH_HOME = resolve(process.env.DSH_HOME || join(process.env.HOME ?? '', '.dsh'))
const PROFILE = process.env.DSH_PROFILE || 'web'
const PRESETS = ['pstack', 'poteto-agent', 'comment-sicko', 'readonly-worker']
const BEGIN = '<!-- pstack:begin -->'
const END = '<!-- pstack:end -->'

const failures = []
const fail = (message) => failures.push(message)

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function realpathOrNull(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** The substitution install.sh performs with sed. */
function render(path) {
  const text = readText(path)
  return text === null ? null : text.split('{{DSH_HOME}}').join(DSH_HOME)
}

function trimTrailingNewlines(text) {
  return text.replace(/\n+$/, '')
}

function firstDiffLine(expected, actual) {
  const left = expected.split('\n')
  const right = actual.split('\n')
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] !== right[index]) return index + 1
  }
  return null
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

function expectedSkills() {
  if (!existsSync(SKILLS)) {
    fail(`vendored skills ${SKILLS}: missing; run make sync`)
    return null
  }
  return readdirSync(SKILLS)
    .filter((name) => existsSync(join(SKILLS, name, 'SKILL.md')))
    .sort()
}

function checkStablePath() {
  const link = join(DSH_HOME, 'pstack')
  const expected = realpathOrNull(VENDOR)
  if (expected === null) {
    fail(`vendored pstack ${VENDOR}: missing; run make sync`)
    return
  }
  if (!isSymlink(link)) {
    fail(`stable path ${link}: ${existsSync(link) ? 'is not a symlink' : 'missing'}, expected a symlink to ${VENDOR}; run make install`)
    return
  }
  const target = realpathOrNull(link)
  if (target === null) {
    fail(`stable path ${link}: readlink ${readlinkSync(link)} does not resolve; run make install`)
    return
  }
  if (target !== expected) {
    fail(`stable path ${link}: resolves to ${target}, expected ${expected}; run make install`)
  }
}

function checkSkillLinks(expected) {
  if (expected === null) return
  const dir = join(DSH_HOME, 'skills')
  if (!existsSync(dir)) {
    fail(`skill links ${dir}: directory missing; run make install`)
    return
  }
  for (const name of expected) {
    const link = join(dir, name)
    const relative = `../pstack/skills/${name}`
    if (!isSymlink(link)) {
      fail(`skill link ${link}: ${existsSync(link) ? 'not a symlink' : 'missing'}, expected -> ${relative}; run make install`)
      continue
    }
    const target = readlinkSync(link)
    if (target !== relative) {
      fail(`skill link ${link}: readlink is ${target}, expected ${relative}; run make install`)
      continue
    }
    if (realpathOrNull(link) === null) {
      fail(`skill link ${link}: target ${relative} does not resolve; run make install`)
    }
  }
  const known = new Set(expected)
  for (const name of readdirSync(dir)) {
    if (known.has(name)) continue
    const link = join(dir, name)
    if (!isSymlink(link)) continue
    const target = readlinkSync(link)
    if (target.startsWith('../pstack/skills/')) {
      fail(`stale skill link ${link}: readlink is ${target}, but no vendored skill is named ${name}; run make install`)
    }
  }
}

function checkAdapter() {
  const installed = join(DSH_HOME, 'adapter', 'dsh.md')
  const expected = render(ADAPTER_IN)
  if (expected === null) {
    fail(`adapter template ${ADAPTER_IN}: missing; restore it from git`)
    return
  }
  const actual = readText(installed)
  if (actual === null) {
    fail(`adapter ${installed}: missing; run make install`)
    return
  }
  if (actual !== expected) {
    fail(`adapter ${installed}: differs from ${ADAPTER_IN} at line ${firstDiffLine(expected, actual)}; run make install`)
  }
}

function checkAgentsBlock() {
  const path = join(DSH_HOME, 'AGENTS.md')
  const expected = render(FRAGMENT_IN)
  if (expected === null) {
    fail(`AGENTS fragment ${FRAGMENT_IN}: missing; restore it from git`)
    return
  }
  const text = readText(path)
  if (text === null) {
    fail(`AGENTS block ${path}: file missing; run make install`)
    return
  }
  const begins = countOccurrences(text, BEGIN)
  const ends = countOccurrences(text, END)
  if (begins !== 1 || ends !== 1) {
    fail(`AGENTS block ${path}: found ${begins} begin and ${ends} end markers, expected one each; run make install`)
    return
  }
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (start > end) {
    fail(`AGENTS block ${path}: begin marker comes after end marker; run make install`)
    return
  }
  const wanted = trimTrailingNewlines(expected)
  const found = trimTrailingNewlines(text.slice(start, end + END.length))
  if (found !== wanted) {
    fail(`AGENTS block ${path}: differs from ${FRAGMENT_IN} at block line ${firstDiffLine(wanted, found)}; run make install`)
  }
}

function presetRow(id) {
  return new RegExp(`^\\s*- id: preset-${id}\\s*$`, 'm')
}

function checkPresetRows() {
  const repo = readText(PRESET_FILE)
  if (repo === null) {
    fail(`preset file ${PRESET_FILE}: missing; run make preset`)
  } else {
    for (const id of PRESETS) {
      if (!presetRow(id).test(repo)) {
        fail(`preset row ${PRESET_FILE}: missing - id: preset-${id}; run make preset`)
      }
    }
  }

  const command = `dsh --profile ${PROFILE} --dump-config`
  const result = spawnSync('dsh', ['--profile', PROFILE, '--dump-config'], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) {
    fail(`live preset rows: cannot run \`${command}\`: ${result.error.message}; check dsh and profile ${PROFILE}`)
  } else if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim().split('\n')[0]
    fail(`live preset rows: \`${command}\` failed (exit ${result.status}): ${detail}; fix dsh or profile ${PROFILE}`)
  } else {
    for (const id of PRESETS) {
      if (!presetRow(id).test(result.stdout)) {
        fail(`live preset rows (profile ${PROFILE}): missing - id: preset-${id}; install the preset bundle for profile ${PROFILE}`)
      }
    }
  }
}

let expected = null
try {
  expected = expectedSkills()
  checkStablePath()
  checkSkillLinks(expected)
  checkAdapter()
  checkAgentsBlock()
  checkPresetRows()
} catch (error) {
  fail(`unexpected error: ${error.message}; rerun make install`)
}
for (const message of failures) console.log(`FAIL ${message}`)
if (failures.length > 0) process.exit(1)
console.log(`smoke ok: ${expected.length} skill links, adapter, AGENTS block, ${PRESETS.length} preset rows (profile ${PROFILE})`)
