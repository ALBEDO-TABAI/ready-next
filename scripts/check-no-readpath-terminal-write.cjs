#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const TARGET = 'src/main/modules/agent-control/task-projection/task-projection-reconciler.ts'

function findFunctionBody(source, name) {
  const signature = new RegExp(`function\\s+${name}\\s*\\(`)
  const match = signature.exec(source)
  if (!match) return null
  const open = source.indexOf('{', match.index)
  if (open < 0) return null
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return null
}

function inspectReadpathTerminalGuard(source) {
  const findings = []
  const guardBody = findFunctionBody(source, 'isReadPathTerminalStatusTransition')
  const repairBody = findFunctionBody(source, 'nonTerminalReadPathRepairTarget')
  const reconcileBody = findFunctionBody(source, 'reconcileTaskProjections')
  const readPathTerminalStatuses = extractReadPathTerminalStatuses(source)

  if (!source.includes('READ_PATH_TERMINAL_STATUSES')) {
    findings.push('missing READ_PATH_TERMINAL_STATUSES')
  }
  if (!guardBody) {
    findings.push('missing isReadPathTerminalStatusTransition guard')
  } else {
    for (const status of ['completed', 'failed', 'killed']) {
      if (!readPathTerminalStatuses.has(status) || !guardBody.includes('READ_PATH_TERMINAL_STATUSES.has(target.status)')) {
        findings.push(`guard does not cover terminal status ${status}`)
      }
    }
    if (!guardBody.includes('target.status !== record.status')) {
      findings.push('guard must allow same-status enrichment but reject terminal transitions')
    }
  }
  if (!reconcileBody) {
    findings.push('missing reconcileTaskProjections body')
  } else {
    if (!repairBody || !repairBody.includes('isReadPathTerminalStatusTransition(record, target)')) {
      findings.push('missing non-terminal repair wrapper around terminal-transition guard')
    }
    const guardIndex = reconcileBody.indexOf('nonTerminalReadPathRepairTarget(record, target)')
    const updateIndex = reconcileBody.indexOf('params.store.update')
    if (guardIndex < 0) {
      findings.push('reconcileTaskProjections does not sanitize terminal-transition targets')
    } else if (updateIndex >= 0 && guardIndex > updateIndex) {
      findings.push('terminal-transition sanitizer must run before params.store.update')
    }
  }

  return findings
}

function extractReadPathTerminalStatuses(source) {
  const match = source.match(/READ_PATH_TERMINAL_STATUSES\s*=\s*new\s+Set(?:<[^>]+>)?\s*\(\s*\[([\s\S]*?)\]\s*\)/)
  if (!match) return new Set()
  const statuses = new Set()
  const body = match[1]
  const re = /['"]([^'"]+)['"]/g
  let item
  while ((item = re.exec(body)) !== null) {
    statuses.add(item[1])
  }
  return statuses
}

function main() {
  const source = fs.readFileSync(path.join(ROOT, TARGET), 'utf8')
  const findings = inspectReadpathTerminalGuard(source)
  if (findings.length > 0) {
    console.error('[check-no-readpath-terminal-write] FAIL: read/list reconciliation may write terminal projection status')
    for (const finding of findings) {
      console.error(`  - ${finding}`)
    }
    process.exit(1)
  }
  console.log('[check-no-readpath-terminal-write] OK')
}

if (require.main === module) {
  main()
}

module.exports = { extractReadPathTerminalStatuses, findFunctionBody, inspectReadpathTerminalGuard }
