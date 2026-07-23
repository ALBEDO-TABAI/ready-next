#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const electron = require('electron')
const result = spawnSync(electron, ['scripts/browser-takeover-native-signal-app.mjs'], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
