#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const TOOLS = path.join(ROOT, 'src/main/modules/tools')
const FACADE = 'browser-act-tools.ts'
const LEAVES = fs.readdirSync(TOOLS)
  .filter((name) => name.startsWith('browser-act-') && name.endsWith('.ts') && name !== FACADE)

let failed = false
function fail(message) {
  console.error(`[check-browser-act-module-boundary] FAIL — ${message}`)
  failed = true
}

const facadeSource = fs.readFileSync(path.join(TOOLS, FACADE), 'utf8')
for (const banned of ['runGuardedCoordinateClick', 'setFileInputFiles', 'runGuardedCoordinateType', 'dispatchClickAt']) {
  if (facadeSource.includes(banned)) fail(`facade carries action implementation symbol ${banned}`)
}

for (const leaf of LEAVES) {
  const source = fs.readFileSync(path.join(TOOLS, leaf), 'utf8')
  if (/from\s+['\"]\.\/browser-act-tools['\"]/.test(source) || /from\s+['\"][^'\"]*browser-act-tools['\"]/.test(source)) {
    fail(`${leaf} imports the act facade`)
  }
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'out' || entry.name === 'dist') continue
      walk(next, acc)
    } else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name)) {
      acc.push(next)
    }
  }
  return acc
}

const productionRoots = ['src/main', 'src/preload', 'src/renderer', 'src/shared'].map((dir) => path.join(ROOT, dir))
for (const start of productionRoots) {
  if (!fs.existsSync(start)) continue
  for (const file of walk(start)) {
    const rel = path.relative(ROOT, file)
    if (rel.startsWith('src/main/modules/tools/browser-act-')) continue
    const source = fs.readFileSync(file, 'utf8')
    const imports = source.match(/from\s+['\"][^'\"]*browser-act-[^'\"]+['\"]/g) || []
    for (const item of imports) {
      if (!/browser-act-tools['\"]$/.test(item)) {
        fail(`${rel} imports act leaf directly: ${item}`)
      }
    }
  }
}

if (failed) process.exit(1)
console.log('[check-browser-act-module-boundary] OK')
