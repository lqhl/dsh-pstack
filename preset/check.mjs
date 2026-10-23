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
import { extractStandardPlugins } from '../lib/standard-preset.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASELINE = join(ROOT, 'vendor', 'baseline', 'standard.plugins.yml')
const PROFILE = process.env.DSH_PROFILE || 'web'
const DUMP_ARGS = ['--profile', PROFILE, '--dump-config']

function failureDetail(error) {
  const stderr = error?.stderr?.toString().trim().split('\n')[0]
  return stderr || error?.message || String(error)
}

function liveStandard() {
  let dump
  try {
    dump = execFileSync('dsh', DUMP_ARGS, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(`cannot run \`dsh ${DUMP_ARGS.join(' ')}\`: ${failureDetail(error)}`)
  }
  return extractStandardPlugins(dump).text
}

let baseline
let live
try {
  if (!existsSync(BASELINE)) throw new Error(`missing ${BASELINE}; run make baseline`)
  baseline = readFileSync(BASELINE, 'utf8').replace(/\n+$/, '')
  live = liveStandard()
} catch (error) {
  console.log(`FAIL ${error.message}`)
  process.exit(1)
}

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
