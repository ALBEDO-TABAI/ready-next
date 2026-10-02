#!/usr/bin/env node
'use strict'
const { readdirSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const files = readdirSync('src/__tests__')
  .filter((name) => /^rss-.*\.test\.(ts|tsx)$/.test(name))
  .map((name) => `src/__tests__/${name}`)
if (files.length === 0) throw new Error('No RSS tests found.')
const result = spawnSync(require('electron'), [
  'node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1', '--test-reporter=tap', ...files,
], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
if (result.error) throw result.error
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
const skipped = /# skipped [1-9]\d*/.test(result.stdout)
if (skipped) console.error('RSS native verification must not skip tests.')
process.exit(result.status === 0 && !skipped ? 0 : (result.status || 1))
