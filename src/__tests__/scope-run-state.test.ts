import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  deriveScopeRunStatePatch,
  isActiveScopePhase,
  mergeArtifacts,
  phaseToToolTraceStatus,
} from '../renderer/modules/agent/scopeRunState'

describe('scope run state helpers', () => {
  it('deduplicates artifacts by path and keeps unique entries', () => {
    const merged = mergeArtifacts(
      [
        {
          id: 'a1',
          module: 'document',
          kind: 'document-save',
          label: 'draft.md',
          path: '/tmp/draft.md',
          createdAt: '2026-03-07T00:00:00.000Z',
        },
      ],
      [
        {
          id: 'a2',
          module: 'document',
          kind: 'document-save',
          label: 'draft copy',
          path: '/tmp/draft.md',
          createdAt: '2026-03-07T00:00:01.000Z',
        },
        {
          id: 'a3',
          module: 'rss',
          kind: 'rss-report',
          label: 'report.md',
          path: '/tmp/report.md',
          createdAt: '2026-03-07T00:00:02.000Z',
        },
      ],
    )

    assert.strictEqual(merged.length, 2)
    assert.deepStrictEqual(
      merged.map((item) => item.path),
      ['/tmp/draft.md', '/tmp/report.md'],
    )
  })

  it('turns human_required payloads into takeover state with checkpoint metadata', () => {
    const originalDateNow = Date.now
    Date.now = () => 1_700_000_000_000

    try {
      const patch = deriveScopeRunStatePatch(
        {
          phase: 'tool_running',
          timestamp: '2026-03-07T00:00:00.000Z',
          toolEvent: {
            kind: 'result',
            timestamp: '2026-03-07T00:00:00.000Z',
            text: JSON.stringify({
              phase: 'human_required',
              module: 'browser',
              intent: 'browser_ask_user_takeover',
              call_to_action: '请检查登录状态',
              details: '页面出现验证码',
              timeout_sec: 30,
              controllerId: 'controller-1',
              ownerTabId: 'tab-9',
            }),
          },
        },
        {
          scopeId: 'scope-1',
          agent: 'butler',
          requestId: 'run-1',
          phase: 'tool_running',
          toolTrace: [],
          startedAt: '2026-03-07T00:00:00.000Z',
          updatedAt: '2026-03-07T00:00:00.000Z',
          artifactRefs: [],
          checkpointExpiresAt: null,
          responseBuffer: '',
          stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
        },
      )

      assert.strictEqual(patch.phase, 'takeover')
      assert.strictEqual(patch.module, 'browser')
      assert.strictEqual(patch.intent, 'browser_ask_user_takeover')
      assert.strictEqual(patch.blockedReason, '请检查登录状态 · 页面出现验证码')
      assert.strictEqual(patch.controllerId, 'controller-1')
      assert.strictEqual(patch.ownerTabId, 'tab-9')
      assert.strictEqual(patch.checkpointExpiresAt, 1_700_000_030_000)
    } finally {
      Date.now = originalDateNow
    }
  })

  it('marks active phases consistently for alias sync', () => {
    assert.strictEqual(isActiveScopePhase('tool_running'), true)
    assert.strictEqual(isActiveScopePhase('responding'), true)
    assert.strictEqual(isActiveScopePhase('done'), false)
    assert.strictEqual(phaseToToolTraceStatus('checkpoint'), 'running')
    assert.strictEqual(phaseToToolTraceStatus('cancelled'), 'cancelled')
  })

  it('derives browser workflow task metadata from plan and stage tool events', () => {
    const planningPatch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-03-30T10:00:00.000Z',
        toolEvent: {
          kind: 'result',
          timestamp: '2026-03-30T10:00:00.000Z',
          text: '[计划] 目标：在目标页面上传素材并提交任务\n[计划] 顺序：resolve_target_page -> resolve_attachment -> ensure_upload -> final_reconcile',
        },
      },
      null,
    )

    assert.strictEqual(planningPatch.taskTitle, '在目标页面上传素材并提交任务')
    assert.deepStrictEqual(
      planningPatch.steps?.map((item) => ({ id: item.id, status: item.status })),
      [
        { id: 'resolve_target_page', status: 'pending' },
        { id: 'resolve_attachment', status: 'pending' },
        { id: 'ensure_upload', status: 'pending' },
        { id: 'final_reconcile', status: 'pending' },
      ],
    )

    const stagePatch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-03-30T10:00:05.000Z',
        toolEvent: {
          kind: 'result',
          timestamp: '2026-03-30T10:00:05.000Z',
          text: '[阶段] 步骤 3/4 上传附件：页面已出现上传卡片',
        },
      },
      {
        scopeId: 'scope-browser-1',
        agent: 'butler',
        requestId: 'run-browser-1',
        phase: 'tool_running',
        toolTrace: [],
        startedAt: '2026-03-30T10:00:00.000Z',
        updatedAt: '2026-03-30T10:00:00.000Z',
        latestText: null,
        module: 'browser',
        intent: 'browser_workflow',
        executionKind: 'interactive',
        jobId: null,
        artifactRefs: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: null,
        ownerResourceId: null,
        lastEvidenceAt: null,
        blockedReason: null,
        controllerId: null,
        ownerTabId: null,
        checkpointExpiresAt: null,
        responseMessageId: null,
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
        error: null,
        designPhase: null,
        designTodo: [],
        designReviewSummary: null,
        ownedNodeIds: [],
        repairScope: null,
        scenePlanId: null,
        boardId: null,
        styleSystem: null,
        reviewFailures: [],
        lastAcceptedScreenshot: null,
        taskTitle: '在目标页面上传素材并提交任务',
        taskSummary: '准备开始浏览器任务',
        steps: [
          { id: 'resolve_target_page', title: '确认目标页', status: 'pending', updatedAt: '2026-03-30T10:00:00.000Z' },
          { id: 'resolve_attachment', title: '确认附件', status: 'pending', updatedAt: '2026-03-30T10:00:00.000Z' },
          { id: 'ensure_upload', title: '上传附件', status: 'pending', updatedAt: '2026-03-30T10:00:00.000Z' },
          { id: 'final_reconcile', title: '结果复核', status: 'pending', updatedAt: '2026-03-30T10:00:00.000Z' },
        ],
        currentStepId: null,
        waitingFor: 'none',
        resumableActions: ['cancel'],
        recentArtifacts: [],
        memoryCapture: null,
      },
    )

    assert.strictEqual(stagePatch.currentStepId, 'ensure_upload')
    assert.strictEqual(stagePatch.taskSummary, '上传附件：页面已出现上传卡片')
    assert.deepStrictEqual(
      stagePatch.steps?.map((item) => ({ id: item.id, status: item.status })),
      [
        { id: 'resolve_target_page', status: 'done' },
        { id: 'resolve_attachment', status: 'done' },
        { id: 'ensure_upload', status: 'running' },
        { id: 'final_reconcile', status: 'pending' },
      ],
    )
  })

  it('parses skill execution details into resumable workflow task metadata', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        latestText: [
          'Execution ID: exec-1',
          'Skill: video-copy-analyzer',
          'Status: waiting',
          'Current step: collect_input',
          'Blocker: need_input - 请选择视频风格',
          'Recent steps: prepare(done), collect_input(waiting)',
          'Recent artifacts: /tmp/storyboard.md',
        ].join('\n'),
        timestamp: '2026-03-30T10:10:00.000Z',
      },
      null,
    )

    assert.strictEqual(patch.taskTitle, '技能执行 · video-copy-analyzer')
    assert.strictEqual(patch.currentStepId, 'collect_input')
    assert.strictEqual(patch.waitingFor, 'input')
    assert.deepStrictEqual(patch.resumableActions, ['continue', 'open_artifact', 'cancel'])
    assert.strictEqual(patch.taskContinuation?.executionId, 'exec-1')
    assert.strictEqual(patch.taskContinuation?.stepId, 'collect_input')
    assert.deepStrictEqual(
      patch.steps?.map((item) => ({ id: item.id, status: item.status })),
      [
        { id: 'prepare', status: 'done' },
        { id: 'collect_input', status: 'blocked' },
      ],
    )
  })
})
