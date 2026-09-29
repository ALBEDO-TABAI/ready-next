'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const {
  RELEASE_CANDIDATE_COMMANDS,
  runCandidateSequence,
  runCommandSequence,
} = require('../run-release-candidate-verify.cjs')

test('package exposes the Stage Z release-candidate gate', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['verify:release-candidate'], 'node scripts/run-release-candidate-verify.cjs')
  assert.equal(
    pkg.scripts['verify:release-structural'],
    'node scripts/run-release-structural-verify.cjs && node --test scripts/__tests__/write-release-receipt.test.cjs',
  )
  assert.equal(
    pkg.scripts['verify:release-structural-receipt'],
    'node scripts/verify-release-structural-package.cjs --existing',
  )
  assert.equal(pkg.scripts['verify:agent-acceptance-checklist'], undefined)
})

test('release-candidate never rebuilds and rechecks the same package identity after evidence', () => {
  const labels = RELEASE_CANDIDATE_COMMANDS.map((command) => command.label)
  assert.equal(labels.some((label) => /build|release-structural$/.test(label)), false)
  const calls = []
  let identityReads = 0
  const receipt = (sha) => ({
    ok: true,
    receipt: { receiptId: 'same', artifact: { sha256: sha }, source: { digest: 'source' } },
  })
  const exit = runCandidateSequence(
    [{ label: 'evidence', cmd: 'evidence', args: [] }],
    {
      runner: (cmd) => { calls.push(cmd); return { status: 0, error: null } },
      identity: () => receipt(identityReads++ === 0 ? 'before' : 'after'),
    },
  )
  assert.equal(exit, 1)
  assert.deepEqual(calls, ['evidence'])
})

test('release-candidate keeps structural packaging separate from current-package live acceptance', () => {
  const labels = RELEASE_CANDIDATE_COMMANDS.map((command) => command.label)
  assert.deepEqual(labels, [
    'verify:release-structural-receipt',
    'verify:release-live-evidence',
    'verify:release-stage-z-readiness',
  ])
})

test('release-candidate gate keeps the Stage Z required verification bundle', () => {
  const labels = new Set(RELEASE_CANDIDATE_COMMANDS.map((command) => command.label))
  for (const required of [
    'verify:release-structural-receipt',
    'verify:release-live-evidence',
    'verify:release-stage-z-readiness',
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
