#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const TEST_DIR = path.join(ROOT, 'src/__tests__')

const files = fs.readdirSync(TEST_DIR)
  .filter((name) => name.startsWith('skill-child-'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join('src/__tests__', name))

if (files.length === 0) {
  console.log('# (no skill-child test files)')
  process.exit(0)
}

const args = ['--import', 'tsx', '--test', '--test-concurrency=1', ...files]
const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT })
process.exit(result.status ?? 1)
