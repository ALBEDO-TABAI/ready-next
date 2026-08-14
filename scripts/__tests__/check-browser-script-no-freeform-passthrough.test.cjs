'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const { listBrowserActSources } = require('../check-browser-script-no-freeform-passthrough.cjs')
const SCANNER = path.join(process.cwd(), 'scripts/check-browser-script-no-freeform-passthrough.cjs')

function writeValidEntry(toolsDir) {
  fs.mkdirSync(toolsDir, { recursive: true })
  fs.writeFileSync(path.join(toolsDir, 'browser-tools.ts'), `
import { resolveBrowserToolInvocation } from './browser-tool-invocation'
import { executeBrowserActTool } from './browser-act-tools'
export function run(toolName, args) {
  const invocation = resolveBrowserToolInvocation(toolName, args)
  return executeBrowserActTool(invocation.operation, invocation.args)
}
`)
  fs.writeFileSync(path.join(toolsDir, 'browser-tool-invocation.ts'), `
function cleanModelClaims(args) {
  const { custom_script: _customScript, ...trustedArgs } = args
  return trustedArgs
}
`)
  fs.writeFileSync(path.join(toolsDir, 'browser-readonly-script-templates.ts'), `
export function compileBrowserReadonlyScriptTemplate() {}
export const names = ['read_text', 'read_attr', 'read_all_text', 'count_selector', 'exists_selector', 'read_rect', 'read_meta']
`)
  for (const name of ['browser-power-tools.ts', 'browser-collection-tools.ts', 'browser-observe-tools.ts', 'browser-act-tools.ts']) {
    fs.writeFileSync(path.join(toolsDir, name), 'export const ok = true\n')
  }
}

test('real codebase still has the current invocation entry and act leaves', () => {
  const files = listBrowserActSources()
  assert.ok(files.some((file) => file.name === 'browser-act-tools.ts'))
  assert.ok(files.some((file) => file.name === 'browser-act-pointer.ts'))
})

test('freeform gate passes on the real codebase', () => {
  const result = spawnSync(process.execPath, [SCANNER], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /OK/)
})

test('freeform gate fails when a new browser-act leaf forwards custom_js', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-freeform-scan-'))
  const toolsDir = path.join(root, 'src/main/modules/tools')
  writeValidEntry(toolsDir)
  fs.writeFileSync(path.join(toolsDir, 'browser-act-pointer.ts'), `
export async function executeBrowserActPointer(_toolName, args) {
  return controller.waitForCondition(tabId, {
    customJs: typeof args.custom_js === 'string' ? args.custom_js : '',
  })
}
`)
  const result = spawnSync(process.execPath, [SCANNER], {
    env: { ...process.env, BROWSER_TOOL_SCAN_ROOT: root },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /browser-act-pointer\.ts/)
})
