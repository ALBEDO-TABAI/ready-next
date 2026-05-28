#!/usr/bin/env node
'use strict'

const { spawn } = require('node:child_process')

const TYPECHECK_SCRIPTS = ['typecheck:node', 'typecheck:web']

function summarizeTypecheckResults(results) {
  return results.some((result) => result.error || result.signal || result.code !== 0) ? 1 : 0
}

function runNpmScript(scriptName) {
  return new Promise((resolve) => {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npmBin, ['run', scriptName], {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    })

    child.on('error', (error) => {
      resolve({ scriptName, code: 1, signal: null, error })
    })
    child.on('exit', (code, signal) => {
      resolve({ scriptName, code: code ?? 1, signal, error: null })
    })
  })
}

async function main() {
  const results = await Promise.all(TYPECHECK_SCRIPTS.map(runNpmScript))
  process.exit(summarizeTypecheckResults(results))
}

if (require.main === module) {
  void main()
}

module.exports = {
  summarizeTypecheckResults,
}
