import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFixture, outputOf } from './support/fixture.mjs'

const BEGIN = '<!-- pstack:begin -->'
const END = '<!-- pstack:end -->'

for (const homeName of ['home with spaces & pipes | markers', "home-$&-$$-$`-$'"]) {
test(`install renders all destination paths literally for ${homeName}`, (t) => {
  const fixture = createFixture(t, { homeName })
  fixture.writeHome('AGENTS.md', '# AGENTS.md\n\nPreamble stays.\n')

  const result = fixture.install()
  assert.equal(result.status, 0, `install failed for a special-character DSH_HOME: ${outputOf(result)}`)

  const adapterTemplate = readFileSync(join(fixture.root, 'adapter', 'dsh.md.in'), 'utf8')
  const expectedAdapter = adapterTemplate.split('{{DSH_HOME}}').join(fixture.home)
  const adapter = fixture.readHome('adapter/dsh.md')
  assert.equal(adapter, expectedAdapter, 'installed adapter is not the template rendered with DSH_HOME')
  assert.ok(adapter.includes(`${fixture.home}/pstack`), 'adapter does not reference the destination pstack path')
  assert.ok(!adapter.includes('{{DSH_HOME}}'), 'adapter still has an unresolved placeholder')

  const fragmentTemplate = readFileSync(join(fixture.root, 'agents-fragment.md.in'), 'utf8')
  const expectedFragment = fragmentTemplate.split('{{DSH_HOME}}').join(fixture.home).trimEnd()
  const agents = fixture.readHome('AGENTS.md')
  const start = agents.indexOf(BEGIN)
  const end = agents.indexOf(END)
  assert.ok(start >= 0 && end > start, 'AGENTS.md does not contain one ordered pstack block')
  assert.equal(agents.slice(start, end + END.length).trimEnd(), expectedFragment, 'AGENTS.md block is not the rendered fragment')
  assert.ok(agents.includes(`${fixture.home}/adapter/dsh.md`), 'AGENTS.md does not reference the destination adapter')
  assert.ok(agents.includes(`${fixture.home}/skills/poteto-mode/SKILL.md`), 'AGENTS.md does not reference the destination skill')
  assert.ok(!agents.includes('{{DSH_HOME}}'), 'AGENTS.md still has an unresolved placeholder')
  assert.ok(agents.includes('Preamble stays.'), 'text outside the block was lost')

  const preset = fixture.readRepo('preset/cordis.patch.yml')
  assert.ok(preset.includes(`${fixture.home}/skills/poteto-mode/SKILL.md`), 'install did not regenerate preset skill paths')
  assert.ok(preset.includes(`${fixture.home}/adapter/dsh.md`), 'install did not regenerate preset adapter paths')
})
}

test('install regenerates the preset when moving to a second home', (t) => {
  const fixture = createFixture(t)
  const installed = fixture.install()
  assert.equal(installed.status, 0, outputOf(installed))
  const secondHome = `${fixture.home}-second`
  const result = spawnSync(fixture.repoPath('install.sh'), [], {
    cwd: fixture.root,
    env: { ...fixture.envFor(), DSH_HOME: secondHome },
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(result.status, 0, outputOf(result))
  const preset = fixture.readRepo('preset/cordis.patch.yml')
  assert.ok(preset.includes(`${secondHome}/adapter/dsh.md`), 'second home did not replace generated paths')
  assert.ok(!preset.includes(`${fixture.home}/adapter/dsh.md`), 'preset still points at the first home')
})
