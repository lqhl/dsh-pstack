import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFixture, outputOf } from './support/fixture.mjs'

function buildPackage(t) {
  const fixture = createFixture(t)
  fixture.writeRepo('LICENSE', 'MIT License\n\nCopyright (c) 2026 Qin Liu\n')
  fixture.writeRepo('vendor/pstack/LICENSE', 'MIT License\n\nCopyright (c) Lauren Tan\n')
  const result = fixture.runNode('preset/package.mjs', ['--out', 'dist'])
  assert.equal(result.status, 0, `package build failed: ${outputOf(result)}`)
  return fixture
}

test('the package manifest is publishable', (t) => {
  const fixture = buildPackage(t)
  const manifest = JSON.parse(fixture.readRepo('dist/package.json'))

  assert.equal(manifest.name, '@lqhl/dsh-pstack')
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.private, undefined, 'dist manifest still carries private')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.engines.dsh, '^0.2.1-rc.5')
  assert.equal(manifest.publishConfig.access, 'public')
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org')
  assert.equal(manifest.exports['./package.json'], './package.json', 'package.json must stay exported')

  for (const entry of [
    'cordis.patch.yml',
    'skills',
    'personas',
    'locale/*.json',
    'icon.svg',
    'licenses',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'README.md',
  ]) {
    assert.ok(manifest.files.includes(entry), `package files is missing ${entry}`)
  }
})

test('the package patch mounts package-local skills without an absolute home path', (t) => {
  const fixture = buildPackage(t)
  const patch = fixture.readRepo('dist/cordis.patch.yml')

  assert.ok(!patch.includes('/home/'), 'package patch still has an absolute home path')
  assert.ok(!patch.includes('{{DSH_HOME}}'), 'package patch still has a DSH_HOME placeholder')
  assert.ok(!patch.includes('{{PSTACK_ROOT}}'), 'package patch still has a PSTACK_ROOT placeholder')

  for (const preset of ['preset-pstack', 'preset-poteto-agent', 'preset-comment-sicko', 'preset-readonly-worker']) {
    assert.ok(patch.includes(`- id: ${preset}`), `package patch has no ${preset} row`)
  }
  assert.equal(patch.match(/customSkillDirs:/g)?.length, 2, 'only the two skill-enabled presets should carry customSkillDirs')
  assert.equal(patch.match(/personas\/pstack\.md/g)?.length, 1)
  assert.equal(patch.match(/personas\/poteto-agent\.md/g)?.length, 1)
  assert.equal(patch.match(/personas\/readonly-worker\.md/g)?.length, 1)
  assert.ok(patch.includes("resolve('@lqhl/dsh-pstack/package.json')"))
})

test('the package ships its skills, helper skills, personas, and display assets', (t) => {
  const fixture = buildPackage(t)
  const dist = (rel) => fixture.repoPath('dist', rel)
  const skills = readdirSync(dist('skills'))
    .filter((name) => existsSync(join(dist('skills'), name, 'SKILL.md')))
    .sort()

  assert.deepEqual(skills, ['demo-skill', 'poteto-mode', 'pstack-dsh-adapter', 'pstack-models', 'setup-pstack'])

  for (const helper of ['pstack-dsh-adapter', 'pstack-models']) {
    const text = readFileSync(dist(`skills/${helper}/SKILL.md`), 'utf8')
    assert.match(text, /^---\n/)
    assert.match(text, new RegExp(`name: ${helper}`))
    assert.match(text, /disable-model-invocation: true/)
    assert.match(text, /user-invocable: false/)
    assert.ok(!text.includes('{{'), `${helper} still has an unresolved placeholder`)
  }

  for (const persona of ['pstack', 'poteto-agent', 'readonly-worker']) {
    const text = readFileSync(dist(`personas/${persona}.md`), 'utf8')
    assert.ok(text.includes('{{PSTACK_SKILLS}}'), `${persona} persona lost its skills placeholder`)
  }

  const en = JSON.parse(readFileSync(dist('locale/en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(dist('locale/zh.json'), 'utf8'))
  assert.equal(en.meta.title, 'dsh-pstack')
  assert.ok(zh.meta.description.length > 0)
  assert.match(readFileSync(dist('icon.svg'), 'utf8'), /^<svg /)
  assert.ok(readFileSync(dist('THIRD_PARTY_NOTICES.md'), 'utf8').includes('Lauren Tan'))
  assert.ok(readFileSync(dist('licenses/pstack-LICENSE'), 'utf8').includes('MIT'))
})

test('npm pack includes the bundle files', (t) => {
  const fixture = buildPackage(t)
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: fixture.repoPath('dist'),
    env: { ...process.env, npm_config_cache: fixture.repoPath('.cache/npm') },
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.equal(result.status, 0, `npm pack failed: ${outputOf(result)}`)

  const stdout = result.stdout
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  assert.ok(start >= 0 && end > start, `npm pack printed no JSON: ${stdout}`)
  const parsed = JSON.parse(stdout.slice(start, end + 1))
  const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  const files = packed.files.map((entry) => entry.path)

  for (const required of [
    'package.json',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'icon.svg',
    'locale/en.json',
    'personas/pstack.md',
    'skills/poteto-mode/SKILL.md',
    'skills/pstack-dsh-adapter/SKILL.md',
    'licenses/pstack-LICENSE',
  ]) {
    assert.ok(files.includes(required), `packed tarball is missing ${required}`)
  }
})
