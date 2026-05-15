#!/usr/bin/env node

const { spawnSync } = require('node:child_process')

function run(command, args) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  })
}

const check = run('npm', ['run', 'native:check'])
if (check.status === 0) {
  process.exit(0)
}

console.warn('[native:dev] native check failed; rebuilding Electron native dependencies once...')
const rebuild = run('npm', ['run', 'rebuild:native'])
if (rebuild.status !== 0) {
  process.exit(rebuild.status || 1)
}

const verify = run('npm', ['run', 'native:check'])
process.exit(verify.status || 0)
