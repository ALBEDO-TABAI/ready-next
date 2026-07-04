#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const root = process.cwd()
const browserToolsPath = path.join(root, 'src/main/modules/tools/browser-tools.ts')
// B4（2026-07-04）—— browser_execute_js 等 Power case 实现体拆至
// browser-power-tools.ts，自由脚本直通禁则同样覆盖拆出文件。
const browserPowerToolsPath = path.join(root, 'src/main/modules/tools/browser-power-tools.ts')
// B5（2026-07-05）—— browser_extract_structured / browser_scroll_collect /
// browser_start_task 等采集 case 实现体拆至 browser-collection-tools.ts，
// 自由脚本直通禁则同样覆盖拆出文件。
const browserCollectionToolsPath = path.join(root, 'src/main/modules/tools/browser-collection-tools.ts')
const registryPath = path.join(root, 'src/main/modules/tools/browser-readonly-script-templates.ts')

const source = fs.readFileSync(browserToolsPath, 'utf8')
const powerSource = fs.readFileSync(browserPowerToolsPath, 'utf8')
const collectionSource = fs.readFileSync(browserCollectionToolsPath, 'utf8')
let failed = false

function fail(message) {
  console.error(`[check-browser-script-no-freeform-passthrough] FAIL — ${message}`)
  failed = true
}

if (!fs.existsSync(registryPath)) {
  fail('missing browser-readonly-script-templates.ts registry.')
} else {
  const registry = fs.readFileSync(registryPath, 'utf8')
  for (const name of ['read_text', 'read_attr', 'read_all_text', 'count_selector', 'exists_selector', 'read_rect', 'read_meta']) {
    if (!registry.includes(name)) fail(`registry missing template ${name}.`)
  }
}

const highControlIndex = source.indexOf('const highControlDenied = highControlScriptGuard(toolName, args, candidateTargetUrls)')
const verdictIndex = source.indexOf('const scriptReadOnlyVerdict = resolveScriptReadOnlyVerdict(toolName, args)')
const leaseIndex = source.indexOf('const gate = beginLeaseGate(leaseGate, toolName, args)')
if (highControlIndex < 0) fail('highControlScriptGuard call not found.')
if (verdictIndex < 0) fail('resolveScriptReadOnlyVerdict entry call not found.')
if (leaseIndex < 0) fail('lease gate call not found.')
if (highControlIndex >= 0 && verdictIndex >= 0 && verdictIndex < highControlIndex) {
  fail('read-only script verdict must run after highControlScriptGuard.')
}
if (leaseIndex >= 0 && verdictIndex >= 0 && verdictIndex > leaseIndex) {
  fail('read-only script verdict must run before beginLeaseGate.')
}

const forbidden = [
  [/customJs:\s*typeof args\.custom_js\s*===\s*'string'\s*\?\s*args\.custom_js/, 'browser_wait_for_condition directly forwards args.custom_js'],
  [/customScript:\s*typeof args\.custom_script\s*===\s*'string'\s*\?\s*args\.custom_script/, 'browser_extract_structured/browser_scroll_collect directly forwards args.custom_script'],
  [/const code = args\.code as string/, 'browser_execute_js directly reads args.code'],
  [/if \(action === 'execute_js'\)[\s\S]{0,260}?String\(step\.code \|\| ''\)/, 'workflow execute_js directly reads step.code'],
  [/payload,\s*\n\s*\}\)/, 'browser_start_task forwards payload without script verdict sanitization'],
]

for (const [pattern, message] of forbidden) {
  if (pattern.test(source)) fail(message)
  if (pattern.test(powerSource)) fail(`${message} (browser-power-tools.ts)`)
  if (pattern.test(collectionSource)) fail(`${message} (browser-collection-tools.ts)`)
}

if (failed) process.exit(1)
console.log('[check-browser-script-no-freeform-passthrough] OK')
