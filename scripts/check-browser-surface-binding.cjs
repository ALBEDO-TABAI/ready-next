#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const LEGACY_PATHS = [
  'src/main/modules/browser-engine/browser-write-lease.ts',
  'src/main/modules/browser-engine/scoped-browser-facade.ts',
  'src/main/modules/browser-engine/agent-browser-lane.ts',
  'src/main/modules/browser-engine/agent-browser-lease-singleton.ts',
  'src/main/modules/browser-engine/user-view-takeover-bridge.ts',
]
const EXECUTE_BROWSER_TOOL_ALLOWLIST = new Set([
  'src/main/modules/tools/browser-tools.ts',
  'src/main/modules/tools/index.ts',
  'src/main/modules/tools/tool-executor.ts',
])

function fail(message) {
  console.error(`[check-browser-surface-binding] FAIL: ${message}`)
  process.exit(1)
}

function read(relPath) {
  const file = path.join(ROOT, relPath)
  if (!fs.existsSync(file)) fail(`missing required file: ${relPath}`)
  return fs.readFileSync(file, 'utf8')
}

for (const legacy of LEGACY_PATHS) {
  if (fs.existsSync(path.join(ROOT, legacy))) fail(`legacy ownership path still exists: ${legacy}`)
}

const claims = read('src/main/modules/browser-engine/browser-target-claims.ts')
for (const token of ['BrowserTargetClaimRepository', 'BrowserTargetClaimService', 'checkWrite(', 'recordUserSignal(']) {
  if (!claims.includes(token)) fail(`target-claim authority missing ${token}`)
}
const gate = read('src/main/modules/browser-engine/agent-browser-lease-gate.ts')
if (!gate.includes('BrowserTargetClaimService') || !gate.includes('checkWrite(')) {
  fail('browser write gate must read BrowserTargetClaimService')
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(next))
    else if (entry.name.endsWith('.ts')) files.push(next)
  }
  return files
}

for (const file of walk(path.join(ROOT, 'src/main'))) {
  const source = stripComments(fs.readFileSync(file, 'utf8'))
  if (!/\bexecuteBrowserTool\b/.test(source)) continue
  const relative = path.relative(ROOT, file).replace(/\\/g, '/')
  if (!EXECUTE_BROWSER_TOOL_ALLOWLIST.has(relative)) {
    fail(`executeBrowserTool bypasses the target-claim tool funnel: ${relative}`)
  }
  if (relative.endsWith('/index.ts') && /\bexecuteBrowserTool\s*\(/.test(source)) {
    fail('tools/index.ts may only re-export executeBrowserTool')
  }
}

console.log('[check-browser-surface-binding] OK')
