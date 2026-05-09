/**
 * Stage R PR-R8 — meta-test for check-stage-r-verify-switch.cjs.
 * Smoke: real repo passes (the cutover edits are already applied).
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-stage-r-verify-switch.cjs')

test('positive: real repo passes after Stage R cutover', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
})
