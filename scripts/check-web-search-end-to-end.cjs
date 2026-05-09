#!/usr/bin/env node
/**
 * Stage R W1.1 — web_search tool end-to-end gate.
 *
 * Spawns `npx tsx@^4.19.2 --test src/__tests__/web-search-tool.test.ts`
 * and confirms the test file passes. The test file is required to exist;
 * a missing file fails this gate (don't silently skip).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = process.cwd()
const TEST_FILE = 'src/__tests__/web-search-tool.test.ts'

if (!fs.existsSync(path.join(ROOT, TEST_FILE))) {
  console.error(`[check-web-search-end-to-end] FAIL: missing ${TEST_FILE}`)
  process.exit(1)
}

const r = spawnSync('npx', ['tsx@^4.19.2', '--test', '--test-concurrency=1', TEST_FILE], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (r.status !== 0) {
  console.error('[check-web-search-end-to-end] FAIL:')
  if (r.stdout) console.error(r.stdout)
  if (r.stderr) console.error(r.stderr)
  process.exit(1)
}
console.log('[check-web-search-end-to-end] OK')
