#!/usr/bin/env node
/**
 * Stage R W1.2 — web_fetch tool end-to-end gate.
 *
 * Spawns `npx tsx@^4.19.2 --test src/__tests__/web-fetch-tool.test.ts`
 * and confirms the test file passes.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = process.cwd()
const TEST_FILE = 'src/__tests__/web-fetch-tool.test.ts'

if (!fs.existsSync(path.join(ROOT, TEST_FILE))) {
  console.error(`[check-web-fetch-end-to-end] FAIL: missing ${TEST_FILE}`)
  process.exit(1)
}

const r = spawnSync('npx', ['tsx@^4.19.2', '--test', '--test-concurrency=1', TEST_FILE], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

if (r.status !== 0) {
  console.error('[check-web-fetch-end-to-end] FAIL:')
  if (r.stdout) console.error(r.stdout)
  if (r.stderr) console.error(r.stderr)
  process.exit(1)
}
console.log('[check-web-fetch-end-to-end] OK')
