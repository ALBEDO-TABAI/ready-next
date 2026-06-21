#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function read(relPath) {
  const full = path.join(ROOT, relPath)
  if (!fs.existsSync(full)) fail(`missing required file: ${relPath}`)
  return fs.readFileSync(full, 'utf8')
}

function fail(message) {
  console.error(`[check-p7c3b-surface-claims] FAIL: ${message}`)
  process.exit(1)
}

function assertIncludes(relPath, needles) {
  const source = read(relPath)
  for (const needle of needles) {
    if (!source.includes(needle)) fail(`${relPath} missing required text: ${needle}`)
  }
  return source
}

const plan = assertIncludes('docs/superpowers/plans/2026-06-20-p7c3b-default-surface-tightening-implementation.md', [
  'No browser profile, partition, cookie, login, permission, history, download, or site-learning isolation.',
  'No claim that P7c3b closes P7c4.',
  'Deferred To P7c4',
])

const roadmap = assertIncludes('outputs/agent-audit/fix-plan/00-ROADMAP.md', [
  'P7c3b  default surface tightening',
  '不声称隔离',
])

assertIncludes('src/renderer/modules/browser/browserOwnershipStatus.ts', [
  'Agent 协作当前页',
  '当前可见页写锁',
  'Agent 后台页',
  '后台 Agent 页写锁',
])

assertIncludes('src/renderer/components/browser/AgentBrowserSupervisionPanel.tsx', [
  '当前可见页协作',
  '后台 Agent 页',
  'Agent 正在协作当前页',
  'Agent 正在后台页工作',
])

const overclaimPatterns = [
  /P7c3b[^\n]*(?:isolation|隔离)[^\n]*(?:complete|done|closed|achieved|完成|关闭|实现)/i,
  /P7c3b[^\n]*(?:complete|done|closed|achieved|完成|关闭|实现)[^\n]*(?:isolation|隔离|P7c4)/i,
]

for (const [label, source] of [['plan', plan], ['roadmap', roadmap]]) {
  for (const pattern of overclaimPatterns) {
    const lines = source.split(/\r?\n/)
    const match = lines.find((line) => pattern.test(line) && !/(?:No claim|not isolation|不声称隔离|不得.*隔离|非.*隔离)/i.test(line))
    if (match) fail(`${label} overclaims P7c3b: ${match}`)
  }
}

console.log('[check-p7c3b-surface-claims] OK')
