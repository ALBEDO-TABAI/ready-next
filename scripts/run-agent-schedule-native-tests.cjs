#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const electron = require('electron')
const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
const result = spawnSync(electron, [
  tsxCli,
  '--test',
  '--test-concurrency=1',
  'src/__tests__/agent-schedule-repository.test.ts',
], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
