import assert from 'node:assert/strict'
import test from 'node:test'

import type { FileEmergenceEvidence } from '../shared/file-emergence'
import {
  chooseBucket,
  scoreProject,
  startOfLocalDay,
} from '../main/modules/file-emergence/scoring'

const now = new Date('2026-06-08T10:00:00+08:00').getTime()
const day = 24 * 60 * 60 * 1000

const evidence: FileEmergenceEvidence[] = [
  { source: 'file_activity', label: '北岸夜跑', score: 0.8, timestamp: now },
  { source: 'calendar', label: '北岸夜跑筹备会', score: 0.7, timestamp: now },
]

test('today bucket wins when a project also has future evidence', () => {
  const result = scoreProject({
    anchorType: 'directory',
    hasLinkedFiles: true,
    evidence,
    now,
    lastOpenOrSaveAt: startOfLocalDay(now) + 9 * 60 * 60 * 1000,
    upcomingCalendarAt: now + 3 * day,
    todayActivityScore: 0.8,
    recentActivityScore: 0.7,
  })

  assert.equal(result.assignedBucket, 'today')
  assert.equal(result.visible, true)
})

test('future bucket qualifies from upcoming calendar without comparing raw scores across buckets', () => {
  const result = scoreProject({
    anchorType: 'semantic',
    hasLinkedFiles: true,
    evidence: [{ source: 'calendar', label: '新品发布会', score: 1, timestamp: now + 5 * day }],
    now,
    upcomingCalendarAt: now + 5 * day,
    agentIntentScore: 0.4,
  })

  assert.equal(result.assignedBucket, 'future')
  assert.ok(result.assignedScore > 0)
})

test('past bucket is for recently active projects with completion intent', () => {
  const result = scoreProject({
    anchorType: 'directory',
    hasLinkedFiles: true,
    evidence: [
      { source: 'agent', label: '项目复盘', score: 0.8, timestamp: now - 2 * day },
      { source: 'file_activity', label: '交付文件', score: 0.7, timestamp: now - 2 * day },
    ],
    now,
    lastOpenOrSaveAt: now - 2 * day,
    recentActivityScore: 0.7,
    completionIntentScore: 0.8,
  })

  assert.equal(result.assignedBucket, 'past')
  assert.equal(result.visible, true)
})

test('distant requires dormant activity and historical importance', () => {
  const result = scoreProject({
    anchorType: 'directory',
    hasLinkedFiles: true,
    evidence: [
      { source: 'file_activity', label: '品牌资产库', score: 0.8, timestamp: now - 180 * day },
      { source: 'agent', label: '品牌资产库', score: 0.6, timestamp: now - 120 * day },
    ],
    now,
    lastOpenOrSaveAt: now - 120 * day,
    historicalImportanceScore: 0.72,
    fileClusterStrength: 0.8,
  })

  assert.equal(result.assignedBucket, 'distant')
  assert.equal(result.visible, true)
})

test('distant rejects dormant but low-importance projects', () => {
  const result = scoreProject({
    anchorType: 'directory',
    hasLinkedFiles: true,
    evidence: [{ source: 'file_activity', label: '临时资料', score: 0.2, timestamp: now - 100 * day }],
    now,
    lastOpenOrSaveAt: now - 100 * day,
    historicalImportanceScore: 0.2,
    fileClusterStrength: 0.1,
  })

  assert.equal(result.assignedBucket, null)
  assert.equal(result.visible, false)
})

test('distant rejects projects opened or saved in the last 30 days', () => {
  const result = scoreProject({
    anchorType: 'directory',
    hasLinkedFiles: true,
    evidence,
    now,
    lastOpenOrSaveAt: now - 3 * day,
    historicalImportanceScore: 0.95,
    fileClusterStrength: 0.9,
  })

  assert.notEqual(result.assignedBucket, 'distant')
})

test('low confidence projects are kept out of the visible list', () => {
  const result = scoreProject({
    anchorType: 'semantic',
    hasLinkedFiles: false,
    evidence: [{ source: 'browser_history', label: '资料', score: 0.1, timestamp: now }],
    now,
    browserIntentScore: 0.1,
  })

  assert.equal(result.confidence, null)
  assert.equal(result.visible, false)
})

test('bucket priority is deterministic', () => {
  const assigned = chooseBucket([
    { bucket: 'distant', score: 0.9, status: 'dormant_important' },
    { bucket: 'future', score: 0.3, status: 'upcoming' },
    { bucket: 'today', score: 0.2, status: 'active' },
  ])

  assert.equal(assigned?.bucket, 'today')
})

test('reading sessions can qualify a book for today without save events', () => {
  const result = scoreProject({
    anchorType: 'document',
    hasLinkedFiles: true,
    evidence: [{ source: 'reading_session', label: '今天阅读 20 分钟', score: 0.8, timestamp: now }],
    now,
    readingContinuityScore: 0.72,
    readingDaysSinceLastRead: 0,
    readingProgressRatio: 0.45,
    todayReadingMinutes: 20,
    recentReadingMinutes: 110,
  })

  assert.equal(result.assignedBucket, 'today')
  assert.equal(result.visible, true)
})

test('high progress with a short reading pause qualifies as future continuation', () => {
  const result = scoreProject({
    anchorType: 'document',
    hasLinkedFiles: true,
    evidence: [{ source: 'reading_session', label: '最近读了很多，已停 3 天', score: 0.7, timestamp: now - 3 * day }],
    now,
    readingContinuityScore: 0.66,
    readingDaysSinceLastRead: 3,
    readingProgressRatio: 0.62,
    recentReadingMinutes: 300,
  })

  assert.equal(result.assignedBucket, 'future')
  assert.equal(result.bucketScores.find((score) => score.bucket === 'future')?.status, 'continuation')
  assert.equal(result.visible, true)
})

test('old open activity alone does not become today', () => {
  const result = scoreProject({
    anchorType: 'directory',
    hasLinkedFiles: true,
    evidence: [{ source: 'file_activity', label: '淘金小镇', score: 1, timestamp: now - 30 * day }],
    now,
    lastOpenOrSaveAt: now - 30 * day,
    todayActivityScore: 0,
    recentActivityScore: 0,
    historicalImportanceScore: 0.2,
  })

  assert.notEqual(result.assignedBucket, 'today')
})

test('emergence-source open is too weak to create today by itself', () => {
  const result = scoreProject({
    anchorType: 'directory',
    hasLinkedFiles: true,
    evidence: [{ source: 'file_activity', label: '旧项目', score: 0.15, timestamp: now }],
    now,
    lastOpenOrSaveAt: now,
    todayActivityScore: 0.015,
    recentActivityScore: 0.02,
  })

  assert.equal(result.assignedBucket, null)
  assert.equal(result.visible, false)
})
