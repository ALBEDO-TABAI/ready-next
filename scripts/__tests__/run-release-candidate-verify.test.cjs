'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const {
  RELEASE_CANDIDATE_COMMANDS,
  runCommandSequence,
} = require('../run-release-candidate-verify.cjs')

test('package exposes the Stage Z release-candidate gate', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['verify:release-candidate'], 'node scripts/run-release-candidate-verify.cjs')
  assert.equal(
    pkg.scripts['verify:agent-acceptance-checklist'],
    'node --import tsx --test --test-concurrency=1 src/__tests__/agent-acceptance-checklist.test.ts',
  )
})

test('release-candidate gate includes live evidence before heavy build and test work', () => {
  const labels = RELEASE_CANDIDATE_COMMANDS.map((command) => command.label)
  assert.equal(labels[0], 'verify:release-live-evidence')
  assert.equal(labels[1], 'verify:release-stage-z-readiness')
  assert(labels.includes('test'))
  assert(labels.includes('build'))
  assert(labels.includes('verify:agent-acceptance-checklist'))
  assert(labels.indexOf('verify:release-live-evidence') < labels.indexOf('test'))
  assert(labels.indexOf('verify:release-live-evidence') < labels.indexOf('build'))
  assert(labels.indexOf('verify:release-stage-z-readiness') < labels.indexOf('test'))
  assert(labels.indexOf('verify:release-stage-z-readiness') < labels.indexOf('build'))
  assert(labels.indexOf('verify:agent-acceptance-checklist') < labels.indexOf('test'))
  assert(labels.indexOf('verify:agent-acceptance-checklist') < labels.indexOf('build'))
})

test('release-candidate gate keeps the Stage Z required verification bundle', () => {
  const labels = new Set(RELEASE_CANDIDATE_COMMANDS.map((command) => command.label))
  for (const required of [
    'verify:native',
    'typecheck',
    'lint:check',
    'verify:lint-budget',
    'check-eslint-baseline',
    'verify:ipc-contract',
    'verify:meta-paths',
    'verify:stage-x-known-regressions',
    'verify:stage-y-known-regressions',
    'verify:stage-y-p0-ledger',
    'verify:stage-y-dogfood-evidence',
    'verify:agent-acceptance-checklist',
    'verify:release-live-evidence',
    'verify:release-stage-z-readiness',
    'test',
    'build',
  ]) {
    assert(labels.has(required), `missing ${required}`)
  }
})

test('release-candidate gate continues after failures so later checks still run', () => {
  const calls = []
  const exit = runCommandSequence([
    { label: 'one', cmd: 'ok', args: [] },
    { label: 'two', cmd: 'fail', args: [] },
    { label: 'three', cmd: 'skip', args: [] },
  ], (cmd, args) => {
    calls.push({ cmd, args })
    return { status: cmd === 'fail' ? 7 : 0, error: null }
  })

  assert.equal(exit, 7)
  assert.deepEqual(calls.map((call) => call.cmd), ['ok', 'fail', 'skip'])
})
