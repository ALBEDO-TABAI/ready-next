import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTaskCardViewModel } from '../renderer/modules/agent/taskCardViewModel'

test('task card view model renders document tasks with generic step sections', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-document-1',
    phase: 'done',
    title: '文档会话',
    taskTitle: '章节改写',
    taskSummary: '已完成：第一部分',
    currentStepId: 'execute',
    waitingFor: 'none',
    resumableActions: ['cancel'],
    steps: [
      { id: 'execute', title: '章节改写', status: 'done', updatedAt: '2026-04-09T12:00:00.000Z' },
    ],
    updatedAt: '2026-04-09T12:00:00.000Z',
  }, undefined)

  assert.equal(vm.title, '章节改写')
  assert.equal(vm.summary, '已完成：第一部分')
  assert.equal(vm.currentStep?.title, '章节改写')
  assert.equal(vm.sections.plan.count, 1)
  assert.equal(vm.sections.plan.summary, '当前：章节改写')
})

test('task card view model renders design tasks with generic step sections', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-design-1',
    phase: 'tool_running',
    title: '设计会话',
    taskTitle: '设计任务',
    taskSummary: '主版式已生成',
    currentStepId: 'execute',
    waitingFor: 'none',
    resumableActions: ['cancel'],
    steps: [
      { id: 'execute', title: '设计任务', status: 'running', updatedAt: '2026-04-09T12:05:00.000Z' },
    ],
    updatedAt: '2026-04-09T12:05:00.000Z',
  }, undefined)

  assert.equal(vm.title, '设计任务')
  assert.equal(vm.summary, '主版式已生成')
  assert.equal(vm.currentStep?.title, '设计任务')
  assert.equal(vm.sections.plan.count, 1)
})

test('task card view model keeps structured summary primary even when execution diagnostics exist', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-browser-2',
    phase: 'planning',
    title: '浏览器会话',
    taskTitle: '浏览器上传流程',
    taskSummary: '准备开始浏览器上传流程',
    executionDiagnostics: {
      compression: {
        historyCompressed: true,
        toolTraceCompressed: false,
        artifactSummaryUsed: false,
      },
      budget: {
        maxIterations: 24,
        maxToolCalls: 24,
        maxParallelToolGroups: 1,
      },
    },
    updatedAt: '2026-04-10T01:00:00.000Z',
  }, undefined)

  assert.equal(vm.title, '浏览器上传流程')
  assert.equal(vm.summary, '准备开始浏览器上传流程')
})
