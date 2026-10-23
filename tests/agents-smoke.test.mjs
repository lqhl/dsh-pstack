import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFixture, fakeDsh, outputOf } from './support/fixture.mjs'

test('smoke accepts a valid custom role block with a custom budget', (t) => {
  const fixture = createFixture(t)
  const bin = fakeDsh(fixture.base)

  const installed = fixture.install()
  assert.equal(installed.status, 0, `fixture install failed: ${outputOf(installed)}`)

  const pristine = fixture.runNode('smoke.mjs', [], { path: bin })
  assert.equal(pristine.status, 0, `smoke rejected the fixture installation: ${outputOf(pristine)}`)

  const agents = fixture
    .readHome('AGENTS.md')
    .replace('# budget: custom (deepseek max, gpt medium)', '# budget: small (medium)')
    .replace('feature, refactoring: deepseek', 'feature, refactoring: inherit-parent')
    .replace('judgment and prose: gpt', 'judgment and prose: auto')
  fixture.writeHome('AGENTS.md', agents)

  const customized = fixture.runNode('smoke.mjs', [], { path: bin })
  assert.equal(
    customized.status,
    0,
    `smoke rejected a valid custom role block: ${outputOf(customized)}`,
  )
})
