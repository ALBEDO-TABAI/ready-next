#!/usr/bin/env node
/**
 * Phase D D3（2026-07-05）—— run-timeline 事件单源合同。
 *
 * 1. 主进程：run 家族五通道（agent:stream/status/error/scopeRunEvent/
 *    conversationEvent）的 `webContents.send` 全仓只允许出现在
 *    run-timeline-emitter.ts（唯一发射漏斗，负载盖 timeline 信封戳）。
 * 2. renderer：五通道的订阅（onStream/onStatusChange/onError/
 *    onScopeRunEvent/onConversationEvent 调用）只允许出现在
 *    runtimeDriver.ts 单枢纽（preload 桥定义、类型声明、preview mock 豁免）。
 * 3. 漏斗自身必须盖戳（timeline: stampRunTimeline）。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const EMITTER_REL = 'src/main/modules/claude-bridge/run-timeline-emitter.ts'
const RENDERER_HUB_REL = 'src/renderer/modules/agent/runtimeDriver.ts'

const RENDERER_EXEMPT = new Set([
  RENDERER_HUB_REL,
  'src/renderer/modules/agent/runtime-driver-stream-events.ts',
  'src/renderer/modules/agent/runtime-driver-scope-events.ts',
  'src/renderer/types/electron.d.ts',
  'src/renderer/preview/installSettingsPreviewMocks.ts',
])

function listFiles(dir, exts) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        stack.push(abs)
        continue
      }
      if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) out.push(abs)
    }
  }
  return out
}

function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/')
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length
}

const errors = []

// 1) 主进程发射面
const MAIN_SEND_RE = /webContents\.send\(\s*['"]agent:(stream|status|error|scopeRunEvent|conversationEvent)['"]/g
for (const abs of listFiles(path.join(ROOT, 'src/main'), ['.ts'])) {
  const fileRel = rel(abs)
  const text = fs.readFileSync(abs, 'utf8')
  let match
  while ((match = MAIN_SEND_RE.exec(text))) {
    if (fileRel === EMITTER_REL) continue
    errors.push(`main_send_outside_emitter:${fileRel}:${lineOf(text, match.index)} agent:${match[1]}`)
  }
}

// 2) 漏斗存在 + 盖戳
const emitterAbs = path.join(ROOT, EMITTER_REL)
if (!fs.existsSync(emitterAbs)) {
  errors.push(`missing_emitter:${EMITTER_REL}`)
} else {
  const emitter = fs.readFileSync(emitterAbs, 'utf8')
  if (!/timeline:\s*stampRunTimeline\(/.test(emitter)) {
    errors.push(`emitter_missing_timeline_stamp:${EMITTER_REL}`)
  }
  const sendCount = (emitter.match(/webContents\.send\(/g) || []).length
  if (sendCount !== 1) {
    errors.push(`emitter_send_count_not_one:${EMITTER_REL} count=${sendCount}`)
  }
}

// 3) renderer 订阅面（.test/.spec 不扫；preview/类型声明豁免）
const RENDERER_SUB_RE = /\.(onStream|onStatusChange|onError|onScopeRunEvent|onConversationEvent)\(/g
for (const abs of listFiles(path.join(ROOT, 'src/renderer'), ['.ts', '.tsx'])) {
  const fileRel = rel(abs)
  if (fileRel.includes('__tests__')) continue
  if (RENDERER_EXEMPT.has(fileRel)) continue
  const text = fs.readFileSync(abs, 'utf8')
  let match
  while ((match = RENDERER_SUB_RE.exec(text))) {
    errors.push(`renderer_subscription_outside_hub:${fileRel}:${lineOf(text, match.index)} ${match[1]}`)
  }
}

if (errors.length > 0) {
  console.error('[check-run-timeline-single-source] FAIL')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
console.log('[check-run-timeline-single-source] OK')
