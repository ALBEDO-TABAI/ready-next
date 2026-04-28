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

test('task card view model prefers projection status and steps when available', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-document-2',
    phase: 'done',
    status: 'blocked',
    title: '文档会话',
    taskTitle: '章节改写',
    taskSummary: '等待确认后继续',
    currentStepId: 'execute',
    waitingFor: 'none',
    resumableActions: ['continue', 'cancel'],
    steps: [
      { id: 'execute', title: '章节改写', status: 'blocked', updatedAt: '2026-04-17T10:00:00.000Z' },
    ],
    updatedAt: '2026-04-17T10:00:00.000Z',
  }, undefined)

  assert.equal(vm.statusLabel, '等待继续')
  assert.equal(vm.currentStep?.status, 'blocked')
  assert.equal(vm.sections.plan.summary, '当前：章节改写')
})

test('task card view model surfaces skill output artifacts', () => {
  const vm = buildTaskCardViewModel({
    scopeId: 'scope-skill-vea',
    phase: 'done',
    status: 'done',
    title: '视频分析',
    taskTitle: '技能执行 · Video Expert Analyzer',
    taskSummary: '视频分析已完成',
    waitingFor: 'none',
    resumableActions: ['open_artifact'],
    recentArtifacts: [
      {
        id: 'artifact-1',
        module: 'skill',
        kind: 'artifact',
        label: 'run_state.json',
        path: '/tmp/video/out/run_state.json',
        createdAt: '2026-04-17T10:00:00.000Z',
        meta: { outputKey: 'runStatePath' },
      },
      {
        id: 'artifact-2',
        module: 'skill',
        kind: 'artifact',
        label: 'scene_scores.json',
        path: '/tmp/video/out/scene_scores.json',
        createdAt: '2026-04-17T10:00:00.000Z',
        meta: { outputKey: 'sceneScoresPath' },
      },
    ],
    updatedAt: '2026-04-17T10:00:00.000Z',
  }, undefined)

  assert.equal(vm.sections.artifacts.count, 2)
  assert.equal(vm.sections.artifacts.summary, 'run_state.json')
})
