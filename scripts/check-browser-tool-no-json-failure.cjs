#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
// B4（2026-07-04）—— Power 工具组拆至 browser-power-tools.ts 后，拆出实现体
// 同样受"浏览器失败必须走 ToolExecutionOutput、不得裸 JSON 字符串"合同约束。
// B5（2026-07-05）—— 采集/内容任务组拆至 browser-collection-tools.ts，同上。
// B6（2026-07-05）—— 观察/感知组拆至 browser-observe-tools.ts，同上。
// B7（2026-07-05）—— 行动/导航组拆至 browser-act-tools.ts，同上。
const TARGETS = [
  'src/main/modules/tools/browser-tools.ts',
  'src/main/modules/tools/browser-power-tools.ts',
  'src/main/modules/tools/browser-collection-tools.ts',
  'src/main/modules/tools/browser-observe-tools.ts',
  'src/main/modules/tools/browser-act-tools.ts',
]

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
  let failed = false
  for (const target of TARGETS) {
    const source = fs.readFileSync(path.join(ROOT, target), 'utf8')
    const findings = findJsonFailureReturns(source)
    if (findings.length > 0) {
      console.error('[check-browser-tool-no-json-failure] FAIL: browser failures must return ToolExecutionOutput, not naked JSON strings')
      for (const item of findings) {
        console.error(`  - ${target}:${item.line}: ${item.excerpt.trim()}`)
      }
      failed = true
    }
  }
  if (failed) process.exit(1)
  console.log('[check-browser-tool-no-json-failure] OK')
}

if (require.main === module) {
  main()
}

module.exports = { findJsonFailureReturns, findMatchingParen, hasDynamicFailureOk }
