import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  deriveScopeRunStatePatch,
  isForegroundBusyScopeRunState,
  isActiveScopePhase,
  isStreamingScopeRunState,
  mergeArtifacts,
  phaseToToolTraceStatus
} from '../renderer/modules/agent/scopeRunState'
import type { ScopeRunState } from '../renderer/modules/agent/types'

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
          intent: 'browser_request_takeover',
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
      assert.strictEqual(patch.intent, 'browser_request_takeover')
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
    assert.strictEqual(phaseToToolTraceStatus('checkpoint', 'blocked_config'), 'done')
    assert.strictEqual(phaseToToolTraceStatus('checkpoint', 'blocked_tool_error'), 'error')
    assert.strictEqual(phaseToToolTraceStatus('error', 'context_overflow'), 'error')
    assert.strictEqual(phaseToToolTraceStatus('cancelled'), 'cancelled')
    // P2: zero-proof gaps stay red; proof-bearing degraded completions use the
    // completed overlay shape instead of a false failure state.
    assert.strictEqual(phaseToToolTraceStatus('done', 'proof_gap'), 'error')
    assert.strictEqual(phaseToToolTraceStatus('done', 'adjudication_degraded'), 'done')
    assert.strictEqual(phaseToToolTraceStatus('error', 'adjudication_degraded'), 'error')
  })

  it('preserves context overflow as a terminal reason instead of downgrading to null', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'error',
        terminalReason: 'context_overflow',
        timestamp: '2026-03-07T00:00:00.000Z',
      },
      null
    )

    assert.strictEqual(patch.terminalReason, 'context_overflow')
  })

  it('treats manual suspend as a real terminal boundary while preserving takeover guidance', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'takeover',
        terminalReason: 'manual_suspend',
        waitingFor: 'confirmation',
        resumableActions: ['continue', 'cancel'],
        blockedReason: '请完成页面验证 · 完成后继续任务',
        timestamp: '2026-07-20T00:00:00.000Z',
      },
      null,
    )

    assert.strictEqual(patch.phase, 'takeover')
    assert.strictEqual(patch.terminalReason, 'manual_suspend')
    assert.strictEqual(patch.blockedReason, '请完成页面验证 · 完成后继续任务')
    assert.strictEqual(isForegroundBusyScopeRunState({
      scopeId: 'scope-1',
      agent: 'butler',
      requestId: 'run-1',
      phase: patch.phase!,
      terminalReason: patch.terminalReason,
      toolTrace: [],
      startedAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    }), false)
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

  it('does not treat terminal checkpoints as chat streaming', () => {
    const run = {
      scopeId: 'scope-1',
      agent: 'assistant',
      requestId: 'req-checkpoint',
      phase: 'checkpoint',
      terminalReason: 'checkpoint_budget',
      module: 'skill',
      waitingFor: 'background',
      toolTrace: [],
      startedAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:01.000Z',
    }
    assert.strictEqual(isStreamingScopeRunState(run as any), false)
  })

  it('releases the foreground lock for background and budget handoff states', () => {
    const base = {
      scopeId: 'scope-foreground-release',
      agent: 'assistant',
      requestId: 'run-foreground-release',
      phase: 'tool_running' as const,
      module: 'skill' as const,
      toolTrace: [],
      startedAt: '2026-05-04T00:00:00.000Z',
      updatedAt: '2026-05-04T00:00:01.000Z',
    }

    const releasedRuns = [
      {
        ...base,
        phase: 'checkpoint' as const,
        terminalReason: 'checkpoint_background' as const,
      },
      {
        ...base,
        phase: 'checkpoint' as const,
        terminalReason: 'checkpoint_budget' as const,
      },
      {
        ...base,
        waitingFor: 'background' as const,
      },
      {
        ...base,
        taskContinuation: { taskId: 'task-bg', blockerType: 'background_running' },
      },
      {
        ...base,
        taskContinuation: { taskId: 'task-budget', blockerType: 'budget_paused' },
      },
      {
        ...base,
        taskId: 'detached:dst-foreground-release',
        executionKind: 'job' as const,
      },
    ]

    for (const run of releasedRuns) {
      assert.strictEqual(isForegroundBusyScopeRunState(run), false)
      assert.strictEqual(isStreamingScopeRunState(run), false)
    }
  })

  it('keeps the foreground lock for active responding and tool-running turns', () => {
    for (const phase of ['responding', 'tool_running'] as const) {
      assert.strictEqual(isForegroundBusyScopeRunState({
        scopeId: `scope-${phase}`,
        agent: 'assistant',
        requestId: `run-${phase}`,
        phase,
        toolTrace: [],
        startedAt: '2026-05-04T00:00:00.000Z',
        updatedAt: '2026-05-04T00:00:01.000Z',
      }), true)
    }
  })

  it('does not let a child-run handle lock the foreground composer', () => {
    const run = {
      scopeId: 'scope-child-background',
      agent: 'assistant',
      requestId: 'run-child-background',
      phase: 'tool_running' as const,
      module: 'skill' as const,
      taskId: 'skill-child:child-bg-1',
      taskContinuation: {
        taskId: 'skill-child:child-bg-1',
        childRunId: 'child-bg-1',
      },
      toolTrace: [],
      startedAt: '2026-05-04T00:00:00.000Z',
      updatedAt: '2026-05-04T00:00:01.000Z',
    }

    assert.strictEqual(isForegroundBusyScopeRunState(run), false)
    assert.strictEqual(isStreamingScopeRunState(run), false)
  })

  it('treats any active phase with a terminal reason as non-streaming', () => {
    for (const phase of ['queued', 'planning', 'tool_running', 'checkpoint', 'takeover', 'resuming', 'responding'] as const) {
      assert.strictEqual(isStreamingScopeRunState({
        scopeId: `scope-${phase}`,
        agent: 'assistant',
        requestId: `run-${phase}`,
        phase,
        terminalReason: 'checkpoint_budget',
        toolTrace: [],
        startedAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:01.000Z',
      }), false, `${phase} with terminalReason must not stream`)
    }
  })

  it('preserves terminal reason from structured scope events', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'checkpoint',
        module: 'skill',
        terminalReason: 'checkpoint_budget',
        waitingFor: 'background',
        timestamp: '2026-04-29T00:00:00.000Z',
      } as any,
      null,
    )

    assert.strictEqual((patch as any).terminalReason, 'checkpoint_budget')
    assert.strictEqual(patch.phase, 'checkpoint')
    assert.strictEqual(patch.waitingFor, 'background')
  })

  it('preserves blocked external terminal reason from structured scope events', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'tool_running',
        module: 'skill',
        terminalReason: 'blocked_external',
        timestamp: '2026-05-03T00:00:00.000Z',
      } as any,
      null,
    )

    assert.strictEqual((patch as any).terminalReason, 'blocked_external')
    assert.strictEqual(isStreamingScopeRunState({
      scopeId: 'scope-blocked-external',
      agent: 'assistant',
      requestId: 'run-blocked-external',
      phase: patch.phase!,
      terminalReason: (patch as any).terminalReason,
      toolTrace: [],
      startedAt: '2026-05-03T00:00:00.000Z',
      updatedAt: '2026-05-03T00:00:01.000Z',
    }), false)
  })

  it('does not clear a terminal reason when a later same-run event omits it', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-checkpoint',
        phase: 'responding',
        latestText: '补充说明',
        timestamp: '2026-04-29T00:00:02.000Z',
      } as any,
      {
        scopeId: 'scope-checkpoint',
        agent: 'assistant',
        requestId: 'run-checkpoint',
        phase: 'checkpoint',
        terminalReason: 'checkpoint_budget',
        toolTrace: [],
        startedAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:01.000Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
      },
    )

    assert.strictEqual((patch as any).terminalReason, 'checkpoint_budget')
  })

  it('does clear a stale terminal reason when a new run starts in the same scope', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-new',
        phase: 'planning',
        timestamp: '2026-04-29T00:01:00.000Z',
      } as any,
      {
        scopeId: 'scope-checkpoint',
        agent: 'assistant',
        requestId: 'run-old',
        phase: 'checkpoint',
        terminalReason: 'checkpoint_budget',
        toolTrace: [],
        startedAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:01.000Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
      },
    )

    assert.strictEqual((patch as any).terminalReason, null)
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

  it('stores context usage from scope run events and preserves it during the next live run', () => {
    const contextUsage = {
      usedInputTokens: 239_000,
      windowTokens: 258_000,
      ratio: 239_000 / 258_000,
      windowSource: 'model' as const,
      source: 'last_model_request' as const,
      timestamp: '2026-06-27T00:00:00.000Z',
    }
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'done',
        runId: 'run-1',
        contextUsage,
        timestamp: '2026-06-27T00:00:00.000Z',
      },
      null,
    )

    assert.deepStrictEqual(patch.contextUsage, contextUsage)

    const nextPatch = deriveScopeRunStatePatch(
      {
        phase: 'planning',
        runId: 'run-2',
        timestamp: '2026-06-27T00:00:10.000Z',
      },
      {
        scopeId: 'scope-1',
        agent: 'butler',
        requestId: 'run-1',
        phase: 'done',
        toolTrace: [],
        startedAt: '2026-06-27T00:00:00.000Z',
        updatedAt: '2026-06-27T00:00:00.000Z',
        contextUsage,
      },
    )

    assert.deepStrictEqual(nextPatch.contextUsage, contextUsage)
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

  it('preserves skill activity progress detail from structured events', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'checkpoint',
        module: 'skill',
        timestamp: '2026-05-04T06:00:00.000Z',
        progress: {
          stage: 'score_batches',
          completed: 0,
          total: 39,
          coverage: 0,
          overallCoverage: 0.42,
          fingerprint: 'batch-fp-1',
          updatedAt: '2026-05-04T06:00:00.000Z',
          lastError: null,
          detail: '评分批次 2/7，约 12/39 场景',
          activityUpdatedAt: '2026-05-04T06:00:00.000Z',
        },
      },
      null,
    )

    assert.deepStrictEqual(patch.progress, {
      stage: 'score_batches',
      completed: 0,
      total: 39,
      coverage: 0,
      overallCoverage: 0.42,
      fingerprint: 'batch-fp-1',
      updatedAt: '2026-05-04T06:00:00.000Z',
      lastError: null,
      detail: '评分批次 2/7，约 12/39 场景',
      activityUpdatedAt: '2026-05-04T06:00:00.000Z',
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

  it('keeps clarification blockers as checkpoint when a final event arrives as done', () => {
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

    assert.strictEqual(patch.phase, 'checkpoint')
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

  it('parses budget lease diagnostics for task cards', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'checkpoint',
        taskTitle: '技能执行',
        taskSummary: '预算已暂停',
        waitingFor: 'background',
        blockedReason: '本轮预算已用完',
        executionDiagnostics: {
          budgetLease: {
            leaseId: 'sbl-1234',
            decision: 'pause',
            reason: 'unchanged_observation_repeated',
            renewalsUsed: 2,
            progressScore: 0,
            wasteScore: 4,
            lastFingerprint: 'fp-1',
            currentLeaseEndIteration: 60
          }
        },
        timestamp: '2026-04-28T01:00:00.000Z'
      },
      null
    )

    assert.strictEqual(patch.executionDiagnostics?.budgetLease?.leaseId, 'sbl-1234')
    assert.strictEqual(patch.executionDiagnostics?.budgetLease?.decision, 'pause')
    assert.strictEqual(patch.executionDiagnostics?.budgetLease?.reason, 'unchanged_observation_repeated')
    assert.strictEqual(patch.executionDiagnostics?.budgetLease?.currentLeaseEndIteration, 60)
  })

  it('normalizes done events with blockers back to checkpoint state', () => {
    const patch = deriveScopeRunStatePatch(
      {
        phase: 'done',
        taskTitle: '技能执行',
        taskSummary: '后台仍在运行',
        waitingFor: 'background',
        blockedReason: '后台仍在运行',
        resumableActions: ['continue', 'cancel'],
        taskContinuation: {
          taskId: 'task-skill',
          blockerType: 'background_running',
          detachedTaskId: 'dst-skill'
        },
        timestamp: '2026-04-28T01:00:00.000Z'
      },
      null
    )

    assert.strictEqual(patch.phase, 'checkpoint')
    assert.strictEqual(patch.blockedReason, '后台仍在运行')
    assert.strictEqual(patch.waitingFor, 'background')
    assert.strictEqual(patch.taskContinuation?.detachedTaskId, 'dst-skill')
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

  /**
   * Stage 3 W5 — probes for stale carry-forward after terminal phase
   * (same-run tail) and across new-run boundary. The reducer previously
   * preserved progress / waitingFor / resumableActions / steps via
   * `previous?.X || ...` chains, letting a finished or replaced run keep
   * "looking like it's still running" in the task card.
   */

  it('clears stale progress when a same-run event arrives after terminal done', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-tail',
        phase: 'done',
        timestamp: '2026-05-05T00:00:01.000Z'
      } as any,
      {
        scopeId: 'scope-tail',
        agent: 'assistant',
        requestId: 'run-tail',
        phase: 'done',
        terminalReason: 'completed',
        progress: { stage: 'finalize', detail: '剩余 3 项' },
        toolTrace: [],
        startedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:00.500Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null }
      }
    )
    assert.strictEqual(patch.progress, null)
  })

  it('clears stale waitingFor when a same-run event arrives after terminal cancelled', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-tail',
        phase: 'cancelled',
        timestamp: '2026-05-05T00:00:01.000Z'
      } as any,
      {
        scopeId: 'scope-tail',
        agent: 'assistant',
        requestId: 'run-tail',
        phase: 'cancelled',
        terminalReason: 'cancelled_user',
        waitingFor: 'user_input',
        toolTrace: [],
        startedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:00.500Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null }
      }
    )
    assert.strictEqual(patch.waitingFor, 'none')
  })

  it('clears stale progress when a new run starts in the same scope', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-new',
        phase: 'planning',
        timestamp: '2026-05-05T00:01:00.000Z'
      } as any,
      {
        scopeId: 'scope-tail',
        agent: 'assistant',
        requestId: 'run-old',
        phase: 'tool_running',
        progress: { stage: 'analyzing', detail: '12/30' },
        toolTrace: [],
        startedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:00.500Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null }
      }
    )
    assert.strictEqual(patch.progress, null)
  })

  it('does not inherit stale resumableActions on new-run', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-new',
        phase: 'planning',
        timestamp: '2026-05-05T00:01:00.000Z'
      } as any,
      {
        scopeId: 'scope-tail',
        agent: 'assistant',
        requestId: 'run-old',
        phase: 'checkpoint',
        resumableActions: ['continue', 'cancel'],
        toolTrace: [],
        startedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:00.500Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null }
      }
    )
    assert.deepStrictEqual(patch.resumableActions, [])
  })

  it('does not inherit stale blockedReason on new-run', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-new',
        phase: 'planning',
        timestamp: '2026-05-05T00:01:00.000Z'
      } as any,
      {
        scopeId: 'scope-tail',
        agent: 'assistant',
        requestId: 'run-old',
        phase: 'checkpoint',
        blockedReason: '等待用户继续',
        toolTrace: [],
        startedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:00.500Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null }
      }
    )
    assert.strictEqual(patch.blockedReason, null)
  })

  it('does not inherit stale currentStepId on new-run', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-new',
        phase: 'planning',
        timestamp: '2026-05-05T00:01:00.000Z'
      } as any,
      {
        scopeId: 'scope-tail',
        agent: 'assistant',
        requestId: 'run-old',
        phase: 'tool_running',
        currentStepId: 's1',
        toolTrace: [],
        startedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:00.500Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null }
      }
    )
    assert.strictEqual(patch.currentStepId, null)
  })

  it('preserves progress when same-run terminal tail event provides own progress', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-tail',
        phase: 'done',
        timestamp: '2026-05-05T00:00:01.000Z',
        progress: { stage: 'finalize', completed: 30, total: 30 }
      } as any,
      {
        scopeId: 'scope-tail',
        agent: 'assistant',
        requestId: 'run-tail',
        phase: 'done',
        terminalReason: 'completed',
        progress: { stage: 'old', completed: 12, total: 30 },
        toolTrace: [],
        startedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:00.500Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null }
      }
    )
    // Event-provided structured progress wins; clearing only fires when event omits it.
    assert.strictEqual(patch.progress?.stage, 'finalize')
    assert.strictEqual(patch.progress?.completed, 30)
  })

  it('preserves completed progress when a same-run final text tail arrives', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-tail',
        phase: 'done',
        timestamp: '2026-05-05T00:00:02.000Z'
      } as any,
      {
        scopeId: 'scope-tail',
        agent: 'assistant',
        requestId: 'run-tail',
        phase: 'done',
        terminalReason: 'completed',
        progress: { stage: 'completed', completed: 5, total: 5, detail: '报告已生成' },
        toolTrace: [],
        startedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:01.000Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null }
      }
    )

    assert.strictEqual(patch.progress?.stage, 'completed')
    assert.strictEqual(patch.progress?.completed, 5)
  })

  it('preserves taskContinuation across same-run terminal tail', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-tail',
        phase: 'done',
        timestamp: '2026-05-05T00:00:01.000Z'
      } as any,
      {
        scopeId: 'scope-tail',
        agent: 'assistant',
        requestId: 'run-tail',
        phase: 'done',
        terminalReason: 'completed',
        taskContinuation: {
          detachedTaskId: 'dst-skill',
          taskRunId: 'tr-1',
          jobId: null
        } as any,
        toolTrace: [],
        startedAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-05T00:00:00.500Z',
        responseBuffer: '',
        stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null }
      }
    )
    // taskContinuation is excluded from the W5 clear set; it persists across terminals.
    assert.strictEqual(patch.taskContinuation?.detachedTaskId, 'dst-skill')
  })

  it('clears taskContinuation and progress when a scope event explicitly sends null', () => {
    const previous: ScopeRunState = {
      scopeId: 'scope-clear',
      agent: 'assistant',
      requestId: 'run-clear',
      phase: 'tool_running',
      taskContinuation: {
        detachedTaskId: 'dst-clear',
        taskRunId: 'tr-clear',
      },
      progress: {
        stage: 'running',
        completed: 3,
        total: 5,
        coverage: 0.6,
        fingerprint: 'fp-running',
        updatedAt: '2026-05-05T00:00:00.500Z',
        lastError: null,
      },
      toolTrace: [],
      startedAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.500Z',
      responseBuffer: '',
      stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
    }
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-clear',
        phase: 'done',
        timestamp: '2026-05-05T00:00:01.000Z',
        taskContinuation: null,
        progress: null,
      } satisfies Parameters<typeof deriveScopeRunStatePatch>[0],
      previous,
    )

    assert.strictEqual(patch.taskContinuation, null)
    assert.strictEqual(patch.progress, null)
  })

  it('parses persisted progress carried inside taskContinuation', () => {
    const patch = deriveScopeRunStatePatch(
      {
        runId: 'run-progress-continuation',
        phase: 'done',
        timestamp: '2026-05-05T00:00:01.000Z',
        taskContinuation: {
          taskId: 'task-progress-continuation',
          blockerType: 'completed',
          progress: {
            stage: 'completed',
            completed: 64,
            total: 64,
            coverage: 1,
            fingerprint: 'fp-complete',
            updatedAt: '2026-05-05T00:00:01.000Z',
            lastError: null
          }
        }
      } as any,
      null
    )
    assert.strictEqual(patch.taskContinuation?.progress?.stage, 'completed')
    assert.strictEqual(patch.taskContinuation?.progress?.completed, 64)
  })
})
