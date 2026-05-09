#!/usr/bin/env node
/**
 * Stage R W10.4 — correction-detector fixtures gate.
 *
 * Spawns the correction-detector test which covers the fixture matrix
 * (positive corrections, negative non-corrections, language variants).
 *
 * Stage R only ships the helper; turn-engine wiring is deferred to
 * Stage S/T per §11 implementation plan.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = process.cwd()
const TEST_FILE = 'src/__tests__/correction-detector.test.ts'

if (!fs.existsSync(path.join(ROOT, TEST_FILE))) {
  console.error(`[check-correction-detector-fixtures] FAIL: missing ${TEST_FILE}`)
  process.exit(1)
}

const r = spawnSync('npx', ['tsx@^4.19.2', '--test', '--test-concurrency=1', TEST_FILE], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (r.status !== 0) {
  console.error('[check-correction-detector-fixtures] FAIL:')
  if (r.stdout) console.error(r.stdout)
  if (r.stderr) console.error(r.stderr)
  process.exit(1)
}
console.log('[check-correction-detector-fixtures] OK')
