import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  arbitrateSkeletonForUserText,
  findSkeletonForTriggerKeyword,
  widgetSkeletonRequiresTriggerKeyword,
} from '../shared/document-widget-skeletons'
import { detectLiveInfoIntent } from '../main/modules/agent-control/live-info-intent'

describe('widget skeleton trigger keyword arbitration', () => {
  it('routes "做一个超特殊卡片" to freeform_static', () => {
    assert.equal(findSkeletonForTriggerKeyword('帮我做一个超特殊卡片'), 'freeform_static')
  })

  it('routes "交互式数据图" to freeform_interactive', () => {
    assert.equal(findSkeletonForTriggerKeyword('我要一张交互式数据图'), 'freeform_interactive')
  })

  it('returns null for plain widget ask', () => {
    assert.equal(findSkeletonForTriggerKeyword('做一张周报卡片'), null)
    assert.equal(findSkeletonForTriggerKeyword(''), null)
  })

  it('marks H1/H2 as requiring trigger keyword, A–G as free', () => {
    assert.equal(widgetSkeletonRequiresTriggerKeyword('freeform_static'), true)
    assert.equal(widgetSkeletonRequiresTriggerKeyword('freeform_interactive'), true)
    assert.equal(widgetSkeletonRequiresTriggerKeyword('single_focus'), false)
    assert.equal(widgetSkeletonRequiresTriggerKeyword('metric_grid'), false)
  })

  it('downgrades freeform_static to single_focus when keyword missing', () => {
    const result = arbitrateSkeletonForUserText('freeform_static', '做一张周报卡片')
    assert.equal(result.downgraded, true)
    assert.equal(result.skeleton, 'single_focus')
    assert.equal(result.reason, 'trigger_keyword_missing')
  })

  it('keeps freeform_static when user message contains trigger keyword', () => {
    const result = arbitrateSkeletonForUserText('freeform_static', '做一个超特殊卡片，展示今日重点')
    assert.equal(result.downgraded, false)
    assert.equal(result.skeleton, 'freeform_static')
  })

  it('downgrades freeform_interactive to chart_focus when keyword missing', () => {
    const result = arbitrateSkeletonForUserText('freeform_interactive', '做一张柱状图')
    assert.equal(result.downgraded, true)
    assert.equal(result.skeleton, 'chart_focus')
  })

  it('passes through A–G skeletons without checking keywords', () => {
    const result = arbitrateSkeletonForUserText('metric_grid', '做一张周报卡片')
    assert.equal(result.downgraded, false)
    assert.equal(result.skeleton, 'metric_grid')
    assert.equal(result.reason, 'ok')
  })

  it('treats unknown skeleton as downgrade to single_focus', () => {
    const result = arbitrateSkeletonForUserText('totally_invalid', 'anything')
    assert.equal(result.downgraded, true)
    assert.equal(result.skeleton, 'single_focus')
    assert.equal(result.reason, 'unknown_skeleton')
  })

  it('keyword-carrying prompts are not misrouted into live-info browser workflow', () => {
    assert.equal(detectLiveInfoIntent('做一个超特殊卡片，展示今日重点').needsLiveInfo, false)
    assert.equal(detectLiveInfoIntent('做一张交互式数据图，展示季度数据').needsLiveInfo, false)
  })

  it('widget vocabulary in LOCAL_DOMAIN_HINTS still blocks live-info', () => {
    assert.equal(detectLiveInfoIntent('帮我改一下信息卡里的最新数据').needsLiveInfo, false)
    assert.equal(detectLiveInfoIntent('更新一下透明背景的卡片').needsLiveInfo, false)
  })

  it('true external-lookup prompts still promote to live-info', () => {
    assert.equal(detectLiveInfoIntent('北京今天天气怎么样').needsLiveInfo, true)
  })
})
