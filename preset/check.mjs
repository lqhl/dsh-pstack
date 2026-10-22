#!/usr/bin/env node
/**
 * Check C: the shipped `standard` preset is the base our `pstack` preset copies.
 * A DSH upgrade that adds, removes, or renames rows there silently diverges from
 * our copy, so compare the live composition with the recorded baseline.
 *
 * Run after a DSH upgrade: `make baseline && make preset` to adopt the change.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASELINE = join(ROOT, 'vendor', 'baseline', 'standard.plugins.yml')
const PROFILE = process.env.DSH_PROFILE || 'web'

function liveStandard() {
  const dump = execFileSync('dsh', ['--profile', PROFILE, '--dump-config'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const lines = dump.split('\n')
  const start = lines.findIndex((line) => line.startsWith('- id: preset-standard'))
  if (start < 0) throw new Error(`profile ${PROFILE} has no preset-standard row`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('- id: preset-'))
  const block = lines.slice(start, end < 0 ? undefined : end)
  const plugins = block.findIndex((line) => line.trim() === 'plugins:')
  if (plugins < 0) throw new Error('preset-standard has no plugins list')
  return block
    .slice(plugins + 1)
    .filter((line) => line.trim() !== '')
    .map((line) => (line.startsWith('      ') ? line.slice(6) : line))
    .join('\n')
}

if (!existsSync(BASELINE)) {
  console.log(`FAIL missing ${BASELINE}; run make baseline`)
  process.exit(1)
}

const baseline = readFileSync(BASELINE, 'utf8').replace(/\n+$/, '')
const live = liveStandard()
if (baseline === live) {
  console.log(`preset base matches the live standard preset (profile ${PROFILE})`)
  process.exit(0)
}

const before = baseline.split('\n')
const after = live.split('\n')
const index = before.findIndex((line, position) => line !== after[position])
console.log(`FAIL the standard preset changed under us; first difference at line ${index + 1}`)
console.log(`  baseline: ${before[index] ?? '(end)'}`)
console.log(`  live:     ${after[index] ?? '(end)'}`)
console.log(`  baseline ${before.length} lines, live ${after.length} lines`)
console.log('Run `make baseline && make preset`, review the diff in preset/cordis.patch.yml, then `make check`.')
process.exit(1)
