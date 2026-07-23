#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const electron = require('electron')
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const result = spawnSync(electron, [
  tsxCli,
  '--test',
  '--test-concurrency=1',
  'src/__tests__/browser-target-claims-native.test.ts',
], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})

if (result.error) throw result.error
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)

const signalResult = spawnSync(process.execPath, [
  'scripts/run-browser-takeover-native-signal-tests.cjs',
], {
  cwd: root,
  env: { ...process.env },
  stdio: 'inherit',
})
if (signalResult.error) throw signalResult.error
process.exit(signalResult.status ?? 1)
