/**
 * Stage S (Stage 13) — gate behavior test for check-verify-s-defined.cjs.
 *
 * PR-S1 scope: skeleton only. Pin that the gate (a) is requireable
 * without throwing, (b) passes on the real repo (verify:s script
 * defined, embeds verify:r + verify:native, includes test:s:gates and
 * test:s:focus).
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-verify-s-defined.cjs')

test('gate module loads without throwing', () => {
  assert.doesNotThrow(() => {
    require.resolve(SCRIPT)
  })
})

test('positive: real repo passes — verify:s is defined and embeds verify:r + verify:native + test:s:gates + test:s:focus', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
  assert.match(r.stdout, /\[check-verify-s-defined\] OK/)
})
