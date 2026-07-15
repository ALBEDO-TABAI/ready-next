#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')

const electronBinary = require('electron')
const result = spawnSync(electronBinary, [
  '--import', 'tsx', '--test', '--test-concurrency=1',
  'src/__tests__/migration-task-agent-binding.test.ts',
  'src/__tests__/migration-034-run-meta.test.ts',
  'src/__tests__/migration-077-direct-answer-truth.test.ts',
  'src/__tests__/migration-078-local-conversation-user-binding-native.test.ts',
], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status == null ? 1 : result.status)
console.log('[check-agent-foundation-native] OK')
