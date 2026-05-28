#!/usr/bin/env node
/**
 * Run the parallel half of `npm test`.
 *
 * `npm test` is split into two phases:
 *   1. parallel — concurrency=10, excludes skill-child-* test files
 *   2. serial   — concurrency=1, only the skill-child-* test files
 *
 * Why: skill-child-* tests use module-level singletons in
 * skill-child-runner / skill-child-drivers and reset them in their setup
 * hooks. When two test files run concurrently and both touch the singleton,
 * abort signals from one bleed into the other and produce
 * `unhandledRejection` events that the Node test runner flags as
 * post-test async activity. Keeping the skill-child-* family on a
 * single-threaded pass avoids the cross-test pollution without slowing the
 * rest of the suite down (still concurrency=10 for ~520 other test files).
 */
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const TEST_DIR = path.join(ROOT, 'src/__tests__')

// The CLI argv is allowed to carry the glob hint that the
// `check-test-coverage-by-verify` walker uses to expand referenced files
// (e.g. `node scripts/run-parallel-tests.cjs src/__tests__/*.test.ts`).
// We don't need it at runtime — we re-derive the file list from the
// directory ourselves — but accepting it keeps the gate honest.
const files = fs.readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.ts') || name.endsWith('.test.tsx'))
  .filter((name) => !name.startsWith('skill-child-'))
  .map((name) => path.join('src/__tests__', name))

if (files.length === 0) {
  console.log('# (no parallel test files)')
  process.exit(0)
}

const args = ['--import', 'tsx', '--test', '--test-concurrency=10', ...files]
const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT })
process.exit(result.status ?? 1)
