/**
 * Stage T (Stage 14) — gate behavior test for check-verify-t-defined.cjs.
 *
 * PR-T1 scope: skeleton only. Pin that the gate (a) is requireable
 * without throwing, (b) passes on the real repo (verify:t script
 * defined, embeds verify:s; test:t:gates and test:t:focus scripts
 * exist as standalone definitions). Note: per plan v18 §2 round 3+5,
 * verify:t at PR-T1 deliberately does NOT include test:t:gates /
 * test:t:focus to avoid red while the 8 referenced tsx files are
 * created in T2-T5.
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-verify-t-defined.cjs')

test('gate module loads without throwing', () => {
  assert.doesNotThrow(() => {
    require.resolve(SCRIPT)
  })
})

test('positive: real repo passes — verify:t embeds verify:s and test:t:gates / test:t:focus are defined', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
  assert.match(r.stdout, /\[check-verify-t-defined\] OK/)
})
