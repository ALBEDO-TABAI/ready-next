#!/usr/bin/env node
/**
 * Stage R W5.4 — auto-title fallback gate.
 *
 * Spawns the auto-title-middleware test which covers fallback behavior
 * when the LLM call fails (auto-title generation must NOT block the turn;
 * fallback to a local string is required).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = process.cwd()
const TEST_FILE = 'src/__tests__/auto-title-middleware.test.ts'

if (!fs.existsSync(path.join(ROOT, TEST_FILE))) {
  console.error(`[check-auto-title-fallback] FAIL: missing ${TEST_FILE}`)
  process.exit(1)
}

const r = spawnSync('npx', ['tsx@^4.19.2', '--test', '--test-concurrency=1', TEST_FILE], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (r.status !== 0) {
  console.error('[check-auto-title-fallback] FAIL:')
  if (r.stdout) console.error(r.stdout)
  if (r.stderr) console.error(r.stderr)
  process.exit(1)
}
console.log('[check-auto-title-fallback] OK')
