/**
 * Stage R PR-R8 — meta-test for check-run-span-metadata-keys-frozen.cjs.
 * Smoke: real repo passes with the 6 frozen keys.
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-run-span-metadata-keys-frozen.cjs')

test('positive: real repo passes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
})
