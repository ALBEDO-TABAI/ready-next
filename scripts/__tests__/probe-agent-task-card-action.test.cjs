const assert = require('node:assert/strict')
const { resolve } = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

const ROOT = resolve(__dirname, '..', '..')
const probeModule = import(pathToFileURL(resolve(ROOT, 'scripts/probe-agent-task-card-action.mjs')).href)

function baseReport(label) {
  return {
    ok: true,
    label,
    apiCalls: [],
    before: {
      currentScopeId: 'conv-before',
      messageCount: 2,
      composer: { inputValue: '', pendingSendCount: 0 },
    },
    after: {
      currentScopeId: 'conv-before',
      messageCount: 2,
      composer: { inputValue: '', pendingSendCount: 0 },
    },
  }
}

test('task card action probe rejects continue buttons when only task state changes', async () => {
  const { evaluateTaskCardActionEffect } = await probeModule
  const report = baseReport('继续生成报告')
  report.before.taskCards = [{ taskId: 'skill-child:child-1', status: 'blocked' }]
  report.after.taskCards = [
    { taskId: 'skill-child:child-1', status: 'blocked' },
    { taskId: 'task-resume-1', status: 'running' },
  ]

  const checked = evaluateTaskCardActionEffect(report)

  assert.equal(checked.ok, false)
  assert.equal(checked.error, 'no-action-effect')
  assert.equal(checked.effect.expectation, 'api-success:resumeRun')
})

test('task card action probe rejects failed API results', async () => {
  const { evaluateTaskCardActionEffect } = await probeModule
  const report = baseReport('取消')
  report.apiCalls.push({
    key: 'cancelChildRun',
    args: [{ childRunId: 'vchild01' }],
    result: { success: false, error: 'not found' },
  })

  const checked = evaluateTaskCardActionEffect(report)

  assert.equal(checked.ok, false)
  assert.equal(checked.error, 'no-action-effect')
  assert.equal(checked.effect.expectation, 'api-success:cancelChildRun')
})

test('task card action probe accepts open-session when the active scope changes', async () => {
  const { evaluateTaskCardActionEffect } = await probeModule
  const report = baseReport('打开会话')
  report.before.currentScopeId = null
  report.before.messageCount = 0
  report.after.currentScopeId = 'conv-opened'
  report.after.messageCount = 2

  const checked = evaluateTaskCardActionEffect(report)

  assert.equal(checked.ok, true)
  assert.equal(checked.effect.expectation, 'state:opened-scope')
})

test('task card action probe rejects open-session with no state change', async () => {
  const { evaluateTaskCardActionEffect } = await probeModule
  const report = evaluateTaskCardActionEffect(baseReport('打开会话'))

  assert.equal(report.ok, false)
  assert.equal(report.error, 'no-action-effect')
  assert.equal(report.effect.expectation, 'state:opened-scope')
})
