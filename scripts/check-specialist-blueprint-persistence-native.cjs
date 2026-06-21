#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')

function fail(message, error) {
  console.error(`[check-specialist-blueprint-persistence-native] FAIL: ${message}`)
  if (error) console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
}

let electronBinary
try {
  electronBinary = require('electron')
} catch (error) {
  fail('Cannot resolve the electron binary from node_modules.', error)
}

const result = spawnSync(electronBinary, [
  '--import',
  'tsx',
  '--test',
  '--test-concurrency=1',
  'src/__tests__/migration-specialist-blueprint-persistence.test.ts',
  'src/__tests__/specialist-blueprint-persistence.test.ts',
], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  },
  stdio: 'inherit',
})

if (result.error) {
  fail('Failed to launch Electron native persistence tests.', result.error)
}

if (result.status !== 0) {
  process.exit(result.status == null ? 1 : result.status)
}

console.log('[check-specialist-blueprint-persistence-native] OK')
