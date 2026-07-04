#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const root = process.cwd()
const file = path.join(root, 'src/main/modules/tools/browser-tools.ts')
const source = fs.readFileSync(file, 'utf8')

// P3-B2（2026-07-03）把 isBrowserAbortError 分类器拆到 browser-input-actions.ts；
// browser-tools 经 import 使用，catch 侧断言仍在下方针对 browser-tools 本体。
const inputActionsSource = fs.readFileSync(
  path.join(root, 'src/main/modules/tools/browser-input-actions.ts'),
  'utf8',
)
if (!/export function isBrowserAbortError\(/.test(inputActionsSource)) {
  console.error('[check-browser-abort-rethrow] FAIL — missing browser AbortError classifier.')
  process.exit(1)
}

const functionIndex = source.indexOf('export async function executeBrowserTool(')
if (functionIndex < 0) {
  console.error('[check-browser-abort-rethrow] FAIL — executeBrowserTool function not found.')
  process.exit(1)
}

const flattenIndex = source.indexOf('const msg = error instanceof Error ? error.message : String(error)', functionIndex)
if (flattenIndex < 0) {
  console.error('[check-browser-abort-rethrow] FAIL — browser error-flattening path not found.')
  process.exit(1)
}

const catchIndex = source.lastIndexOf('} catch (error) {', flattenIndex)
if (catchIndex < 0) {
  console.error('[check-browser-abort-rethrow] FAIL — executeBrowserTool catch block not found.')
  process.exit(1)
}

const catchBody = source.slice(catchIndex, catchIndex + 500)
if (!/if \(isBrowserAbortError\(error\)\) throw error/.test(catchBody)) {
  console.error('[check-browser-abort-rethrow] FAIL — browser catch must rethrow AbortError before flattening errors.')
  process.exit(1)
}

const abortIdx = catchBody.indexOf('isBrowserAbortError(error)')
const domainIdx = catchBody.indexOf('error instanceof ToolDomainError')
if (domainIdx >= 0 && abortIdx > domainIdx) {
  console.error('[check-browser-abort-rethrow] FAIL — AbortError rethrow must precede ToolDomainError handling.')
  process.exit(1)
}

console.log('[check-browser-abort-rethrow] OK')
