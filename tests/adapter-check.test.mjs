import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFixture, outputOf } from './support/fixture.mjs'

const COMPLETE_ADAPTER = `# pstack in DSH

## Models

| alias | provider | model | reasoning_effort |
| --- | --- | --- | --- |
| \`deepseek\` (code) | \`magpie\` | \`deepseek/deepseek-flash\` | \`max\` |
| \`gpt\` (judgment) | \`magpie-responses\` | \`codex/gpt-6.1-sol\` | \`medium\` |

| pstack slug | alias |
| --- | --- |
| \`claude-*\` | \`gpt\` |
| \`gpt-*\` | \`gpt\` |
| \`grok-*\`, \`composer-*\`, \`cursor-grok-*\` | \`deepseek\` |
| \`deepseek-*\` | \`deepseek\` |
`

function adapterFixture(t, { adapter, body }) {
  const fixture = createFixture(t)
  fixture.writeRepo('adapter/dsh.md.in', adapter)
  fixture.addSkill('model-probe', body)
  return fixture
}

test('family check rejects a missing gpt mapping row even when a gpt model id remains', (t) => {
  const adapter = COMPLETE_ADAPTER.replace('| `gpt-*` | `gpt` |\n', '')
  assert.ok(!adapter.includes('`gpt-*`'), 'fixture adapter still has the gpt mapping row')
  assert.ok(adapter.includes('gpt-6.1-sol'), 'fixture adapter should keep a gpt model id elsewhere')

  const fixture = adapterFixture(t, { adapter, body: 'Use `gpt-6.1-sol` for judgment.' })
  const result = fixture.runNode('adapter/check.mjs')
  const output = outputOf(result)
  assert.notEqual(result.status, 0, `check accepted a missing gpt mapping row: ${output}`)
  assert.match(output, /gpt/i, `check failed without naming the gpt family: ${output}`)
})

test('family check accepts wildcard composer and cursor-grok mapping rows', (t) => {
  const fixture = adapterFixture(t, {
    adapter: COMPLETE_ADAPTER,
    body: 'Use `composer-2`, `cursor-grok-4.5`, or `grok-4.7` for code.',
  })
  const result = fixture.runNode('adapter/check.mjs')
  assert.equal(result.status, 0, `check rejected wildcard family rows: ${outputOf(result)}`)
})

test('family check rejects an unknown concrete model family', (t) => {
  const fixture = adapterFixture(t, {
    adapter: COMPLETE_ADAPTER,
    body: 'Use `mistral-large-3` for long context. Delegate to `poteto-agent`, `readonly-worker`, or `comment-sicko`. Prose words: follow-up, set-up, read-only.',
  })
  const result = fixture.runNode('adapter/check.mjs')
  const output = outputOf(result)
  assert.notEqual(result.status, 0, `check accepted an unmapped mistral family: ${output}`)
  assert.match(output, /mistral/i, `check failed without naming the unknown family: ${output}`)
  for (const name of ['poteto-agent', 'readonly-worker', 'comment-sicko']) {
    assert.ok(!output.includes(name), `check flagged the ordinary name ${name}: ${output}`)
  }
})

for (const family of ['composer', 'cursor-grok']) {
  test(`family check rejects a missing ${family} mapping used only as a wildcard`, (t) => {
    const adapter = COMPLETE_ADAPTER.replace(`, \`${family}-*\``, '')
    const fixture = adapterFixture(t, { adapter, body: `The runner family is \`${family}-*\`.` })
    const result = fixture.runNode('adapter/check.mjs')
    assert.notEqual(result.status, 0, `check accepted a missing wildcard mapping: ${outputOf(result)}`)
    assert.ok(outputOf(result).includes(family), outputOf(result))
  })
}

test('family check rejects an unknown wildcard model family', (t) => {
  const fixture = adapterFixture(t, { adapter: COMPLETE_ADAPTER, body: 'Use the `mistral-*` model family.' })
  const result = fixture.runNode('adapter/check.mjs')
  assert.notEqual(result.status, 0, `check accepted an unknown wildcard family: ${outputOf(result)}`)
  assert.match(outputOf(result), /mistral/i)
})

test('family check accepts a newly mapped family with a named variant', (t) => {
  const adapter = `${COMPLETE_ADAPTER}| \`mistral-*\` | \`gpt\` |\n`
  const fixture = adapterFixture(t, { adapter, body: 'Use `mistral-large-3.1` for judgment.' })
  const result = fixture.runNode('adapter/check.mjs')
  assert.equal(result.status, 0, `check rejected a mapped new family: ${outputOf(result)}`)
})

test('family check rejects an unknown dotted-version model family', (t) => {
  const fixture = adapterFixture(t, { adapter: COMPLETE_ADAPTER, body: 'Use `qwen-3.1` for code.' })
  const result = fixture.runNode('adapter/check.mjs')
  assert.notEqual(result.status, 0, `check accepted an unknown dotted-version family: ${outputOf(result)}`)
  assert.match(outputOf(result), /qwen/i)
})

test('family check ignores agent names and ordinary hyphenated prose', (t) => {
  const fixture = adapterFixture(t, {
    adapter: COMPLETE_ADAPTER,
    body: 'Delegate to `poteto-agent`, `readonly-worker`, or `comment-sicko`. Prose words: follow-up, set-up, read-only.',
  })
  const result = fixture.runNode('adapter/check.mjs')
  assert.equal(result.status, 0, `check flagged non-model names: ${outputOf(result)}`)
})
