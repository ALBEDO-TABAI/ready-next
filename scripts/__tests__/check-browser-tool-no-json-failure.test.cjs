'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { findJsonFailureReturns } = require('../check-browser-tool-no-json-failure.cjs')

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
