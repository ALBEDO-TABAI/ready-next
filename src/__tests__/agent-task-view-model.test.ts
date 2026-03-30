import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  buildTaskCardViewModel,
  createDefaultTaskDisclosureState,
  groupTaskRunsForDisplay,
  setTaskDisclosureExpanded,
  type TaskCardRunLike,
} from '../renderer/modules/agent/taskCardViewModel'

function createRun(overrides: Partial<TaskCardRunLike> = {}): TaskCardRunLike {
  return {
    scopeId: overrides.scopeId || 'scope-1',
    phase: overrides.phase || 'tool_running',
    title: overrides.title || '新对话',
    taskTitle: overrides.taskTitle || '技能执行 · lets-go-rss',
    taskSummary: overrides.taskSummary || '正在整理 RSS 内容',
    currentStepId: overrides.currentStepId || 'fetch',
    waitingFor: overrides.waitingFor || 'none',
    resumableActions: overrides.resumableActions || ['cancel'],
    steps: overrides.steps || [
      { id: 'fetch', title: '抓取内容', status: 'running', updatedAt: '2026-03-30T10:00:00.000Z' },
      { id: 'summarize', title: '整理摘要', status: 'pending', updatedAt: '2026-03-30T10:00:00.000Z' },
    ],
    recentArtifacts: overrides.recentArtifacts || [
      { id: 'a-1', module: 'rss', kind: 'report', label: 'rss-report.md', path: '/tmp/rss-report.md', createdAt: '2026-03-30T10:00:00.000Z' },
    ],
    memoryCapture: overrides.memoryCapture || null,
    blockedReason: overrides.blockedReason || null,
    error: overrides.error || null,
    updatedAt: overrides.updatedAt || '2026-03-30T10:00:00.000Z',
    toolTrace: overrides.toolTrace || [
      { id: 't-1', kind: 'result', text: '[阶段] 步骤 1/2 抓取内容：已读取 10 条文章', timestamp: new Date('2026-03-30T10:00:00.000Z') },
      { id: 't-2', kind: 'call', text: 'rss.fetch()', timestamp: new Date('2026-03-30T10:00:01.000Z') },
      { id: 't-3', kind: 'result', text: '已生成摘要草稿', timestamp: new Date('2026-03-30T10:00:02.000Z') },
    ],
  }
}

describe('task card view model', () => {
  it('keeps overview open while plan/details/artifacts stay collapsed by default', () => {
    const run = createRun()
    const disclosure = createDefaultTaskDisclosureState(run)
    const vm = buildTaskCardViewModel(run, disclosure)

    assert.strictEqual(vm.sections.overview.expanded, true)
    assert.strictEqual(vm.sections.plan.expanded, false)
    assert.strictEqual(vm.sections.details.expanded, false)
    assert.strictEqual(vm.sections.artifacts.expanded, false)
    assert.strictEqual(vm.sections.memory.expanded, false)
    assert.strictEqual(vm.currentStep?.title, '抓取内容')
  })

  it('auto-opens memory section when memory capture is ready', () => {
    const run = createRun({
      phase: 'done',
      memoryCapture: {
        status: 'ready',
        createdAt: '2026-03-30T10:10:00.000Z',
        items: [
          { memoryId: 'mem-1', category: 'summary', title: '本次摘要', summary: '完成 RSS 摘要整理' },
        ],
      },
    })
    const vm = buildTaskCardViewModel(run, createDefaultTaskDisclosureState(run))

    assert.strictEqual(vm.sections.memory.expanded, true)
    assert.strictEqual(vm.sections.memory.count, 1)
  })

  it('supports disclosure overrides for a specific section', () => {
    const run = createRun()
    const disclosure = setTaskDisclosureExpanded(createDefaultTaskDisclosureState(run), 'details', true)
    const vm = buildTaskCardViewModel(run, disclosure)

    assert.strictEqual(vm.sections.details.expanded, true)
    assert.strictEqual(vm.detailGroups.length, 1)
  })

  it('groups similar active background tasks into a parent entry', () => {
    const grouped = groupTaskRunsForDisplay([
      createRun({ scopeId: 'scope-1', taskTitle: '技能执行 · lets-go-rss', updatedAt: '2026-03-30T10:00:00.000Z' }),
      createRun({ scopeId: 'scope-2', taskTitle: '技能执行 · lets-go-rss', updatedAt: '2026-03-30T10:01:00.000Z' }),
      createRun({ scopeId: 'scope-3', taskTitle: '浏览器任务', updatedAt: '2026-03-30T10:05:00.000Z' }),
    ], new Date('2026-03-30T10:01:30.000Z'))

    assert.strictEqual(grouped.length, 2)
    const parent = grouped.find((item) => item.kind === 'group')
    assert.ok(parent)
    assert.strictEqual(parent?.children.length, 2)
    assert.match(parent?.summary || '', /2 个子任务/)
  })
})
