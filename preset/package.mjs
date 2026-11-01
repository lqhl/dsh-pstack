#!/usr/bin/env node
/**
 * Stage the publishable DSH bundle in dist/.
 *
 *   node preset/package.mjs                 # write dist/
 *   node preset/package.mjs --out <dir>     # write another directory
 *
 * The package is a configuration-only bundle. It ships the vendored skills,
 * the package-mode preset patch, its personas, and the display assets. No
 * lifecycle script writes to $DSH_HOME.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPatch } from './build.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const VENDOR = join(ROOT, 'vendor', 'pstack')
const OUT = join(ROOT, 'dist')
const MANIFEST = join(HERE, 'package.json')

function outputDir(argv) {
  const index = argv.indexOf('--out')
  if (index < 0) return OUT
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error('--out needs a directory')
  return resolve(value)
}

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n`
}

function writeAdapterSkill(out) {
  const source = readFileSync(join(ROOT, 'adapter', 'dsh.md.in'), 'utf8')
  const body = source
    .replace(/`<pstack>` is `\{\{PSTACK_ROOT\}\}`\./, "`<pstack>` is the parent directory of this skill's directory.")
    .replaceAll('{{DSH_HOME}}', '~/.dsh')
  if (body.includes('{{')) throw new Error('adapter skill still has an unresolved placeholder')
  const target = join(out, 'skills', 'pstack-dsh-adapter')
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, 'SKILL.md'),
    `${frontmatter('pstack-dsh-adapter', "Translate pstack's Cursor vocabulary into DSH tools and subagent fields.")}${body.trimEnd()}\n`,
  )
}

function writeModelsSkill(out) {
  const fragment = readFileSync(join(ROOT, 'agents-fragment.md.in'), 'utf8')
  const start = fragment.indexOf('Subagent model aliases')
  const end = fragment.indexOf('<!-- pstack:end -->')
  if (start < 0 || end < start) throw new Error('agents-fragment.md.in has no role table to copy')
  const table = fragment.slice(start, end).trimEnd()
  if (table.includes('{{')) throw new Error('models skill still has an unresolved placeholder')
  const target = join(out, 'skills', 'pstack-models')
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, 'SKILL.md'),
    `${frontmatter('pstack-models', 'Default model routing for pstack roles on DeepSeek Harness.')}Default model routing for pstack roles. Lines in ~/.dsh/AGENTS.md override these defaults.\n\n${table}\n`,
  )
}

function stage(out) {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  writeFileSync(join(out, 'cordis.patch.yml'), buildPatch('package'))
  cpSync(join(VENDOR, 'skills'), join(out, 'skills'), { recursive: true })
  mkdirSync(join(out, 'licenses'), { recursive: true })
  cpSync(join(VENDOR, 'LICENSE'), join(out, 'licenses', 'pstack-LICENSE'))
  cpSync(join(HERE, 'personas'), join(out, 'personas'), { recursive: true })
  cpSync(join(HERE, 'locale'), join(out, 'locale'), { recursive: true })
  cpSync(join(HERE, 'icon.svg'), join(out, 'icon.svg'))
  cpSync(join(HERE, 'THIRD_PARTY_NOTICES.md'), join(out, 'THIRD_PARTY_NOTICES.md'))
  cpSync(join(HERE, 'README.md'), join(out, 'README.md'))
  cpSync(join(ROOT, 'LICENSE'), join(out, 'LICENSE'))

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  delete manifest.private
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  writeAdapterSkill(out)
  writeModelsSkill(out)

  const skills = readdirSync(join(out, 'skills')).filter((name) => existsSync(join(out, 'skills', name, 'SKILL.md')))
  console.log(`wrote ${out} (${skills.length} skills, ${manifest.name}@${manifest.version})`)
}

try {
  stage(outputDir(process.argv.slice(2)))
} catch (error) {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
}
