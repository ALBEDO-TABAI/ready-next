import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import type { SessionRecallCapsule } from '../shared/session-recall'

// skill-resume E2 — manually-attached recall capsules must inline into the
// prompt's bootstrap context with a recognizable [session-recall-context]
// marker AND include the latest tool/task summary, so the LLM can interpret
// "继续 / 接着 ..." against the prior conversation's last state.

function createScope() {
  return {
    id: 'scope-1',
    agent: 'main',
    title: 'test scope',
    sourceKind: 'local' as const,
    sourceId: 'app',
    threadKey: 'scope-1',
    metaJson: null,
    createdAt: '2026-04-25T00:00:00.000Z',
    updatedAt: '2026-04-25T00:00:00.000Z',
  }
}

function makeCapsule(overrides: Partial<SessionRecallCapsule> = {}): SessionRecallCapsule {
  return {
    conversationId: 'conv-prev-1',
    lineageRootId: 'conv-prev-1',
    resumeTitle: '视频分析任务',
    title: '视频分析任务',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'conv-prev-1',
    summary: '上次跑到 step 3 的 video_expert_pipeline，输出了 8 个素材片段',
    latestTaskTitle: '视频专家分析',
    latestTaskSummary: '已调用 skill_video_expert_pipeline，等待用户确认要不要进入剪辑阶段',
    attachmentNames: ['my-video.mp4'],
    updatedAt: '2026-04-24T22:00:00.000Z',
    ...overrides,
  }
}

describe('PromptAssemblyService — recall capsule inline (E2)', () => {
  it('injects [session-recall-context] marker so LLM identifies the section', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-e2-marker-'))
    mkdirSync(join(root, 'memory'), { recursive: true })
    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      getScopeSessionRecallCapsules: async () => [makeCapsule()],
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope() as never,
      message: '继续',
    })
    const joined = result.bootstrapMessages.join('\n\n')

    assert.match(joined, /\[session-recall-context\]/, 'marker present')
    assert.match(joined, /视频分析任务/, 'title present')
    rmSync(root, { recursive: true, force: true })
  })

  it('inlines latestTaskSummary so LLM sees what the prior session was waiting on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-e2-task-summary-'))
    mkdirSync(join(root, 'memory'), { recursive: true })
    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      getScopeSessionRecallCapsules: async () => [makeCapsule()],
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope() as never,
      message: '继续上次的视频分析',
    })
    const joined = result.bootstrapMessages.join('\n\n')

    assert.match(joined, /skill_video_expert_pipeline/, 'last tool call summary inlined')
    assert.match(joined, /等待用户确认/, 'last waiting state inlined')
  })

  it('header instructs LLM to use recall as continuation context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-e2-header-'))
    mkdirSync(join(root, 'memory'), { recursive: true })
    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      getScopeSessionRecallCapsules: async () => [makeCapsule()],
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope() as never,
      message: '继续',
    })
    const joined = result.bootstrapMessages.join('\n\n')

    assert.match(joined, /续做上下文/, 'header explains role')
    assert.match(joined, /继续\/接着/, 'header references the trigger words')
  })

  it('caps text at 4000 chars even when capsule summary is huge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ready-e2-cap-'))
    mkdirSync(join(root, 'memory'), { recursive: true })
    const giant = makeCapsule({ summary: 'X'.repeat(20_000) })
    const service = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      getScopeSessionRecallCapsules: async () => [giant],
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    const result = await service.buildForScopedRun({
      scope: createScope() as never,
      message: '继续',
    })
    const recallSection = result.bootstrapMessages.find((m) => m.includes('跨会话回看'))
    assert.ok(recallSection, 'recall section exists')
    // section title prefix "## 跨会话回看\n" adds ~12 chars on top of cap
    assert.ok(recallSection!.length < 4100, `recall section length ${recallSection!.length} should be near 4000 cap`)
  })
})
