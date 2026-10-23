import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFixture, fakeDsh, outputOf } from './support/fixture.mjs'

function topLevelIds(baseline) {
  return baseline
    .split('\n')
    .filter((line) => line.startsWith('- id: '))
    .map((line) => line.slice('- id: '.length).trim())
}

function rowBlock(text, id) {
  const lines = text.split('\n')
  const header = new RegExp(`^( *)- id: ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  const start = lines.findIndex((line) => header.test(line))
  assert.notEqual(start, -1, `generated preset has no ${id} row`)
  const indent = lines[start].match(/^ */)[0].length
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = lines[index].match(/^( *)- id: /)
    if (next && next[1].length <= indent) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const TOP_LEVEL_DUMP = `- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
- id: extension-row
  name: '@deepseek-ai/dsh-extension'
  config:
    plugins:
      - id: leaked-plugin
        name: '@deepseek-ai/dsh-leaked'
`

const SIBLING_DUMP = `- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
    description: sibling field after plugins
`

function refreshBaseline(t, dump) {
  const fixture = createFixture(t)
  const bin = fakeDsh(fixture.base, dump)
  const result = fixture.runNode('preset/build.mjs', ['--refresh'], { path: bin })
  assert.equal(result.status, 0, `baseline refresh failed: ${outputOf(result)}`)
  return fixture.readRepo('vendor/baseline/standard.plugins.yml')
}

test('baseline refresh stops at the next top-level entry', (t) => {
  const baseline = refreshBaseline(t, TOP_LEVEL_DUMP)
  assert.deepEqual(topLevelIds(baseline), ['persona', 'tool-bash'], `baseline leaked rows:\n${baseline}`)
  assert.ok(!baseline.includes('extension-row'), `baseline includes the next top-level entry:\n${baseline}`)
  assert.ok(!baseline.includes('leaked-plugin'), `baseline includes a nested row from the next entry:\n${baseline}`)
})

test('baseline refresh stops at a sibling config field after the plugins list', (t) => {
  const baseline = refreshBaseline(t, SIBLING_DUMP)
  assert.deepEqual(topLevelIds(baseline), ['persona', 'tool-bash'], `baseline leaked rows:\n${baseline}`)
  assert.ok(!baseline.includes('description: sibling field after plugins'), `baseline includes a sibling config field:\n${baseline}`)
})

function generatedPatch(t) {
  const fixture = createFixture(t)
  const result = fixture.runNode('preset/build.mjs')
  assert.equal(result.status, 0, `preset build failed: ${outputOf(result)}`)
  return fixture.readRepo('preset/cordis.patch.yml')
}

test('the generated pstack preset retains its general delegation depth limit', (t) => {
  const patch = generatedPatch(t)
  const block = rowBlock(patch, 'tool-subagent')
  assert.match(block, /maxDepth:\s*2\b/, `tool-subagent should retain its depth limit of 2:\n${block}`)
})

test('the generated readonly delegation tool allows its first child', (t) => {
  const patch = generatedPatch(t)
  const block = rowBlock(patch, 'subagent-readonly')
  assert.match(block, /maxDepth:\s*1\b/, `subagent-readonly should cap depth at 1, not block its first child:\n${block}`)
})

test('the generated preset references the destination home, not HOME', (t) => {
  const fixture = createFixture(t, { homeName: 'destination & home | path' })
  const result = fixture.runNode('preset/build.mjs')
  assert.equal(result.status, 0, `preset build failed: ${outputOf(result)}`)

  const patch = fixture.readRepo('preset/cordis.patch.yml')
  assert.ok(patch.includes(`${fixture.home}/skills/poteto-mode/SKILL.md`), 'preset does not point at the destination skill path')
  assert.ok(patch.includes(`${fixture.home}/adapter/dsh.md`), 'preset does not point at the destination adapter path')
  assert.ok(!patch.includes(fixture.authorHome), `preset points at HOME instead of DSH_HOME:\n${patch}`)
})
