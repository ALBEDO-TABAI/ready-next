/**
 * P1 fix (2026-07-03, live regression) — test 4 root cause: a fresh, distinct
 * browser action ("把这条视频下载到X") issued after a paused/continuable
 * collection task must NOT be swept into the skill-continuation tool surface.
 * Before the fix, resolveSkillHintRelevanceForTurn returned continuable_task
 * unconditionally whenever a reference hint + continuable task existed, which
 * narrowed the surface to 12 skill/collection tools and stripped
 * browser_download / browser_eval / resolve_video — the
 * agent then reported it "lacked the tools" and the download failed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveSkillHintRelevanceForTurn } from '../main/modules/agent-control/runtime-core/agent-sdk-utils'
import type { SkillContextOrchestratorLike } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import type { FollowupTaskRef } from '../../shared/agent-followup-intent'

const orchestratorWithHint: SkillContextOrchestratorLike = {
  findExplicitlyRequestedSkills: () => [],
  peekCurrentReferenceSkillHint: () => ({ id: 'obsidian-web-clip', name: 'obsidian-web-clip' }),
}

const continuableCollection: FollowupTaskRef = {
  taskId: 'task-collect-1',
  status: 'blocked',
  interactionState: 'suspended',
  summary: '采集小红书图片（已暂停）',
}

function relevance(text: string, taskRefs: FollowupTaskRef[]) {
  return resolveSkillHintRelevanceForTurn({
    message: text as never,
    sessionId: 'scope-1',
    orchestrator: orchestratorWithHint,
    localSendImIntent: false,
    taskRefs,
  })
}

test('fresh distinct action after a continuable task → NOT relevant (full browser surface, not skill continuation)', () => {
  const decision = relevance('把这条视频下载到本地', [continuableCollection])
  assert.equal(decision.relevant, false)
  assert.equal(decision.reason, 'unrelated_turn')
})

test('a continuable projection alone cannot authorize skill context from operation wording', () => {
  const decision = relevance('跑 finalize', [continuableCollection])
  assert.equal(decision.relevant, false)
  assert.equal(decision.reason, 'unrelated_turn')
})

test('genuine resume via continuationIntent stays relevant regardless of text shape', () => {
  const decision = resolveSkillHintRelevanceForTurn({
    message: '把这条视频下载到本地' as never,
    sessionId: 'scope-1',
    orchestrator: orchestratorWithHint,
    localSendImIntent: false,
    continuationIntent: { kind: 'continue_task', taskId: 'task-collect-1' } as never,
    taskRefs: [continuableCollection],
  })
  assert.equal(decision.relevant, true)
  assert.equal(decision.reason, 'continuation')
})

test('no continuable task + fresh action → not relevant (baseline unchanged)', () => {
  const decision = relevance('把这条视频下载到本地', [])
  assert.equal(decision.relevant, false)
})
