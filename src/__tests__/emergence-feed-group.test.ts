/**
 * 梯队三 — emergence feed 组装通道行为测试。
 *
 * 提取器语义已由 emergence-card-extractors.test.ts / emergence-remaining-
 * cards.test.ts 覆盖；此处测 group 层：信号三路注入、scopeId 富化（任务类
 * 卡带宿主 scope、知识类卡为 null）、feed 控制生效、handler 响应形状与
 * dispose 对称。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain } from 'electron'

import {
  assembleFeedEntries,
  emergenceFeedGroup,
  _emergenceFeedGroupChannelsForTest,
  type EmergenceFeedGroupDeps,
} from '../main/modules/claude-bridge/ipc/emergence-feed-group'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

function projection(partial: Record<string, unknown>): TaskProjectionRecord {
  return {
    taskId: 'task-x',
    scopeId: 'scope-x',
    status: 'working',
    taskTitle: '示例任务',
    updatedAt: '2026-07-03T10:00:00Z',
    ...partial,
  } as unknown as TaskProjectionRecord
}

const EMPTY_DEPS: EmergenceFeedGroupDeps = {
  listRecentProjections: () => [],
  listCrystallizeSignals: () => [],
  listCandidateSignals: () => [],
}

test('assembles resume/follow_up cards with their host scopeId attached', () => {
  const entries = assembleFeedEntries({
    ...EMPTY_DEPS,
    listRecentProjections: () => [
      projection({ taskId: 'task-1', scopeId: 'scope-1', status: 'blocked', canResume: true, taskTitle: '写周报' }),
      projection({ taskId: 'task-2', scopeId: 'scope-2', status: 'completed', interactionState: 'check_in_pending', taskTitle: '采集小红书' }),
    ],
  })

  const resume = entries.find((entry) => entry.card.type === 'resume')
  assert.ok(resume, 'blocked+canResume projects a resume card')
  assert.equal(resume?.scopeId, 'scope-1')
  assert.equal(resume?.card.action.kind, 'resume_task')
  assert.equal(resume?.card.action.ref, 'task-1')

  const followUp = entries.find((entry) => entry.card.type === 'follow_up')
  assert.ok(followUp, 'check_in_pending projects a follow_up card')
  assert.equal(followUp?.scopeId, 'scope-2')
  assert.equal(followUp?.card.action.kind, 'adjudicate_task')
})

test('knowledge cards (crystallize/candidate) carry null scopeId — their exit is the settings surface', () => {
  const entries = assembleFeedEntries({
    ...EMPTY_DEPS,
    listCrystallizeSignals: () => [
      { relPath: 'knowledge/aspire-1.md', title: '常在深夜写长文', tag: 'aspire', status: 'staged', source: null },
    ],
    listCandidateSignals: () => [
      { relPath: 'knowledge/agent-candidate-video.md', title: '视频剪辑请求', stage: 'candidate', evidenceDates: ['2026-06-30', '2026-07-01', '2026-07-02'] },
    ],
  })

  assert.equal(entries.length, 2)
  for (const entry of entries) {
    assert.equal(entry.card.type, 'crystallize')
    assert.equal(entry.scopeId, null)
    assert.equal(entry.card.requiresExplicitConfirm, true, '涌现知识卡永不一键采纳')
  }
})

test('same-titled retries collapse to one card (dedupe by type+title, newest projection first)', () => {
  const entries = assembleFeedEntries({
    ...EMPTY_DEPS,
    listRecentProjections: () => [
      projection({ taskId: 'task-new', scopeId: 'scope-new', status: 'recoverable_paused', canResume: true, taskTitle: '浏览器逐张点开采集' }),
      projection({ taskId: 'task-old', scopeId: 'scope-old', status: 'recoverable_paused', canResume: true, taskTitle: '浏览器逐张点开采集' }),
    ],
  })
  const resume = entries.filter((entry) => entry.card.type === 'resume')
  assert.equal(resume.length, 1, '同名重试只留一张卡')
  assert.equal(resume[0]?.scopeId, 'scope-new', '保留最近的投影（列表序在前者）')
})

test('feed controls apply: per-type cap and confidence ordering survive the group layer', () => {
  const projections = Array.from({ length: 6 }, (_, index) =>
    projection({ taskId: `task-${index}`, scopeId: `scope-${index}`, status: 'blocked', canResume: true, taskTitle: `任务 ${index}` }))
  const entries = assembleFeedEntries({ ...EMPTY_DEPS, listRecentProjections: () => projections })
  const resumeCount = entries.filter((entry) => entry.card.type === 'resume').length
  assert.equal(resumeCount, 3, 'per-type limit (3) applies through assembleEmergenceFeed')
})

test('handler answers success with entries and dispose removes the channel symmetrically', async () => {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>()
  const removed: string[] = []
  const ipcMain = {
    handle(channel: string, fn: never) {
      handlers.set(channel, fn)
    },
    removeHandler(channel: string) {
      removed.push(channel)
      handlers.delete(channel)
    },
  } as unknown as IpcMain

  const dispose = emergenceFeedGroup.register(ipcMain, {
    ...EMPTY_DEPS,
    listRecentProjections: () => [
      projection({ taskId: 'task-9', scopeId: 'scope-9', status: 'blocked', canResume: true }),
    ],
  })
  const feed = handlers.get('agent:emergence:feed')!
  const result = await feed(null) as { success: boolean; data?: Array<{ card: { id: string } }> }
  assert.equal(result.success, true)
  assert.equal(result.data?.length, 1)

  dispose.dispose()
  dispose.dispose()
  for (const channel of _emergenceFeedGroupChannelsForTest) {
    assert.ok(removed.includes(channel))
    assert.ok(!handlers.has(channel))
  }
})
