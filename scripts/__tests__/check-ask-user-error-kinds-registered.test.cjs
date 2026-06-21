'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-ask-user-error-kinds-registered.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function runIn(root) {
  return spawnSync('node', ['scripts/check-ask-user-error-kinds-registered.cjs'], {
    cwd: root,
    encoding: 'utf8',
  })
}

function writeFile(root, rel, body) {
  const filePath = path.join(root, rel)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, body)
}

function makeHarnessRoot(t, askUserBody = "export const output = { errorKind: 'input_validation' }") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-user-error-kind-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts/check-ask-user-error-kinds-registered.cjs'))
  writeFile(root, 'src/main/modules/agent-control/contracts/error-kinds.ts', `
export const ASK_USER_ERROR_KINDS = {
  inputValidation: {
    code: 'input_validation',
    noMetric: true,
    description: 'validation failed',
  },
}

export const PROVIDER_ERROR_KINDS = {
  providerRequestFailed: {
    code: 'provider_request_failed',
    noMetric: true,
    description: 'provider blocked',
  },
  providerThinkingEchoRequired: {
    code: 'provider_thinking_echo_required',
    noMetric: true,
    description: 'provider thinking echo required',
  },
}
`)
  writeFile(root, 'src/main/modules/agent-control/tools-runtime/tool-error-metrics.ts', `
export const TOOL_ERROR_METRICS = {}
`)
  writeFile(root, 'src/main/modules/tools/builtins/ask-user-questions.ts', askUserBody)
  return root
}

test('ask-user errorKind gate passes on the real codebase', () => {
  const result = spawnSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-ask-user-error-kinds-registered: OK/)
})

test('ask-user errorKind gate accepts codes from ASK_USER_ERROR_KINDS', (t) => {
  const root = makeHarnessRoot(t)
  const result = runIn(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-ask-user-error-kinds-registered: OK/)
})

test('ask-user errorKind gate rejects provider_request_failed even when provider registry owns it', (t) => {
  const root = makeHarnessRoot(t, "export const output = { errorKind: 'provider_request_failed' }")
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not registered in ASK_USER_ERROR_KINDS/)
})

test('ask-user errorKind gate rejects provider_thinking_echo_required even when provider registry owns it', (t) => {
  const root = makeHarnessRoot(t, "export const output = { errorKind: 'provider_thinking_echo_required' }")
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not registered in ASK_USER_ERROR_KINDS/)
})
