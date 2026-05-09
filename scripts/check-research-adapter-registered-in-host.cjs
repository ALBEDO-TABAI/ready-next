#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * direct-chat.ts `domainAdapters` array must:
 *   1. import ResearchDomainAdapter
 *   2. instantiate it with `new ResearchDomainAdapter()`
 *   3. place it FIRST in the adapters array (so research intents are routed
 *      before browser/document adapters can grab them)
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(ROOT, 'src/main/modules/claude-bridge/direct-chat.ts')

let src
try {
  src = fs.readFileSync(FILE, 'utf8')
} catch (e) {
  console.error(`[check-research-adapter-registered-in-host] FAIL: cannot read ${FILE}: ${e.message}`)
  process.exit(1)
}

const errors = []

// 1. ResearchDomainAdapter must be imported
if (!/import\s*\{\s*ResearchDomainAdapter\s*\}\s*from\s*['"][^'"]*research-domain-adapter['"]/.test(src)) {
  errors.push('missing `import { ResearchDomainAdapter } from \'.../research-domain-adapter\'`')
}

// 2. Locate domainAdapters array assignment.
const arrayMatch = src.match(/this\.domainAdapters\s*=\s*\[([\s\S]*?)\]/)
if (!arrayMatch) {
  errors.push('this.domainAdapters array assignment not found')
} else {
  const arrayBody = arrayMatch[1]
  if (!/new\s+ResearchDomainAdapter\s*\(/.test(arrayBody)) {
    errors.push('domainAdapters array must include `new ResearchDomainAdapter()`')
  } else {
    // 3. Verify ResearchDomainAdapter is placed first.
    // Strip leading comments/whitespace and check the first non-comment entry.
    const lines = arrayBody.split('\n')
    let firstEntryLine = null
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('//')) continue
      firstEntryLine = trimmed
      break
    }
    if (!firstEntryLine || !firstEntryLine.startsWith('new ResearchDomainAdapter(')) {
      errors.push(
        'ResearchDomainAdapter must be placed FIRST in the domainAdapters array '
        + '(found first non-comment entry: `' + (firstEntryLine || '<empty>') + '`)',
      )
    }
  }
}

if (errors.length > 0) {
  console.error('[check-research-adapter-registered-in-host] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}

console.log('[check-research-adapter-registered-in-host] OK')
