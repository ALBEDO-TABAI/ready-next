#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const TARGET = 'src/main/modules/tools/browser-tools.ts'

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function lineOf(source, index) {
  return source.slice(0, index).split(/\r?\n/).length
}

function findJsonFailureReturns(source) {
  const stripped = stripComments(source)
  const findings = []
  const pattern = /return\s+JSON\.stringify\s*\(/g
  let match
  while ((match = pattern.exec(stripped)) !== null) {
    const start = match.index
    const openIndex = stripped.indexOf('(', match.index)
    const end = findMatchingParen(stripped, openIndex)
    const block = stripped.slice(start, end > openIndex ? end + 1 : start + 900)
    if (
      /agentBrowserError\s*\(/.test(block) ||
      /wrongBrowserTaskIdPayload\s*\(/.test(block) ||
      /\bok\s*:\s*false\b/.test(block) ||
      hasDynamicFailureOk(block) ||
      /\berrorCode\s*:/.test(block) ||
      /\bfailureKind\b/.test(block)
    ) {
      findings.push({ line: lineOf(stripped, start), excerpt: block.split(/\r?\n/).slice(0, 4).join(' ') })
    }
  }
  return findings
}

function hasDynamicFailureOk(block) {
  const okMatch = /\bok\s*:\s*([^,\n}]+)/.exec(block)
  if (!okMatch) return false
  const okExpr = okMatch[1].trim()
  if (okExpr === 'true' || okExpr === 'false') return false
  return /\b(reason|error|status|fail|failed|parseStatus|verification|completion)\b/.test(block)
}

function findMatchingParen(source, openIndex) {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = openIndex; index < source.length; index += 1) {
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
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function main() {
  const source = fs.readFileSync(path.join(ROOT, TARGET), 'utf8')
  const findings = findJsonFailureReturns(source)
  if (findings.length > 0) {
    console.error('[check-browser-tool-no-json-failure] FAIL: browser failures must return ToolExecutionOutput, not naked JSON strings')
    for (const item of findings) {
      console.error(`  - ${TARGET}:${item.line}: ${item.excerpt.trim()}`)
    }
    process.exit(1)
  }
  console.log('[check-browser-tool-no-json-failure] OK')
}

if (require.main === module) {
  main()
}

module.exports = { findJsonFailureReturns, findMatchingParen, hasDynamicFailureOk }
