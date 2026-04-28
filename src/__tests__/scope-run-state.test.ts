import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  deriveScopeRunStatePatch,
  isActiveScopePhase,
  isStreamingScopeRunState,
  mergeArtifacts,
  phaseToToolTraceStatus
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
          createdAt: '2026-03-07T00:00:00.000Z'
        }
      ],
      [
        {
          id: 'a2',
          module: 'document',
          kind: 'document-save',
          label: 'draft copy',
          path: '/tmp/draft.md',
          createdAt: '2026-03-07T00:00:01.000Z'
        },
        {
          id: 'a3',
          module: 'rss',
          kind: 'rss-report',
          label: 'report.md',
          path: '/tmp/report.md',
          createdAt: '2026-03-07T00:00:02.000Z'
        }
      ]
    )

    assert.strictEqual(merged.length, 2)
    assert.deepStrictEqual(
      merged.map((item) => item.path),
      ['/tmp/draft.md', '/tmp/report.md']
    )
  })

  it('turns human_required payloads into takeover state with checkpoint metadata', () => {
    const originalDateNow = Date.now
    Date.now = () => 1_700_000_000_000

    try {
      const patch = deriveScopeRunStatePatch(
        {
          phase: 'tool_running',
          module: 'browser',
          intent: 'browser_ask_user_takeover',
          controllerId: 'controller-1',
          ownerTabId: 'tab-9',
          timestamp: '2026-03-07T00:00:00.000Z',
          toolEvent: {
            kind: 'result',
            timestamp: '2026-03-07T00:00:00.000Z',
            text: JSON.stringify({
              phase: 'human_required',
              call_to_action: '请检查登录状态',
              details: '页面出现验证码',
              timeout_sec: 30
            })
          }
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
          stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null }
        }
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

  it('does not treat detached skill jobs as chat streaming', () => {
    assert.strictEqual(isStreamingScopeRunState({
      scopeId: 'scope-1',
      agent: 'assistant',
      requestId: 'dst-1',
      taskId: 'detached:dst-1',
      phase: 'tool_running',
      module: 'skill',
      executionKind: 'job',
      toolTrace: [],
      startedAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    }), false)
    assert.strictEqual(isStreamingScopeRunState({
      scopeId: 'scope-1',
      agent: 'assistant',
      requestId: 'run-1',
      phase: 'tool_running',
      module: 'skill',
      toolTrace: [],
      startedAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    }), true)
  })

  it('reads document pipeline diagnostics from structured scope run events', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-04-16T10:00:00.000Z',
        latestText: '已完成文档重点提炼 · 共 12 段，使用 4 段 · 章节切分',
        executionDiagnostics: {
          pipeline: {
            document: {
              phase: 'building_insight',
              chunkCount: 12,
              selectedChunkCount: 4,
              cacheHit: false,
              usedSectionAnchors: true,
            },
          },
        },
      },
      null,
    )

    assert.strictEqual(patch.executionDiagnostics?.pipeline?.document?.phase, 'building_insight')
    assert.strictEqual(patch.executionDiagnostics?.pipeline?.document?.chunkCount, 12)
    assert.strictEqual(patch.executionDiagnostics?.pipeline?.document?.selectedChunkCount, 4)
    assert.strictEqual(patch.executionDiagnostics?.pipeline?.document?.usedSectionAnchors, true)
  })

  it('clears a stale blocker when a structured event sends blockedReason null', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-04-28T01:00:00.000Z',
        blockedReason: null,
        waitingFor: 'none',
        resumableActions: ['cancel'],
      },
      {
        scopeId: 'scope-skill-clear-blocker',
        agent: 'assistant',
        requestId: 'run-clear-blocker',
        phase: 'checkpoint',
        toolTrace: [],
        startedAt: '2026-04-28T00:59:00.000Z',
        updatedAt: '2026-04-28T00:59:00.000Z',
        blockedReason: '预算耗尽但后台任务仍在运行',
        waitingFor: 'background',
        resumableActions: ['continue', 'cancel'],
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
      },
    )

    assert.strictEqual(patch.blockedReason, null)
    assert.strictEqual(patch.waitingFor, 'none')
  })

  it('preserves background task continuation resume handles from structured events', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'checkpoint',
        module: 'skill',
        timestamp: '2026-04-28T01:30:00.000Z',
        waitingFor: 'background',
        resumableActions: ['continue', 'retry', 'cancel'],
        taskContinuation: {
          taskId: 'str-1',
          taskRunId: 'str-1',
          detachedTaskId: 'dst-1',
          jobId: 'job-1',
          outputDir: '/tmp/ready/output',
          runStatePath: '/tmp/ready/output/run_state.json',
          pauseReason: 'budget_exhausted',
          progressFingerprint: 'fp-1',
        },
      },
      null,
    )

    assert.strictEqual(patch.waitingFor, 'background')
    assert.deepStrictEqual(patch.resumableActions, ['continue', 'retry', 'cancel'])
    assert.deepStrictEqual(patch.taskContinuation, {
      taskId: 'str-1',
      taskRunId: 'str-1',
      detachedTaskId: 'dst-1',
      jobId: 'job-1',
      outputDir: '/tmp/ready/output',
      runStatePath: '/tmp/ready/output/run_state.json',
      pauseReason: 'budget_exhausted',
      progressFingerprint: 'fp-1',
    })
  })

  it('does not derive browser workflow task metadata from legacy text-only events', () => {
    const planningPatch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-03-30T10:00:00.000Z',
        toolEvent: {
          kind: 'result',
          timestamp: '2026-03-30T10:00:00.000Z',
          text: '[计划] 目标：在目标页面上传素材并提交任务\n[计划] 顺序：resolve_target_page -> resolve_attachment -> ensure_upload -> final_reconcile'
        }
      },
      null
    )

    assert.strictEqual(planningPatch.taskTitle, null)
    assert.deepStrictEqual(planningPatch.steps, [])

    const stagePatch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-03-30T10:00:05.000Z',
        toolEvent: {
          kind: 'result',
          timestamp: '2026-03-30T10:00:05.000Z',
          text: '[阶段] 步骤 3/4 上传附件：页面已出现上传卡片'
        }
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
          {
            id: 'resolve_target_page',
            title: '确认目标页',
            status: 'pending',
            updatedAt: '2026-03-30T10:00:00.000Z'
          },
          {
            id: 'resolve_attachment',
            title: '确认附件',
            status: 'pending',
            updatedAt: '2026-03-30T10:00:00.000Z'
          },
          {
            id: 'ensure_upload',
            title: '上传附件',
            status: 'pending',
            updatedAt: '2026-03-30T10:00:00.000Z'
          },
          {
            id: 'final_reconcile',
            title: '结果复核',
            status: 'pending',
            updatedAt: '2026-03-30T10:00:00.000Z'
          }
        ],
        currentStepId: null,
        waitingFor: 'none',
        resumableActions: ['cancel'],
        recentArtifacts: [],
        memoryCapture: null
      }
    )

    assert.strictEqual(stagePatch.currentStepId, null)
    assert.strictEqual(stagePatch.taskSummary, null)
    assert.deepStrictEqual(stagePatch.steps?.map((item) => item.status), ['pending', 'pending', 'pending', 'pending'])
  })

  it('does not derive skill workflow task metadata from legacy text-only events', () => {
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
          'Recent artifacts: /tmp/storyboard.md'
        ].join('\n'),
        timestamp: '2026-03-30T10:10:00.000Z'
      },
      null
    )

    assert.strictEqual(patch.taskTitle, null)
    assert.strictEqual(patch.currentStepId, null)
    assert.strictEqual(patch.waitingFor, 'none')
    assert.deepStrictEqual(patch.resumableActions, [])
    assert.strictEqual(patch.taskContinuation, null)
    assert.deepStrictEqual(patch.steps, [])
  })

  it('prefers structured browser task fields from the scope run event over text parsing', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-04-08T12:00:00.000Z',
        taskTitle: '使用当前附件完成网页任务',
        taskSummary: '上传附件：页面已出现上传卡片',
        currentStepId: 'ensure_prompt',
        waitingFor: 'none',
        resumableActions: ['cancel'],
        steps: [
          {
            id: 'resolve_target_page',
            title: '确认目标页',
            status: 'done',
            updatedAt: '2026-04-08T12:00:00.000Z'
          },
          {
            id: 'resolve_attachment',
            title: '确认附件',
            status: 'done',
            updatedAt: '2026-04-08T12:00:00.000Z'
          },
          {
            id: 'ensure_upload',
            title: '上传附件',
            status: 'done',
            updatedAt: '2026-04-08T12:00:00.000Z'
          },
          {
            id: 'ensure_prompt',
            title: '填写提示词',
            status: 'running',
            updatedAt: '2026-04-08T12:00:00.000Z'
          }
        ],
        toolEvent: {
          kind: 'result',
          timestamp: '2026-04-08T12:00:00.000Z',
          text: '上传附件阶段已完成'
        }
      },
      null
    )

    assert.strictEqual(patch.taskTitle, '使用当前附件完成网页任务')
    assert.strictEqual(patch.taskSummary, '上传附件：页面已出现上传卡片')
    assert.strictEqual(patch.currentStepId, 'ensure_prompt')
    assert.deepStrictEqual(
      patch.steps?.map((item) => ({ id: item.id, status: item.status })),
      [
        { id: 'resolve_target_page', status: 'done' },
        { id: 'resolve_attachment', status: 'done' },
        { id: 'ensure_upload', status: 'done' },
        { id: 'ensure_prompt', status: 'running' }
      ]
    )
  })

  it('uses structured document task fields from scope run events', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-04-09T10:20:00.000Z',
        module: 'document',
        latestText: '已完成：章节改写',
        taskTitle: '章节改写',
        taskSummary: '已完成：第一部分',
        steps: [
          {
            id: 'execute',
            title: '章节改写',
            status: 'done',
            updatedAt: '2026-04-09T10:20:00.000Z'
          }
        ],
        currentStepId: 'execute',
        waitingFor: 'none',
        resumableActions: ['cancel'],
      },
      null
    )

    assert.strictEqual(patch.module, 'document')
    assert.strictEqual(patch.taskTitle, '章节改写')
    assert.strictEqual(patch.taskSummary, '已完成：第一部分')
    assert.strictEqual(patch.currentStepId, 'execute')
    assert.deepStrictEqual(
      patch.steps?.map((item) => item.status),
      ['done']
    )
  })

  it('uses structured design task fields from scope run events', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-04-09T10:25:00.000Z',
        module: 'design',
        latestText: '主版式已生成',
        taskTitle: '设计任务',
        taskSummary: '主版式已生成',
        steps: [
          {
            id: 'execute',
            title: '设计任务',
            status: 'done',
            updatedAt: '2026-04-09T10:25:00.000Z'
          }
        ],
        currentStepId: 'execute',
        waitingFor: 'none',
        resumableActions: ['cancel'],
      },
      null
    )

    assert.strictEqual(patch.module, 'design')
    assert.strictEqual(patch.taskTitle, '设计任务')
    assert.strictEqual(patch.taskSummary, '主版式已生成')
    assert.deepStrictEqual(
      patch.steps?.map((item) => item.status),
      ['done']
    )
  })

  it('keeps clarification blockers when a final event arrives as done', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'done',
        timestamp: '2026-04-26T10:00:00.000Z',
        taskSummary: '等待补充参数',
        waitingFor: 'clarification',
        blockedReason: '需要选择输出格式',
        resumableActions: ['continue', 'cancel'],
        steps: [
          {
            id: 'collect_input',
            title: '收集参数',
            status: 'blocked',
            updatedAt: '2026-04-26T09:59:00.000Z',
          },
        ],
      },
      null,
    )

    assert.strictEqual(patch.phase, 'done')
    assert.strictEqual(patch.waitingFor, 'clarification')
    assert.strictEqual(patch.blockedReason, '需要选择输出格式')
    assert.deepStrictEqual(patch.resumableActions, ['continue', 'cancel'])
    assert.deepStrictEqual(patch.steps?.map((item) => item.status), ['blocked'])
  })

  it('clears a previous blocker when structured event explicitly sends blockedReason null', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-04-28T01:00:00.000Z',
        waitingFor: 'none',
        blockedReason: null,
        resumableActions: ['cancel'],
      },
      {
        scopeId: 'scope-clear-blocker',
        agent: 'butler',
        requestId: 'run-clear-blocker',
        phase: 'checkpoint',
        toolTrace: [],
        startedAt: '2026-04-28T00:59:00.000Z',
        updatedAt: '2026-04-28T00:59:00.000Z',
        blockedReason: '旧阻塞原因',
        waitingFor: 'clarification',
        resumableActions: ['continue', 'cancel'],
      } as any,
    )

    assert.strictEqual(patch.blockedReason, null)
    assert.strictEqual(patch.waitingFor, 'none')
    assert.deepStrictEqual(patch.resumableActions, ['cancel'])
  })

  it('preserves execution diagnostics without overriding structured task summary', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'planning',
        latestText: '压缩后的 prompt 预览',
        taskTitle: '浏览器上传流程',
        taskSummary: '准备开始浏览器上传流程',
        executionDiagnostics: {
          compression: {
            historyCompressed: true,
            toolTraceCompressed: false,
            artifactSummaryUsed: false
          },
          budget: {
            maxIterations: 24,
            maxToolCalls: 24,
            maxParallelToolGroups: 1
          }
        },
        timestamp: '2026-04-10T01:00:00.000Z'
      },
      null
    )

    assert.strictEqual(patch.taskSummary, '准备开始浏览器上传流程')
    assert.strictEqual(patch.executionDiagnostics?.compression?.historyCompressed, true)
    assert.strictEqual(patch.executionDiagnostics?.budget?.maxToolCalls, 24)
  })

  it('accepts typed memory refs and keeps session recall separate from resident memory', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        timestamp: '2026-04-13T10:00:00.000Z',
        memoryRefs: [
          {
            id: 'resident-1',
            layer: 'l0',
            sourceType: 'resident_agent',
            title: '项目约定',
            loadedAt: '2026-04-13T10:00:00.000Z'
          },
          {
            id: 'recall-1',
            layer: 'recall',
            sourceType: 'session_recall',
            title: '旧会话品牌复盘',
            loadedAt: '2026-04-13T10:00:00.000Z'
          }
        ],
        latestText: '继续执行'
      },
      null
    )

    assert.deepStrictEqual(
      patch.memoryRefs?.map((item) => ({
        id: item.id,
        layer: item.layer,
        sourceType: item.sourceType
      })),
      [
        { id: 'resident-1', layer: 'l0', sourceType: 'resident_agent' },
        { id: 'recall-1', layer: 'recall', sourceType: 'session_recall' }
      ]
    )
  })
})
