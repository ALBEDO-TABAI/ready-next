#!/usr/bin/env node
/**
 * Stage R W2.1 — tool-call args hash stability gate.
 *
 * Spawns the tool-call-args-hash test; the test fixtures cover the
 * hash stability invariant (same semantic args produce same hash
 * regardless of JSON key order).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = process.cwd()
const TEST_FILE = 'src/__tests__/tool-call-args-hash.test.ts'

if (!fs.existsSync(path.join(ROOT, TEST_FILE))) {
  console.error(`[check-tool-call-args-hash-stable] FAIL: missing ${TEST_FILE}`)
  process.exit(1)
}

const r = spawnSync('npx', ['tsx@^4.19.2', '--test', '--test-concurrency=1', TEST_FILE], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (r.status !== 0) {
  console.error('[check-tool-call-args-hash-stable] FAIL:')
  if (r.stdout) console.error(r.stdout)
  if (r.stderr) console.error(r.stderr)
  process.exit(1)
}
console.log('[check-tool-call-args-hash-stable] OK')
