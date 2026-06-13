import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assembleEmergenceFeed,
  buildHarvestIntentProjection,
  extractFormingCards,
  extractHarvestCards,
  extractPrepareCards,
} from '../main/modules/agent-control/emergence/emergence-cards'

test('prepare / harvest / forming extractors produce evidence and action exits', () => {
  const prepare = extractPrepareCards([{
    id: 'event-1',
    title: '周五发布会',
    startsAt: '2026-06-19T10:00:00.000Z',
    projectRef: 'project:launch',
    sourceDomain: 'calendar.local',
  }])
  assert.equal(prepare[0].type, 'prepare')
  assert.equal(prepare[0].action.kind, 'open_project')
  assert.ok(prepare[0].evidence.some((entry) => entry.ref === 'domain:calendar.local'))

  const harvest = extractHarvestCards([{
    id: 'task-1',
    title: '执行方案',
    completedAt: '2026-06-13T12:00:00.000Z',
    artifactRef: 'artifact:/safe/report.md',
    artifactLabel: 'report.md',
    openedAfterCompletion: false,
  }])
  assert.equal(harvest[0].type, 'harvest')
  assert.equal(harvest[0].action.kind, 'open_artifact')

  const forming = extractFormingCards([{
    id: 'cluster-1',
    title: '快闪店项目',
    fileRefs: ['file:a.md', 'file:b.md', 'file:c.md', 'file:d.md'],
    projectRef: 'project:popup',
  }])
  assert.equal(forming[0].type, 'forming')
  assert.equal(forming[0].action.kind, 'open_project_group')
  assert.equal(forming[0].evidence.filter((entry) => entry.fact === '文件聚类证据').length, 3)
})

test('remaining-card privacy and projection gates: protected paths are masked and no-exit cards are dropped', () => {
  const protectedHarvest = extractHarvestCards([{
    id: 'task-secret',
    title: '密钥整理',
    completedAt: '2026-06-13T12:00:00.000Z',
    artifactRef: 'artifact:secret',
    artifactLabel: '/Users/user/.ssh/id_rsa',
    openedAfterCompletion: false,
    protectedPath: true,
  }])
  assert.ok(protectedHarvest[0].title.includes('受保护路径'))
  assert.ok(!protectedHarvest[0].title.includes('.ssh'))
  assert.ok(!protectedHarvest[0].evidence.map((entry) => entry.fact).join('\n').includes('.ssh'))

  const inferredProtectedHarvest = extractHarvestCards([{
    id: 'task-env',
    title: '环境整理',
    completedAt: '2026-06-13T12:00:00.000Z',
    artifactRef: 'artifact:/Users/user/project/.env.local',
    artifactLabel: '/Users/user/project/.env.local',
    openedAfterCompletion: false,
  }])
  assert.ok(inferredProtectedHarvest[0].title.includes('受保护路径'))
  assert.ok(!inferredProtectedHarvest[0].title.includes('.env'))
  assert.ok(!inferredProtectedHarvest[0].evidence.map((entry) => entry.fact).join('\n').includes('.env'))

  const noExit = [
    ...extractPrepareCards([{ id: 'event-no-ref', title: '无项目', startsAt: '2026-06-19', projectRef: '' }]),
    ...extractHarvestCards([{ id: 'task-opened', title: '已看', completedAt: '2026-06-13', artifactRef: 'artifact:x', artifactLabel: 'x', openedAfterCompletion: true }]),
    ...extractFormingCards([{ id: 'cluster-empty', title: '空', fileRefs: [], projectRef: 'project:x' }]),
  ]
  assert.deepEqual(noExit, [])
})

test('feed controls apply to prepare / harvest / forming cards', () => {
  const cards = [
    ...extractPrepareCards(Array.from({ length: 4 }, (_, index) => ({
      id: `p${index}`,
      title: `准备 ${index}`,
      startsAt: '2026-06-19',
      projectRef: `project:p${index}`,
      confidence: 0.9 - index * 0.01,
    }))),
    ...extractHarvestCards(Array.from({ length: 4 }, (_, index) => ({
      id: `h${index}`,
      title: `产物 ${index}`,
      completedAt: '2026-06-13',
      artifactRef: `artifact:h${index}`,
      artifactLabel: `h${index}.md`,
      openedAfterCompletion: false,
      confidence: 0.8 - index * 0.01,
    }))),
    ...extractFormingCards(Array.from({ length: 4 }, (_, index) => ({
      id: `f${index}`,
      title: `项目 ${index}`,
      fileRefs: [`file:${index}`],
      projectRef: `project:f${index}`,
      confidence: 0.7 - index * 0.01,
    }))),
  ]
  const feed = assembleEmergenceFeed(cards, { globalLimit: 8, perTypeLimit: 3, confidenceFloor: 0.5 })
  assert.equal(feed.length, 8)
  assert.ok(feed.filter((card) => card.type === 'prepare').length <= 3)
  assert.ok(feed.filter((card) => card.type === 'harvest').length <= 3)
  assert.ok(feed.filter((card) => card.type === 'forming').length <= 3)
})

test('harvest intent projection is explicit but deferred until R-E2 unlocks', () => {
  const signals = Array.from({ length: 4 }, (_, index) => ({
    id: `h${index}`,
    title: `产物 ${index}`,
    completedAt: '2026-06-13',
    artifactRef: `artifact:h${index}`,
    artifactLabel: `h${index}.md`,
    openedAfterCompletion: false,
    confidence: 0.9 - index * 0.01,
  }))
  const deferred = buildHarvestIntentProjection(signals)
  assert.equal(deferred.blockedBy, 'R-E2')
  assert.equal(deferred.cards.length, 0)
  assert.equal(deferred.deferredCards.length, 3)
  assert.ok(deferred.deferredCards.every((card) => card.type === 'harvest'))

  const enabled = buildHarvestIntentProjection(signals, { intentFeedEnabled: true })
  assert.equal(enabled.blockedBy, null)
  assert.equal(enabled.deferredCards.length, 0)
  assert.equal(enabled.cards.length, 3)
})
