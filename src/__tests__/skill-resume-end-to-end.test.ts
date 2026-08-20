import { after, before, describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  rememberLastReferenceSkill,
  snapshotLastReferenceSkill,
  restoreLastReferenceSkill,
  getLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
  _peekLastReferenceSkillForTests,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import {
  collectRecentAssistantSkillToolUses,
  buildSkillDetectionInputs,
  isRetryOnlyTurn,
} from '../main/modules/agent-control/skills/skill-detection-inputs'
import { recoverLatestSkillRunFromTaskProjections } from '../main/modules/agent-control/skills/skill-run-recovery'
import {
  __reloadSessionContinuityFromDiskForTests,
  __resetSessionContinuityForTests,
  __setSessionContinuityStoragePathForTests,
  getLatestSkillRun,
  rememberSkillRun,
} from '../main/modules/agent-control/session/session-continuity'
import {
  clearSkillTaskProjection,
  recordSkillTaskEvent,
  readSkillTaskProjection,
} from '../main/modules/agent-control/skills/skill-task-tracker'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import { shouldExposeSkillAction } from '../main/modules/tools/skills-tools'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

before(() => {
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
  })
})
after(() => __setScopeContextEpochDatabaseForTests(null))

const SKILL_TURN_IDENTITY_PATH = new URL('../main/modules/agent-control/skills/skill-turn-identity.ts', import.meta.url)

// skill-resume F1 — narrative integration test that walks the full chain a
// resume bug walked in production:
//
// (1) User on conv-X did video-expert work — `skill_video_expert_pipeline`
//     was called, reference hint was armed.
// (2) User killed Ready (in-memory hint Map vanishes).
// (3) User re-opened, picked the same conv, and typed "继续之前任务".
// (4) Without these fixes: hint=null, primitive tools hidden, internal-vis
//     `skill_video_expert_pipeline` still hidden, agent saw only RSS skills
//     and looped through them.
//
// This test asserts each link in the chain produces what the next link needs.

describe('skill-resume end-to-end (F1)', () => {
  beforeEach(() => {
    _resetLastReferenceSkillHintsForTests()
  })

  it('persistence link: snapshot before kill → restore after restart preserves hint+TTL', () => {
    const sessionId = 'conv-aipf10'
    rememberLastReferenceSkill(sessionId, { id: 'video-expert-analyzer', name: 'video-expert-analyzer' })
    const live = getLastReferenceSkill(sessionId)
    assert.ok(live, 'live hint exists')

    // (kill) snapshot to "DB"
    const persisted = snapshotLastReferenceSkill(sessionId)
    assert.ok(persisted, 'snapshot succeeded')
    assert.equal(persisted!.id, 'video-expert-analyzer')

    // (restart) clear in-memory state
    _resetLastReferenceSkillHintsForTests()
    assert.equal(getLastReferenceSkill(sessionId), null, 'hint gone after restart')

    // (resume) replay from "DB"
    const restored = restoreLastReferenceSkill(sessionId, persisted)
    assert.equal(restored, true)
    const peek = _peekLastReferenceSkillForTests(sessionId)
    assert.ok(peek)
    assert.equal(peek!.at, persisted!.at, 'restore preserved original `at` before active reads bump TTL')
    const post = getLastReferenceSkill(sessionId)
    assert.ok(post)
    assert.equal(post!.id, 'video-expert-analyzer')
    assert.ok(post!.at >= persisted!.at, 'active read keeps the restored hint fresh')
  })

  it('lookback link: bare "继续" probes prior assistant tool_use for skill_*', () => {
    const userInput = '继续上次'
    assert.equal(isRetryOnlyTurn(userInput), true, 'detected as retry-only turn')

    const messages = [
      { role: 'user', content: '帮我分析视频' },
      { role: 'assistant', content: [
        { type: 'text', text: 'starting' },
        { type: 'tool_use', id: 't1', name: 'skill_video_expert_pipeline', input: {} },
      ] },
      { role: 'user', content: userInput },
    ]
    // exclude current input (last)
    const previousAssistantSkillToolUses = collectRecentAssistantSkillToolUses(
      messages.slice(0, -1) as Array<{ role?: string; content?: unknown }>,
    )
    assert.deepEqual(previousAssistantSkillToolUses, ['skill_video_expert_pipeline'])

    const inputs = buildSkillDetectionInputs({
      contextualUserInput: userInput,
      primaryInstruction: userInput,
      pureUserText: userInput,
      previousPureUserInputs: ['帮我分析视频'],
      previousAssistantSkillToolUses,
    })
    assert.ok(
      inputs.includes('skill_video_expert_pipeline'),
      'lookback fed the prior skill name into detection batch',
    )
  })

  it('lookback link: config repair turns probe prior assistant tool_use for skill_*', () => {
    const userInput = '模型换成 mimo-v2.5 再试一次'
    assert.equal(isRetryOnlyTurn(userInput), false, 'not a bare retry-only turn')

    const previousAssistantSkillToolUses = ['skill_video_expert_pipeline']
    const inputs = buildSkillDetectionInputs({
      contextualUserInput: userInput,
      primaryInstruction: userInput,
      pureUserText: userInput,
      previousPureUserInputs: ['帮我分析视频'],
      previousAssistantSkillToolUses,
    })

    assert.ok(
      inputs.includes('skill_video_expert_pipeline'),
      'config repair turn fed the prior skill name into detection batch',
    )
  })

  it('history link: retry can recover a persisted latest skill run when hint and messages are gone', () => {
    const storagePath = join(tmpdir(), `ready-session-continuity-${Date.now()}-${Math.random()}.json`)
    __setSessionContinuityStoragePathForTests(storagePath)
    __resetSessionContinuityForTests()
    try {
      rememberSkillRun('conv-vea', {
        toolName: 'skill_video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        action: 'video_expert_pipeline',
        success: false,
        summary: 'Skill install failed for video-expert-analyzer',
      })
      __reloadSessionContinuityFromDiskForTests()
      const latest = getLatestSkillRun('conv-vea')
      assert.equal(latest?.skillId, 'video-expert-analyzer')
      assert.equal(latest?.success, false)

      const skillTurnIdentitySource = readFileSync(SKILL_TURN_IDENTITY_PATH, 'utf8')
      assert.match(skillTurnIdentitySource, /getLatestSkillRun\(\s*ctx\.sessionId\s*\)/)
      assert.match(skillTurnIdentitySource, /reference_skill_rearmed_from_skill_history/)

      // 该合同随引擎退役（P6f dormant 边界 + Phase C C4，2026-07-05）：direct-chat.ts
      // 已删除，"引擎把 resolveRecentSkillTaskRun 接到 skill-task-tracker 的
      // resolveRecentSkillRunFromTaskRuns / getLatestRecoverableSkillTaskRun"的
      // 源钉随之摘除（该钉在本分支 HEAD 即已失配）。缺位注记：SDK live 路径当前
      // 没有任何 provider 给 skill-turn-identity 的可选依赖 resolveRecentSkillTaskRun
      // 注入 task-run DB 兜底（durable task-run 恢复链路处于 built-but-dark），
      // 现役恢复仅靠 session-continuity（上方行为断言）与 task projection 链路；
      // 待 SDK 侧接线补齐后应恢复对应行为合同。
    } finally {
      __resetSessionContinuityForTests()
      __setSessionContinuityStoragePathForTests(null)
      rmSync(storagePath, { force: true })
    }
  })

  it('task projection link: retry can recover the last skill when the continuity file is empty', () => {
    const projections: TaskProjectionRecord[] = [
      {
        taskId: 'task-system',
        scopeId: 'conv-vea',
        runId: 'run-system',
        taskType: 'short_task',
        module: 'system',
        taskTitle: '正在理解需求',
        taskSummary: '正在整理任务边界、上下文与可用能力',
        status: 'done',
        interactionState: 'running',
        steps: [],
        currentStepId: null,
        budget: null,
        budgetUsagePercent: 0,
        budgetWarningLevel: 'none',
        recoveryHistory: [],
        degradationReason: null,
        blockedReason: null,
        resumableActions: [],
        continuationRef: null,
        recentArtifacts: [],
        createdAt: '2026-04-27T06:57:11.000Z',
        updatedAt: '2026-04-27T06:57:14.000Z',
      },
      {
        taskId: 'task-skill',
        scopeId: 'conv-vea',
        runId: 'run-skill',
        taskType: 'short_task',
        module: 'skill',
        taskTitle: '技能执行 · Video Expert Analyzer (VNext)',
        taskSummary: '执行技能脚本',
        status: 'done',
        interactionState: 'running',
        steps: [],
        currentStepId: null,
        budget: null,
        budgetUsagePercent: 0,
        budgetWarningLevel: 'none',
        recoveryHistory: [],
        degradationReason: null,
        blockedReason: null,
        resumableActions: [],
        continuationRef: null,
        recentArtifacts: [],
        createdAt: '2026-04-26T16:11:08.000Z',
        updatedAt: '2026-04-26T16:13:01.000Z',
      },
    ]

    const recovered = recoverLatestSkillRunFromTaskProjections({
      projections,
      skills: [
        {
          id: 'video-expert-analyzer',
          name: 'Video Expert Analyzer',
          description: '视频分析',
          version: '1',
          installed: true,
          installStatePath: '',
          source: 'embedded',
          manifestValid: true,
          defaultAction: 'read_skill',
          executionMode: 'advisory',
          actions: [
            { name: 'read_skill', description: 'read docs', runtime: 'reference', entry: 'SKILL.md', visibility: 'internal', params: [] },
            { name: 'video_expert_pipeline', description: 'run pipeline', runtime: 'python', entry: 'scripts/ready_compat.py', visibility: 'internal', params: [] },
          ],
        },
      ],
      resolveSkillToolByAction: (skillId, actionName) => ({
        name: `${skillId}:${actionName}`,
      }),
    })

    assert.equal(recovered?.skillId, 'video-expert-analyzer')
    assert.equal(recovered?.action, 'read_skill')
    assert.match(recovered?.summary || '', /Video Expert Analyzer/)
  })

  it('task projection link: failed/blocked skill projections beat newer done projections', () => {
    const baseProjection = {
      scopeId: 'conv-vea',
      runId: 'run',
      taskType: 'short_task' as const,
      module: 'skill',
      interactionState: 'running' as const,
      steps: [],
      currentStepId: null,
      budget: null,
      budgetUsagePercent: 0,
      budgetWarningLevel: 'none' as const,
      recoveryHistory: [],
      degradationReason: null,
      resumableActions: [],
      continuationRef: null,
      recentArtifacts: [],
      createdAt: '2026-04-27T06:57:11.000Z',
    }
    const projections: TaskProjectionRecord[] = [
      {
        ...baseProjection,
        taskId: 'task-done',
        taskTitle: '技能执行 · Done Skill',
        taskSummary: 'done summary',
        status: 'done',
        blockedReason: null,
        updatedAt: '2026-04-27T08:00:00.000Z',
      },
      {
        ...baseProjection,
        taskId: 'task-failed',
        taskTitle: '技能执行 · Video Expert Analyzer',
        taskSummary: '上次目标：分析视频并输出分镜',
        status: 'failed',
        blockedReason: 'API key invalid',
        recentArtifacts: [{ path: '/tmp/vea-output', label: 'output dir', kind: 'directory' }],
        updatedAt: '2026-04-27T07:00:00.000Z',
      },
    ]

    const recovered = recoverLatestSkillRunFromTaskProjections({
      projections,
      skills: [
        {
          id: 'video-expert-analyzer',
          name: 'Video Expert Analyzer',
          description: '视频分析',
          version: '1',
          installed: true,
          installStatePath: '',
          source: 'embedded',
          manifestValid: true,
          defaultAction: 'read_skill',
          executionMode: 'advisory',
          actions: [
            { name: 'read_skill', description: 'read docs', runtime: 'reference', entry: 'SKILL.md', visibility: 'internal', params: [] },
            { name: 'video_expert_pipeline', description: 'run pipeline', runtime: 'python', entry: 'scripts/ready_compat.py', visibility: 'internal', params: [] },
          ],
        },
      ],
    })

    assert.equal(recovered?.skillId, 'video-expert-analyzer')
    assert.equal(recovered?.success, false)
    assert.match(recovered?.summary || '', /API key invalid/)
    assert.match(recovered?.summary || '', /\/tmp\/vea-output/)
  })

  it('exposure link: when hint armed, expose_when_hint_armed action becomes visible', () => {
    // hint-armed for unrelated skill: video-expert action stays internal
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'lets-go-rss',
        exposeWhenHintArmed: ['video_expert_pipeline', 'video_expert_ai_analyze'],
      }),
      false,
      'hint armed for a different skill does not unlock this skill\'s internal actions',
    )

    // hint-armed for video-expert AND action listed: visible
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'video-expert-analyzer',
        exposeWhenHintArmed: ['video_expert_pipeline', 'video_expert_ai_analyze'],
      }),
      true,
      'matching hint + whitelisted action → exposed',
    )

    // hint-armed but action NOT listed: stays hidden
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'some_other_action',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: 'video-expert-analyzer',
        exposeWhenHintArmed: ['video_expert_pipeline'],
      }),
      false,
      'matching hint but action not whitelisted → hidden',
    )

    // no hint: internal stays hidden
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'internal',
        actionName: 'video_expert_pipeline',
        skillId: 'video-expert-analyzer',
        referenceHintSkillId: null,
        exposeWhenHintArmed: ['video_expert_pipeline'],
      }),
      false,
      'no hint armed → internal stays hidden even when whitelisted',
    )

    // public action: always exposed regardless of hint
    assert.equal(
      shouldExposeSkillAction({
        actionVisibility: 'public',
        actionName: 'rss_add',
        skillId: 'lets-go-rss',
        referenceHintSkillId: null,
        exposeWhenHintArmed: [],
      }),
      true,
      'public action stays public regardless of hint state',
    )
  })

  it('regression: a fresh "继续" turn (no prior video tool use) does NOT inherit unrelated skill names', () => {
    const userInput = '继续'
    const messages = [
      { role: 'user', content: 'add an RSS feed' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'skill_lets_go_rss_rss_add', input: {} },
      ] },
      { role: 'user', content: userInput },
    ]
    const previousAssistantSkillToolUses = collectRecentAssistantSkillToolUses(
      messages.slice(0, -1) as Array<{ role?: string; content?: unknown }>,
    )
    assert.deepEqual(previousAssistantSkillToolUses, ['skill_lets_go_rss_rss_add'])

    const inputs = buildSkillDetectionInputs({
      contextualUserInput: userInput,
      previousAssistantSkillToolUses,
    })
    assert.ok(inputs.includes('skill_lets_go_rss_rss_add'),
      'lookback correctly attributes to the actual prior skill, not a hardcoded one')
    assert.ok(!inputs.includes('skill_video_expert_pipeline'),
      'no leakage from other tests/sessions')
  })

})
