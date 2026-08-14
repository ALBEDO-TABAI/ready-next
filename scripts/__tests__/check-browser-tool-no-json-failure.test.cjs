'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  findJsonFailureReturns,
  listBrowserActToolFiles,
} = require('../check-browser-tool-no-json-failure.cjs')

test('flags explicit browser failure objects returned as JSON strings', () => {
  const findings = findJsonFailureReturns(`
export async function run() {
  return JSON.stringify({
    ok: false,
    errorCode: 'source_task_missing',
    message: 'missing',
  }, null, 2)
}
`)
  assert.equal(findings.length, 1)
})

test('allows success JSON results', () => {
  const findings = findJsonFailureReturns(`
export async function run() {
  return JSON.stringify({
    ok: true,
    count: 1,
  }, null, 2)
}
`)
  assert.equal(findings.length, 0)
})

test('flags agentBrowserError stringify wrappers', () => {
  const findings = findJsonFailureReturns(`
export async function run() {
  return JSON.stringify(agentBrowserError('target_not_found', 'missing'), null, 2)
}
`)
  assert.equal(findings.length, 1)
})

test('flags dynamic ok values with failure fields', () => {
  const findings = findJsonFailureReturns(`
export async function run(analysis) {
  return JSON.stringify({
    ok: analysis.ok,
    reason: analysis.reason,
  }, null, 2)
}
`)
  assert.equal(findings.length, 1)
})

test('flags dynamic ok values with parseStatus failures', () => {
  const findings = findJsonFailureReturns(`
export async function run(video) {
  return JSON.stringify({
    ok: video.parseStatus !== 'failed',
    video,
  }, null, 2)
}
`)
  assert.equal(findings.length, 1)
})

test('flags wrong browser task id payload stringification', () => {
  const findings = findJsonFailureReturns(`
export async function run(taskId) {
  return JSON.stringify(wrongBrowserTaskIdPayload('browser_get_task', taskId), null, 2)
}
`)
  assert.equal(findings.length, 1)
})

test('scan targets include every browser-act source file', () => {
  const files = listBrowserActToolFiles()
  assert.ok(files.includes('src/main/modules/tools/browser-act-tools.ts'))
  assert.equal(files.every((file) => file.startsWith('src/main/modules/tools/browser-act-') && file.endsWith('.ts')), true)
})

test('act module boundary gate passes on the real codebase', () => {
  const result = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/check-browser-act-module-boundary.cjs')], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /OK/)
})

test('json-failure gate fails when a browser-act leaf contains a forbidden return', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-act-scan-'))
  const toolsDir = path.join(root, 'src/main/modules/tools')
  fs.mkdirSync(toolsDir, { recursive: true })
  for (const name of ['browser-tools.ts', 'browser-power-tools.ts', 'browser-collection-tools.ts', 'browser-observe-tools.ts', 'browser-act-tools.ts']) {
    fs.writeFileSync(path.join(toolsDir, name), 'export const ok = true\n')
  }
  fs.writeFileSync(path.join(toolsDir, 'browser-act-upload.ts'), `
export async function run() {
  return JSON.stringify({
    ok: false,
    errorCode: 'upload_target_not_found',
  }, null, 2)
}
`)
  const result = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/check-browser-tool-no-json-failure.cjs')], {
    env: { ...process.env, BROWSER_TOOL_SCAN_ROOT: root },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /browser-act-upload\.ts/)
})
