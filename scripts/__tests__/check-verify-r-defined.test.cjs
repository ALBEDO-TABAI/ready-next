/**
 * Stage R (Stage 12) — gate behavior test for check-verify-r-defined.cjs.
 *
 * PR-R2 scope: skeleton only. Pin that the gate (a) is requireable
 * without throwing, (b) passes on the real repo (verify:r script
 * defined, embeds verify:q, includes test:r:gates and test:r:focus).
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-verify-r-defined.cjs')

test('gate module loads without throwing', () => {
  assert.doesNotThrow(() => {
    require.resolve(SCRIPT)
  })
})

test('positive: real repo passes — verify:r is defined and embeds verify:q + test:r:gates + test:r:focus', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
  assert.match(r.stdout, /\[check-verify-r-defined\] OK/)
})
