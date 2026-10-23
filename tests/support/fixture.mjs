import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

const SKIP = new Set(['.git', '.gitignore', 'LICENSE', 'Makefile', 'README.md', 'docs', 'tests', 'vendor'])

const MINIMAL_BASELINE = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a coding agent powered by the {{model}} model.
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
- id: time-context
  name: '@deepseek-ai/dsh-time-context'
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
- id: present
  name: '@deepseek-ai/dsh-present'
- id: compaction
  name: cordis:group
  group: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
- id: delegation
  name: cordis:group
  group: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        modelSelectionSettings: true
    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
`

const PRESET_ROWS = `- insert:
    - id: preset-pstack
      name: '@deepseek-ai/dsh-agent-preset'
    - id: preset-poteto-agent
      name: '@deepseek-ai/dsh-agent-preset'
    - id: preset-comment-sicko
      name: '@deepseek-ai/dsh-agent-preset'
    - id: preset-readonly-worker
      name: '@deepseek-ai/dsh-agent-preset'
`

const SMOKE_DUMP = `- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
- id: preset-pstack
  name: '@deepseek-ai/dsh-agent-preset'
- id: preset-poteto-agent
  name: '@deepseek-ai/dsh-agent-preset'
- id: preset-comment-sicko
  name: '@deepseek-ai/dsh-agent-preset'
- id: preset-readonly-worker
  name: '@deepseek-ai/dsh-agent-preset'
`

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function writeSkill(root, name, body = 'Fixture body.') {
  writeFile(
    join(root, 'vendor', 'pstack', 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: fixture skill for integration tests\n---\n\n# ${name}\n\n${body}\n`,
  )
}

function seedVendor(root) {
  writeSkill(root, 'poteto-mode', 'Read the adapter first.')
  writeSkill(root, 'setup-pstack', 'Write role lines into AGENTS.md.')
  writeSkill(root, 'demo-skill', 'A third skill keeps link counts from being hardcoded.')
  writeFile(
    join(root, 'vendor', 'pstack', 'agents', 'comment-sicko.md'),
    '---\nname: comment-sicko\n---\n\n# comment sicko\n\nFixture reviewer persona.\n',
  )
  writeFile(join(root, 'vendor', 'baseline', 'standard.plugins.yml'), MINIMAL_BASELINE)
  writeFile(join(root, 'vendor', 'upstream', 'generate-pstack-harness-trees.mjs'), 'const TERMS = [\n];\n')
}

function copyOverlay(root) {
  for (const entry of readdirSync(REPO)) {
    if (SKIP.has(entry)) continue
    cpSync(join(REPO, entry), join(root, entry), { recursive: true })
  }
  chmodSync(join(root, 'install.sh'), 0o755)
}

export function createFixture(t, options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-pstack-test-'))
  const root = join(base, 'repo')
  const home = options.home ?? join(base, options.homeName ?? 'dsh-home')
  const authorHome = join(base, 'author-home')
  mkdirSync(root, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(authorHome, { recursive: true })
  copyOverlay(root)
  seedVendor(root)
  t.after(() => rmSync(base, { recursive: true, force: true }))

  const homePath = (...parts) => join(home, ...parts)
  const repoPath = (...parts) => join(root, ...parts)

  const fixture = {
    base,
    root,
    home,
    authorHome,
    homePath,
    repoPath,
    writeHome(rel, content) {
      writeFile(homePath(rel), content)
    },
    readHome(rel) {
      return readFileSync(homePath(rel), 'utf8')
    },
    writeRepo(rel, content) {
      writeFile(repoPath(rel), content)
    },
    readRepo(rel) {
      return readFileSync(repoPath(rel), 'utf8')
    },
    addSkill(name, body) {
      writeSkill(root, name, body)
    },
    presetRows() {
      fixture.writeRepo('preset/cordis.patch.yml', PRESET_ROWS)
    },
    envFor(extra = {}) {
      const env = {
        ...process.env,
        HOME: authorHome,
        DSH_HOME: home,
        DSH_PROFILE: 'web',
      }
      if (extra.path) env.PATH = `${extra.path}:${process.env.PATH ?? ''}`
      return env
    },
    runNode(rel, args = [], extra = {}) {
      return spawnSync(process.execPath, [repoPath(rel), ...args], {
        cwd: root,
        env: fixture.envFor(extra),
        encoding: 'utf8',
        timeout: 30000,
      })
    },
    runRepoCommand(rel, args = [], extra = {}) {
      return spawnSync(repoPath(rel), args, {
        cwd: root,
        env: fixture.envFor(extra),
        encoding: 'utf8',
        timeout: 30000,
      })
    },
    install(extra = {}) {
      return fixture.runRepoCommand('install.sh', [], extra)
    },
  }
  if (existsSync(repoPath('preset'))) fixture.presetRows()
  return fixture
}

export function fakeDsh(base, dump = SMOKE_DUMP) {
  const bin = join(base, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  const dumpPath = join(bin, 'dump.yml')
  writeFileSync(dumpPath, dump)
  const script = join(bin, 'dsh')
  writeFileSync(script, `#!/bin/sh\ncat '${dumpPath}'\n`)
  chmodSync(script, 0o755)
  return bin
}

export function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

export { MINIMAL_BASELINE, PRESET_ROWS, SMOKE_DUMP }
