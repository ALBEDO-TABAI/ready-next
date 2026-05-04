import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  buildTaskCardViewModel,
  createDefaultTaskDisclosureState,
  formatTaskUserFacingText,
  formatTaskProgressLabel,
  formatTaskStepDisplayTitle,
  getTaskRunDisplayKey,
  getTaskStartModeLabel,
  groupTaskRunsForDisplay,
  isInternalAgentHandoffTask,
  setTaskDisclosureExpanded,
  type TaskCardRunLike
} from '../renderer/modules/agent/taskCardViewModel'

function createRun(overrides: Partial<TaskCardRunLike> = {}): TaskCardRunLike {
  return {
    scopeId: overrides.scopeId || 'scope-1',
    taskId: overrides.taskId || null,
    phase: overrides.phase || 'tool_running',
    status: overrides.status,
    title: overrides.title || '新对话',
    taskTitle: overrides.taskTitle || '技能执行 · lets-go-rss',
    taskSummary: overrides.taskSummary || '正在整理 RSS 内容',
    currentStepId: overrides.currentStepId || 'fetch',
    waitingFor: overrides.waitingFor || 'none',
    resumableActions: overrides.resumableActions || ['cancel'],
    steps: overrides.steps || [
      { id: 'fetch', title: '抓取内容', status: 'running', updatedAt: '2026-03-30T10:00:00.000Z' },
      {
        id: 'summarize',
        title: '整理摘要',
        status: 'pending',
        updatedAt: '2026-03-30T10:00:00.000Z'
      }
    ],
    recentArtifacts: overrides.recentArtifacts || [
      {
        id: 'a-1',
        module: 'rss',
        kind: 'report',
        label: 'rss-report.md',
        path: '/tmp/rss-report.md',
        createdAt: '2026-03-30T10:00:00.000Z'
      }
    ],
    memoryCapture: overrides.memoryCapture || null,
    progress: overrides.progress || null,
    taskContinuation: overrides.taskContinuation || null,
    taskType: overrides.taskType,
    blockedReason: overrides.blockedReason || null,
    error: overrides.error || null,
    updatedAt: overrides.updatedAt || '2026-03-30T10:00:00.000Z',
    toolTrace: overrides.toolTrace || [
      {
        id: 't-1',
        kind: 'result',
        text: '[阶段] 步骤 1/2 抓取内容：已读取 10 条文章',
        timestamp: new Date('2026-03-30T10:00:00.000Z')
      },
      {
        id: 't-2',
        kind: 'call',
        text: 'rss.fetch()',
        timestamp: new Date('2026-03-30T10:00:01.000Z')
      },
      {
        id: 't-3',
        kind: 'result',
        text: '已生成摘要草稿',
        timestamp: new Date('2026-03-30T10:00:02.000Z')
      }
    ]
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
          {
            memoryId: 'mem-1',
            category: 'summary',
            sourceType: 'scope_memory',
            title: '本次摘要',
            summary: '完成 RSS 摘要整理'
          }
        ]
      }
    })
    const vm = buildTaskCardViewModel(run, createDefaultTaskDisclosureState(run))

    assert.strictEqual(vm.sections.memory.expanded, true)
    assert.strictEqual(vm.sections.memory.count, 1)
  })

  it('supports disclosure overrides for a specific section', () => {
    const run = createRun()
    const disclosure = setTaskDisclosureExpanded(
      createDefaultTaskDisclosureState(run),
      'details',
      true
    )
    const vm = buildTaskCardViewModel(run, disclosure)

    assert.strictEqual(vm.sections.details.expanded, true)
    assert.strictEqual(vm.detailGroups.length, 1)
  })

  it('groups similar active background tasks into a parent entry', () => {
    const grouped = groupTaskRunsForDisplay(
      [
        createRun({
          scopeId: 'scope-1',
          taskTitle: '技能执行 · lets-go-rss',
          updatedAt: '2026-03-30T10:00:00.000Z'
        }),
        createRun({
          scopeId: 'scope-2',
          taskTitle: '技能执行 · lets-go-rss',
          updatedAt: '2026-03-30T10:01:00.000Z'
        }),
        createRun({
          scopeId: 'scope-3',
          taskTitle: '浏览器任务',
          updatedAt: '2026-03-30T10:05:00.000Z'
        })
      ],
      new Date('2026-03-30T10:01:30.000Z')
    )

    assert.strictEqual(grouped.length, 2)
    const parent = grouped.find((item) => item.kind === 'group')
    assert.ok(parent)
    assert.strictEqual(parent?.children.length, 2)
    assert.match(parent?.summary || '', /2 个子任务/)
  })

  it('keys same-scope background child runs by child-run identity', () => {
    const first = createRun({
      scopeId: 'scope-1',
      taskId: 'skill-child:child-a',
      taskTitle: '后台技能任务 · video-expert-analyzer',
      waitingFor: 'background',
      taskContinuation: {
        taskId: 'skill-child:child-a',
        childRunId: 'child-a',
        blockerType: 'background_running',
      },
      updatedAt: '2026-03-30T09:00:00.000Z',
    })
    const second = createRun({
      scopeId: 'scope-1',
      taskId: 'skill-child:child-b',
      taskTitle: '后台技能任务 · video-expert-analyzer',
      waitingFor: 'background',
      taskContinuation: {
        taskId: 'skill-child:child-b',
        childRunId: 'child-b',
        blockerType: 'background_running',
      },
      updatedAt: '2026-03-30T09:01:00.000Z',
    })

    const entries = groupTaskRunsForDisplay(
      [first, second],
      new Date('2026-03-30T10:10:00.000Z'),
    )

    assert.deepStrictEqual(
      entries.map((entry) => entry.kind === 'task' ? entry.key : entry.key).sort(),
      ['child-run:child-a', 'child-run:child-b'],
    )
    assert.strictEqual(buildTaskCardViewModel(first, createDefaultTaskDisclosureState(first)).key, 'child-run:child-a')
    assert.strictEqual(getTaskRunDisplayKey(second), 'child-run:child-b')
  })

  it('labels continuation only from real resume identities, not old output directories', () => {
    const directoryOnly = createRun({
      taskType: 'continuation',
      taskContinuation: {
        taskId: 'legacy-output-dir',
        outputDir: '/tmp/ready/outputs/video-expert-analyzer/old',
        runStatePath: '/tmp/ready/outputs/video-expert-analyzer/old/run_state.json',
      },
    })
    const childResume = createRun({
      taskType: 'continuation',
      taskId: 'skill-child:child-resume',
      taskContinuation: {
        taskId: 'skill-child:child-resume',
        childRunId: 'child-resume',
        outputDir: '/tmp/ready/outputs/video-expert-analyzer/child-resume',
        runStatePath: '/tmp/ready/outputs/video-expert-analyzer/child-resume/run_state.json',
      },
    })

    assert.strictEqual(getTaskStartModeLabel(directoryOnly), '新任务')
    assert.strictEqual(getTaskStartModeLabel(childResume), '继续任务')
  })

  it('formats progress detail before totals and recent activity', () => {
    const label = formatTaskProgressLabel(
      {
        stage: 'score_batches',
        completed: 12,
        total: 30,
        coverage: null,
        overallCoverage: 0.42,
        fingerprint: 'fp-1',
        updatedAt: '2026-05-04T10:00:00.000Z',
        lastError: null,
        detail: '正在分析第 12 个片段',
        activityUpdatedAt: '2026-05-04T09:58:30.000Z',
        activityStale: false,
      },
      new Date('2026-05-04T10:00:00.000Z'),
    )

    assert.strictEqual(label, '正在分析第 12 个片段 · 12/30 · 总进度 42% · 最近更新 1 分钟前')
  })

  it('renders VEA audiovisual handoff blockers as user-facing continuation guidance', () => {
    const rawBlocker = '[qqyXmFYIdUo] 视听剖析子任务 `body` 待 agent 处理；请读取并完成 `audiovisual_handoff/body/task.md` 后重新运行 finalize。'
    const run = createRun({
      phase: 'checkpoint',
      status: 'blocked',
      taskTitle: '后台技能任务 · video-expert-analyzer',
      taskSummary: rawBlocker,
      blockedReason: rawBlocker,
      waitingFor: 'clarification',
      resumableActions: ['continue', 'cancel'],
      currentStepId: 'finalize',
      steps: [
        { id: 'finalize', title: 'finalize', status: 'blocked', updatedAt: '2026-05-04T10:00:00.000Z' },
      ],
      progress: {
        stage: 'finalize',
        completed: 19,
        total: 19,
        coverage: 1,
        overallCoverage: 0.98,
        fingerprint: 'fp-handoff',
        updatedAt: '2026-05-04T10:00:00.000Z',
        lastError: rawBlocker,
        activityUpdatedAt: '2026-05-04T09:46:00.000Z',
      },
    })

    const vm = buildTaskCardViewModel(run, createDefaultTaskDisclosureState(run))
    const progressLabel = formatTaskProgressLabel(run.progress, new Date('2026-05-04T10:00:00.000Z'))

    assert.strictEqual(vm.statusLabel, '等待继续')
    assert.strictEqual(vm.summary, '视听报告正文还需要继续生成。点击“继续处理”即可，系统会接上剩余步骤。')
    assert.strictEqual(vm.sections.overview.summary, vm.summary)
    assert.strictEqual(vm.currentStep?.title, '生成视听报告')
    assert.strictEqual(vm.sections.plan.summary, '当前：生成视听报告')
    assert.strictEqual(progressLabel, '生成视听报告 · 19/19 · 总进度 98% · 最近更新 14 分钟前')
    assert.strictEqual(formatTaskStepDisplayTitle('score_batches'), 'AI 评分')
    assert.strictEqual(isInternalAgentHandoffTask(run), true)
    assert.ok(!formatTaskUserFacingText(rawBlocker).includes('audiovisual_handoff'))
    assert.ok(!formatTaskUserFacingText(rawBlocker).includes('task.md'))
  })

  it('uses structured handoff progress instead of parsing raw internal paths', () => {
    const run = createRun({
      phase: 'checkpoint',
      status: 'blocked',
      taskTitle: '后台技能任务 · video-expert-analyzer',
      taskSummary: '内部状态占位',
      blockedReason: '内部状态占位',
      waitingFor: 'background',
      resumableActions: ['continue', 'cancel'],
      currentStepId: 'finalize',
      steps: [
        { id: 'finalize', title: 'finalize', status: 'blocked', updatedAt: '2026-05-04T10:00:00.000Z' },
      ],
      progress: {
        stage: 'finalize',
        completed: 19,
        total: 19,
        coverage: 1,
        overallCoverage: 0.98,
        fingerprint: 'fp-structured-handoff',
        updatedAt: '2026-05-04T10:00:00.000Z',
        lastError: null,
        activityUpdatedAt: '2026-05-04T09:46:00.000Z',
        handoff: {
          status: 'pending_retry',
          kind: 'audiovisual_report',
          taskName: 'body',
          userMessage: '视听报告正文生成超时，可继续重试。',
          actionLabel: '继续生成报告',
          attemptCount: 2,
          lastErrorKind: 'handoff_timeout',
          lastErrorMessage: '报告生成超时，可继续重试',
          taskPath: '/tmp/output/audiovisual_handoff/body/task.md',
          outputPath: '/tmp/output/audiovisual_handoff/body/output.md',
          updatedAt: '2026-05-04T10:00:00.000Z',
        },
      } as TaskCardRunLike['progress'],
    })

    const vm = buildTaskCardViewModel(run, createDefaultTaskDisclosureState(run))
    const progressLabel = formatTaskProgressLabel(run.progress, new Date('2026-05-04T10:00:00.000Z'))

    assert.strictEqual(vm.statusLabel, '后台运行中')
    assert.strictEqual(vm.summary, '视听报告正文生成超时，可继续重试。')
    assert.strictEqual(vm.currentStep?.title, '生成视听报告')
    assert.strictEqual(progressLabel, '生成视听报告 · 19/19 · 总进度 98% · 最近更新 14 分钟前')
    assert.strictEqual(isInternalAgentHandoffTask(run), true)
    assert.ok(!vm.summary.includes('audiovisual_handoff'))
  })
})
