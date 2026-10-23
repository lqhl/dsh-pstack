#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderAgents, renderTemplate, resolveDshHome } from './lib/agents.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const VENDOR = join(ROOT, 'vendor', 'pstack')
const SKILLS = join(VENDOR, 'skills')
const ADAPTER_IN = join(ROOT, 'adapter', 'dsh.md.in')
const FRAGMENT_IN = join(ROOT, 'agents-fragment.md.in')
const PRESET_DIR = join(ROOT, 'preset')
const PRESET_SCRIPT = join(PRESET_DIR, 'build.mjs')
const PRESET_FILE = join(PRESET_DIR, 'cordis.patch.yml')

function statOrNull(path) {
  try {
    return statSync(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw new Error(`cannot inspect ${path}: ${error.message}`)
  }
}

function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw new Error(`cannot inspect ${path}: ${error.message}`)
  }
}

function readText(path, label) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw new Error(`cannot read ${label} ${path}: ${error.message}`)
  }
}

function readRequired(path, label) {
  const text = readText(path, label)
  if (text === null) throw new Error(`missing ${label} ${path}; restore it from git`)
  return text
}

function realpathOrNull(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function preflightDirectory(path, label) {
  const stat = statOrNull(path)
  if (stat !== null && !stat.isDirectory()) {
    throw new Error(`${label} ${path} exists and is not a directory`)
  }
}

function skillNames() {
  const stat = statOrNull(SKILLS)
  if (stat === null || !stat.isDirectory()) {
    throw new Error(`vendored skills ${SKILLS} is missing; run make sync`)
  }
  const names = readdirSync(SKILLS)
    .filter((name) => statOrNull(join(SKILLS, name, 'SKILL.md'))?.isFile())
    .sort()
  if (names.length === 0) throw new Error(`vendored skills ${SKILLS} is empty; run make sync`)
  return names
}

function isOwnedSkillTarget(target) {
  return target.startsWith('../pstack/skills/')
}

function isOwnedStableTarget(target) {
  const normalized = target.replaceAll('\\', '/')
  return normalized === VENDOR.replaceAll('\\', '/') || /(?:^|\/)vendor\/pstack\/?$/.test(normalized)
}

function planStableLink(dshHome) {
  const path = join(dshHome, 'pstack')
  const entry = lstatOrNull(path)
  if (entry === null) return { path, action: 'create' }
  if (!entry.isSymbolicLink()) {
    throw new Error(`stable path ${path} exists and is not a symlink; move it aside`)
  }
  const target = readlinkSync(path)
  const resolved = realpathOrNull(path)
  if (resolved !== null && resolved === realpathOrNull(VENDOR)) return { path, action: 'none' }
  if (isOwnedStableTarget(target)) return { path, action: 'replace' }
  throw new Error(`stable path ${path} points to ${target}, which is not this checkout's vendor/pstack; move it aside`)
}

function planSkillLinks(dshHome, names) {
  const dir = join(dshHome, 'skills')
  const entries = new Map()
  let existing = []
  try {
    existing = readdirSync(dir)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`cannot read ${dir}: ${error.message}`)
  }
  for (const name of existing) {
    entries.set(name, { path: join(dir, name), entry: lstatOrNull(join(dir, name)) })
  }

  const expected = new Set(names)
  const change = []
  for (const name of names) {
    const path = join(dir, name)
    const current = entries.get(name)
    const desired = `../pstack/skills/${name}`
    if (current === undefined || current.entry === null) {
      change.push({ path, target: desired })
      continue
    }
    if (!current.entry.isSymbolicLink()) {
      throw new Error(`skill destination ${path} exists and is not a symlink; move it aside`)
    }
    const target = readlinkSync(path)
    if (!isOwnedSkillTarget(target)) {
      throw new Error(`skill destination ${path} points to ${target}, not ../pstack/skills/; move it aside`)
    }
    if (target !== desired) change.push({ path, target: desired })
  }

  const prune = []
  for (const [name, current] of entries) {
    if (expected.has(name) || current.entry === null || !current.entry.isSymbolicLink()) continue
    if (isOwnedSkillTarget(readlinkSync(current.path))) prune.push(current.path)
  }
  return { change, prune }
}

function planFile(path, label) {
  const entry = lstatOrNull(path)
  if (entry === null) return { path, target: path, mode: null }
  if (!entry.isSymbolicLink()) {
    if (!entry.isFile()) throw new Error(`${label} ${path} exists and is not a regular file`)
    return { path, target: path, mode: entry.mode & 0o7777 }
  }
  const target = realpathOrNull(path)
  if (target === null) {
    throw new Error(`${label} ${path} is a symlink that does not resolve; fix its target or replace it`)
  }
  const stat = statSync(target)
  if (!stat.isFile()) throw new Error(`${label} ${path} resolves to ${target}, which is not a regular file`)
  return { path, target, mode: stat.mode & 0o7777 }
}

function failureLine(result) {
  for (const text of [result.stderr, result.stdout]) {
    const lines = String(text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    const error = [...lines].reverse().find((line) => /^Error(?:\s|\[|:)/.test(line))
    if (error !== undefined) return error
    if (lines.length > 0) return lines.at(-1)
  }
  return 'no output'
}

function runPresetBuild(dshHome) {
  if (!existsSync(PRESET_SCRIPT)) throw new Error(`missing ${PRESET_SCRIPT}; restore it from git`)
  const result = spawnSync(process.execPath, [PRESET_SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
    timeout: 120000,
  })
  if (result.error) throw new Error(`preset generation could not run: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`preset generation failed (exit ${result.status}): ${failureLine(result)}`)
  }
  if (!existsSync(PRESET_FILE)) {
    throw new Error(`preset generation finished but ${PRESET_FILE} is missing`)
  }
}

function replaceSymlink(path, target) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    symlinkSync(target, temp)
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {}
    throw new Error(`cannot link ${path} -> ${target}: ${error.message}`)
  }
}

function writeFileAtomic(path, content, mode) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, content, mode === null ? {} : { mode })
    if (mode !== null) chmodSync(temp, mode)
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {}
    throw new Error(`cannot write ${path}: ${error.message}`)
  }
}

function install(dshHome) {
  const names = skillNames()
  preflightDirectory(dshHome, 'DSH home')
  preflightDirectory(join(dshHome, 'skills'), 'skills directory')
  preflightDirectory(join(dshHome, 'adapter'), 'adapter directory')
  const stable = planStableLink(dshHome)
  const skills = planSkillLinks(dshHome, names)
  const adapter = planFile(join(dshHome, 'adapter', 'dsh.md'), 'adapter')
  const agents = planFile(join(dshHome, 'AGENTS.md'), 'AGENTS.md')

  const adapterText = renderTemplate(readRequired(ADAPTER_IN, 'adapter template'), dshHome)
  const fragmentText = renderTemplate(readRequired(FRAGMENT_IN, 'agents fragment'), dshHome)
  const previousAgents = readText(agents.path, 'AGENTS.md') ?? ''
  const nextAgents = renderAgents(previousAgents, fragmentText)
  const previousAdapter = readText(adapter.path, 'adapter') ?? ''

  runPresetBuild(dshHome)

  mkdirSync(dshHome, { recursive: true })
  mkdirSync(join(dshHome, 'skills'), { recursive: true })
  mkdirSync(join(dshHome, 'adapter'), { recursive: true })
  if (stable.action !== 'none') replaceSymlink(stable.path, VENDOR)
  for (const link of skills.change) replaceSymlink(link.path, link.target)
  for (const path of skills.prune) rmSync(path, { force: true })
  if (previousAdapter !== adapterText) writeFileAtomic(adapter.target, adapterText, adapter.mode)
  if (previousAgents !== nextAgents) writeFileAtomic(agents.target, nextAgents, agents.mode)

  console.log(`linked ${names.length} skills into ${join(dshHome, 'skills')} (${skills.change.length} changed, pruned ${skills.prune.length})`)
  console.log(`adapter   ${adapter.path}`)
  console.log(`agents    ${agents.path}`)
  console.log(`preset    ${PRESET_FILE} (regenerated for ${dshHome})`)
  console.log('')
  console.log(`preset bundle: install once per profile with the DSH plugin_manager, target = ${PRESET_DIR}`)
}

try {
  install(resolveDshHome())
} catch (error) {
  console.error(`pstack install: ${error.message}`)
  process.exit(1)
}
