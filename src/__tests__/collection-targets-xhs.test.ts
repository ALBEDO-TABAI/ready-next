import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessCollectionTargets,
  deriveCollectionTargets,
} from '../main/modules/browser-engine/collection-targets'
import type { BrowserStructuredItem } from '../main/modules/browser-engine/capability-types'

const sourceUrl = 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06'

function item(link: string, title = '今天的笔记', structure?: Record<string, unknown>): BrowserStructuredItem {
  return {
    sourceUrl,
    title,
    link,
    rawFields: structure ? { structure } : {},
  }
}

test('Xiaohongshu collection targets preserve token-bearing open URL and dedupe by note id', () => {
  const first = 'https://www.xiaohongshu.com/explore/665f5a23000000001e03a123?xsec_token=token-a&xsec_source=pc_user'
  const second = 'https://www.xiaohongshu.com/explore/665f5a23000000001e03a123?xsec_token=token-b&xsec_source=pc_user'
  const targets = deriveCollectionTargets([
    item(first, '笔记 A', { inMainContentRegion: true, nearestTagName: 'section' }),
    item(second, '笔记 A duplicate', { inMainContentRegion: true, nearestTagName: 'section' }),
  ])

  assert.equal(targets.length, 1)
  assert.equal(targets[0].sourceId, '665f5a23000000001e03a123')
  assert.match(targets[0].openUrl, /xsec_token=token-a/)
})

test('Xiaohongshu account-page note cards survive sidebar-like page layout', () => {
  const first = 'https://www.xiaohongshu.com/user/profile/5d32b406000000001102ac8f/6928017e000000001e0334f4?xsec_token=token-a&xsec_source=pc_user'
  const second = 'https://www.xiaohongshu.com/user/profile/5d32b406000000001102ac8f/6928017e000000001e0334f4?xsec_token=token-b&xsec_source=pc_user'
  const structure = {
    inNavigationRegion: false,
    inSidebarRegion: true,
    inHeaderRegion: false,
    inMainContentRegion: false,
    nearestTagName: 'section',
    containerClass: 'note-item',
  }
  const rows = [
    item(first, '日常的一点静物', structure),
    item(second, '同一篇重复', structure),
  ]
  const targets = deriveCollectionTargets(rows)
  const assessment = assessCollectionTargets(rows, targets)

  assert.equal(targets.length, 1)
  assert.equal(targets[0].sourceId, '6928017e000000001e0334f4')
  assert.match(targets[0].openUrl, /xsec_token=token-a/)
  assert.equal(assessment.quality, 'trustworthy')
  assert.equal(assessment.candidateCount, 1)
})

test('Xiaohongshu collection targets reject navigation/sidebar candidates before note collection', () => {
  const targets = deriveCollectionTargets([
    item(
      'https://www.xiaohongshu.com/explore/665f5a23000000001e03a123?xsec_token=abc',
      '侧栏推荐',
      { inSidebarRegion: true, nearestTagName: 'aside' },
    ),
  ])
  const assessment = assessCollectionTargets([
    item(
      'https://www.xiaohongshu.com/explore/665f5a23000000001e03a123?xsec_token=abc',
      '侧栏推荐',
      { inSidebarRegion: true, nearestTagName: 'aside' },
    ),
  ], targets)

  assert.equal(targets.length, 0)
  assert.equal(assessment.quality, 'suspect_navigation_pollution')
  assert.equal(assessment.reasons.includes('collection_navigation_pollution'), true)
})

test('Xiaohongshu account collection reports missing structure context explicitly', () => {
  const rows = [
    item('https://www.xiaohongshu.com/red_video', '视频'),
    item('https://www.xiaohongshu.com/livelist', '直播'),
  ]
  const targets = deriveCollectionTargets(rows)
  const assessment = assessCollectionTargets(rows, targets)

  assert.equal(targets.length, 0)
  assert.equal(assessment.quality, 'structure_context_missing')
  assert.equal(assessment.reasons.includes('collection_structure_context_missing'), true)
})

// ── P1 (2026-07-03, 7/01 reliability contract C — de-XHS-gate) ──
// Structural navigation exclusion is now a generic candidate feature; these
// assert the quality verdict fires on non-XHS sites too, and that the
// customScript-style missing-structure bypass is surfaced, not silent.

function genericItem(link: string, title: string, structure?: Record<string, unknown>): BrowserStructuredItem {
  return {
    sourceUrl: 'https://blog.example.com/list',
    title,
    link,
    rawFields: structure ? { structure } : {},
  }
}

test('generic site: nav-dominated frozen list is flagged suspect via structure signal (no XHS source)', () => {
  const rows = [
    genericItem('https://blog.example.com/nav/home', '首页', { inNavigationRegion: true, nearestTagName: 'nav' }),
    genericItem('https://blog.example.com/nav/about', '关于', { inNavigationRegion: true, nearestTagName: 'nav' }),
    genericItem('https://blog.example.com/nav/tags', '标签', { inNavigationRegion: true, nearestTagName: 'aside' }),
  ]
  const assessment = assessCollectionTargets(rows)
  assert.equal(assessment.quality, 'suspect_navigation_pollution')
  assert.ok(assessment.reasons.includes('collection_navigation_pollution'))
})

test('generic site: missing structure context is always surfaced as a reason (customScript bypass never silent)', () => {
  // Usable links but no structure context (the customScript extraction bypass
  // shape): the reason is logged so downstream cannot treat the list as
  // silently trustworthy, even though targets survived.
  const rows = [
    genericItem('https://blog.example.com/post/aaa', '文章一'),
    genericItem('https://blog.example.com/post/bbb', '文章二'),
  ]
  const assessment = assessCollectionTargets(rows)
  assert.ok(assessment.reasons.includes('collection_structure_context_missing'), 'missing structure is always logged, never silent')
  assert.equal(assessment.structureContextAvailable, false)
})

test('generic site: missing structure with zero usable targets degrades to structure_context_missing', () => {
  // Anchors that derive to no usable target AND carry no structure context:
  // cannot be trusted → degrade rather than mark clean.
  const rows = [
    genericItem('#section-a', '锚点一'),
    genericItem('javascript:void(0)', '脚本链接'),
  ]
  const assessment = assessCollectionTargets(rows)
  assert.equal(assessment.candidateCount, 0)
  assert.equal(assessment.quality, 'structure_context_missing')
  assert.ok(assessment.reasons.includes('collection_structure_context_missing'))
})

test('generic site: clean content list with structure stays trustworthy (no over-firing)', () => {
  const rows = [
    genericItem('https://blog.example.com/post/aaa', '文章一', { inMainContentRegion: true, nearestTagName: 'article' }),
    genericItem('https://blog.example.com/post/bbb', '文章二', { inMainContentRegion: true, nearestTagName: 'article' }),
  ]
  const assessment = assessCollectionTargets(rows)
  assert.equal(assessment.quality, 'trustworthy')
})
