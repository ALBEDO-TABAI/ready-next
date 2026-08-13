/**
 * 梯队三 — emergence feed 组装通道行为测试。
 *
 * 提取器语义已由 emergence-card-extractors.test.ts / emergence-remaining-
 * cards.test.ts 覆盖；此处测 group 层：信号三路注入、scopeId 富化（任务类
 * 卡带宿主 scope、已退役的知识候选不再进入 feed）、feed 控制生效、handler 响应形状与
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

test('assembles follow_up cards with their host scopeId and does not expose retired resume actions', () => {
  const entries = assembleFeedEntries({
    ...EMPTY_DEPS,
    listRecentProjections: () => [
      projection({ taskId: 'task-1', scopeId: 'scope-1', status: 'blocked', canResume: true, taskTitle: '写周报' }),
      projection({ taskId: 'task-2', scopeId: 'scope-2', status: 'completed', interactionState: 'check_in_pending', taskTitle: '采集小红书' }),
    ],
  })

  const followUp = entries.find((entry) => entry.card.type === 'follow_up')
  assert.ok(followUp, 'check_in_pending projects a follow_up card')
  assert.equal(followUp?.scopeId, 'scope-2')
  assert.equal(followUp?.card.action.kind, 'adjudicate_task')
  assert.equal(entries.some((entry) => entry.card.action.ref === 'task-1'), false)
})

test('retired personality and generic knowledge candidates never enter the live feed', () => {
  const entries = assembleFeedEntries({
    ...EMPTY_DEPS,
    listCrystallizeSignals: () => [
      { relPath: 'knowledge/aspire-1.md', title: '常在深夜写长文', tag: 'aspire', status: 'staged', source: null },
    ],
    listCandidateSignals: () => [
      { relPath: 'knowledge/agent-candidate-video.md', title: '视频剪辑请求', stage: 'candidate', evidenceDates: ['2026-06-30', '2026-07-01', '2026-07-02'] },
    ],
  })

  assert.equal(entries.length, 0)
})

test('blocked historical projections do not create a public resume card', () => {
  const entries = assembleFeedEntries({
    ...EMPTY_DEPS,
    listRecentProjections: () => [
      projection({ taskId: 'task-new', scopeId: 'scope-new', status: 'recoverable_paused', canResume: true, taskTitle: '浏览器逐张点开采集' }),
      projection({ taskId: 'task-old', scopeId: 'scope-old', status: 'recoverable_paused', canResume: true, taskTitle: '浏览器逐张点开采集' }),
    ],
  })
  assert.equal(entries.length, 0)
})

test('feed controls apply: per-type cap and confidence ordering survive the group layer', () => {
  const projections = Array.from({ length: 6 }, (_, index) =>
    projection({ taskId: `task-${index}`, scopeId: `scope-${index}`, status: 'completed', interactionState: 'check_in_pending', taskTitle: `任务 ${index}` }))
  const entries = assembleFeedEntries({ ...EMPTY_DEPS, listRecentProjections: () => projections })
  const followUpCount = entries.filter((entry) => entry.card.type === 'follow_up').length
  assert.equal(followUpCount, 3, 'per-type limit (3) applies through assembleEmergenceFeed')
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
      projection({ taskId: 'task-9', scopeId: 'scope-9', status: 'completed', interactionState: 'check_in_pending' }),
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

test('production file intent cards enter the agent feed with shared projectKey and project-level dedupe', () => {
  const entries=assembleFeedEntries(EMPTY_DEPS,[
    {id:'prepare:a',projectKey:'project-a',type:'prepare',title:'发布计划',confidence:.8,action:{kind:'open_project',ref:'project-a'},evidence:[{fact:'五天后发布'}]},
    {id:'prepare:a-duplicate',projectKey:'project-a',type:'prepare',title:'另一个名称',confidence:.7,action:{kind:'open_project',ref:'project-a'},evidence:[{fact:'同一项目'}]},
    {id:'forming:b',projectKey:'project-b',type:'forming',title:'案例库',confidence:.75,action:{kind:'open_project_group',ref:'project-b'},evidence:[{fact:'3 个文件'}]},
    {id:'harvest:c',projectKey:'project-c',type:'harvest',title:'交付物',confidence:.7,action:{kind:'open_artifact',ref:'/workspace/done.md'},evidence:[{fact:'产物已落盘'}]},
  ])
  assert.equal(entries.filter((entry)=>entry.card.type==='prepare').length,1)
  assert.deepEqual(entries.filter((entry)=>['prepare','forming','harvest'].includes(entry.card.type)).map((entry)=>entry.card.projectKey).sort(),['project-a','project-b','project-c'])
})
