/**
 * Stage R PR-R8 — meta-test for check-present-file-only-outputs-dir.cjs.
 * Smoke: real repo passes (path-sandbox helper used, no naive startsWith).
 */
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const test = require('node:test')

const SCRIPT = resolve(__dirname, '../check-present-file-only-outputs-dir.cjs')

test('positive: real repo passes', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`)
})
