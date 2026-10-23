import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFixture, outputOf } from './support/fixture.mjs'

const BEGIN = '<!-- pstack:begin -->'
const END = '<!-- pstack:end -->'

const markerCases = [
  ['begin marker without end marker', `# AGENTS.md\n\n${BEGIN}\nstale pstack block\n`],
  ['end marker without begin marker', `# AGENTS.md\n\nstale pstack block\n${END}\n`],
  ['reversed markers', `# AGENTS.md\n\n${END}\nstale pstack block\n${BEGIN}\n`],
  ['duplicate begin markers', `# AGENTS.md\n\n${BEGIN}\nfirst\n${BEGIN}\nsecond\n${END}\n`],
  ['duplicate end markers', `# AGENTS.md\n\n${BEGIN}\nstale pstack block\n${END}\nsecond end\n${END}\n`],
]

for (const [name, content] of markerCases) {
  test(`install refuses an AGENTS.md with ${name} and leaves it unchanged`, (t) => {
    const fixture = createFixture(t)
    fixture.writeHome('AGENTS.md', content)
    const result = fixture.install()
    assert.notEqual(
      result.status,
      0,
      `install exited 0 for ${name}; output: ${outputOf(result)}`,
    )
    assert.equal(fixture.readHome('AGENTS.md'), content, 'AGENTS.md was modified despite invalid markers')
  })
}

test('install preserves custom role values and the budget line inside the pstack block', (t) => {
  const fixture = createFixture(t)
  const fragment = readFileSync(join(fixture.root, 'agents-fragment.md.in'), 'utf8')
    .split('{{DSH_HOME}}')
    .join(fixture.home)
  const customized = fragment
    .replace('# budget: custom (deepseek max, gpt medium)', '# budget: small (medium)')
    .replace('feature, refactoring: deepseek', 'feature, refactoring: inherit-parent')
    .replace('judgment and prose: gpt', 'judgment and prose: auto')
    .replace('arena runners: deepseek, gpt', 'arena runners: inherit-parent, auto')
  fixture.writeHome(
    'AGENTS.md',
    `# AGENTS.md\n\nKeep this preamble.\n\n${customized}\n\nKeep this trailing note.\n`,
  )

  const result = fixture.install()
  assert.equal(result.status, 0, `install failed: ${outputOf(result)}`)

  const agents = fixture.readHome('AGENTS.md')
  assert.match(agents, /^# budget: small \(medium\)$/m, 'custom budget line was overwritten')
  assert.match(agents, /^feature, refactoring: inherit-parent$/m, 'custom role value was overwritten')
  assert.match(agents, /^judgment and prose: auto$/m, 'custom role value was overwritten')
  assert.match(agents, /^arena runners: inherit-parent, auto$/m, 'custom panel values were overwritten')
  assert.equal(agents.split(BEGIN).length - 1, 1, 'expected exactly one begin marker')
  assert.equal(agents.split(END).length - 1, 1, 'expected exactly one end marker')
  assert.ok(agents.includes('Keep this preamble.'), 'text before the block was lost')
  assert.ok(agents.includes('Keep this trailing note.'), 'text after the block was lost')
})

test('install refuses a customized role before the budget without changing files', (t) => {
  const fixture = createFixture(t)
  const fragment = fixture.readRepo('agents-fragment.md.in').split('{{DSH_HOME}}').join(fixture.home)
  const agents = fragment
    .replace('feature, refactoring: deepseek\n', '')
    .replace('# budget:', 'feature, refactoring: gpt\n# budget:')
  fixture.writeHome('AGENTS.md', agents)
  const presetBefore = fixture.readRepo('preset/cordis.patch.yml')
  const result = fixture.install()
  assert.notEqual(result.status, 0, `install accepted a misplaced custom role: ${outputOf(result)}`)
  assert.equal(fixture.readHome('AGENTS.md'), agents, 'customized role was discarded')
  assert.equal(fixture.readRepo('preset/cordis.patch.yml'), presetBefore, 'preset changed despite invalid input')
})

function describe(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return { type: 'symlink', target: readlinkSync(path) }
  if (stat.isDirectory()) {
    return {
      type: 'directory',
      entries: readdirSync(path).sort(),
      keep: readFileSync(join(path, 'keep.txt'), 'utf8'),
    }
  }
  return { type: 'file', content: readFileSync(path, 'utf8') }
}

const stableConflictCases = [
  [
    'a real directory',
    (fixture) => {
      mkdirSync(join(fixture.home, 'pstack'), { recursive: true })
      writeFileSync(join(fixture.home, 'pstack', 'keep.txt'), 'stable directory content\n')
    },
    (fixture) => join(fixture.home, 'pstack'),
  ],
  [
    'a regular file',
    (fixture) => {
      writeFileSync(join(fixture.home, 'pstack'), 'stable file content\n')
    },
    (fixture) => join(fixture.home, 'pstack'),
  ],
  [
    'an unrelated symlink',
    (fixture) => {
      mkdirSync(join(fixture.base, 'other-target'), { recursive: true })
      symlinkSync(join(fixture.base, 'other-target'), join(fixture.home, 'pstack'))
    },
    (fixture) => join(fixture.home, 'pstack'),
  ],
]

for (const [name, seed, conflictPath] of stableConflictCases) {
  test(`install refuses ${name} at the stable pstack path without touching it or AGENTS.md`, (t) => {
    const fixture = createFixture(t)
    const agents = '# AGENTS.md\n\nExisting notes.\n'
    fixture.writeHome('AGENTS.md', agents)
    seed(fixture)
    const path = conflictPath(fixture)
    const before = describe(path)

    const result = fixture.install()
    assert.notEqual(result.status, 0, `install exited 0 with ${name} at ${path}; output: ${outputOf(result)}`)
    assert.deepEqual(describe(path), before, 'the conflicting stable-path artifact was modified')
    assert.equal(fixture.readHome('AGENTS.md'), agents, 'AGENTS.md was modified despite the conflict')
  })
}

const skillConflictCases = [
  [
    'a real directory',
    (fixture, path) => {
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'keep.txt'), 'skill directory content\n')
    },
  ],
  [
    'a regular file',
    (fixture, path) => {
      writeFileSync(path, 'skill file content\n')
    },
  ],
  [
    'an unrelated symlink',
    (fixture, path) => {
      mkdirSync(join(fixture.base, 'other-skill-target'), { recursive: true })
      symlinkSync(join(fixture.base, 'other-skill-target'), path)
    },
  ],
]

for (const [name, seed] of skillConflictCases) {
  test(`install refuses ${name} at a stable skill link without touching it or AGENTS.md`, (t) => {
    const fixture = createFixture(t)
    const agents = '# AGENTS.md\n\nExisting notes.\n'
    fixture.writeHome('AGENTS.md', agents)
    const path = join(fixture.home, 'skills', 'poteto-mode')
    mkdirSync(join(fixture.home, 'skills'), { recursive: true })
    seed(fixture, path)
    const before = describe(path)

    const result = fixture.install()
    assert.notEqual(result.status, 0, `install exited 0 with ${name} at ${path}; output: ${outputOf(result)}`)
    assert.deepEqual(describe(path), before, 'the conflicting skill-link artifact was modified')
    assert.equal(fixture.readHome('AGENTS.md'), agents, 'AGENTS.md was modified despite the conflict')
  })
}
