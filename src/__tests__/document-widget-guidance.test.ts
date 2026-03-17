import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildDocumentWidgetClarificationSnippet,
  buildDocumentWidgetGuidanceSnippet,
  inferDocumentWidgetProfile,
} from '../main/modules/claude-bridge/widget-guidance'

describe('document widget guidance', () => {
  it('normalizes weekly focus requests into a stable chart profile', () => {
    const profile = inferDocumentWidgetProfile('帮我做一个本周下周对比图，用周报风格，暖一点的淡米色')
    assert.ok(profile)
    assert.equal(profile?.family, 'weekly_focus_chart')
    assert.equal(profile?.style, 'warm_minimal')
    assert.equal(profile?.titleHint, 'weekly_focus_chart')
    assert.match(profile?.interactionHint || '', /本周/)
  })

  it('normalizes calculator requests into a local compute profile', () => {
    const profile = inferDocumentWidgetProfile('做一个评分计算器，输入质量和效率，自动算总分')
    assert.ok(profile)
    assert.equal(profile?.family, 'mini_calculator')
    assert.equal(profile?.titleHint, 'score_calculator')
  })

  it('maps high-frequency research and investment phrases into stronger chart defaults', () => {
    const research = inferDocumentWidgetProfile('做一个科研绘图，用更学术一点的趋势图展示实验结果')
    const investment = inferDocumentWidgetProfile('做一个投资趋向图，偏数据面板风格')
    const dynamic = inferDocumentWidgetProfile('我想看这个主题的数据动态变化')

    assert.equal(research?.family, 'line_chart')
    assert.equal(research?.style, 'academic')
    assert.equal(investment?.family, 'line_chart')
    assert.equal(investment?.style, 'dashboard')
    assert.equal(dynamic?.family, 'line_chart')
  })

  it('builds readable widget guidance snippets for agent prompts', () => {
    const profile = inferDocumentWidgetProfile('做一个本周下周对比图，像周报')
    const snippet = buildDocumentWidgetGuidanceSnippet(profile)
    assert.match(snippet, /weekly_focus_chart/)
    assert.match(snippet, /本周 \/ 下周/)
    assert.match(snippet, /implementation/)
  })

  it('suggests a minimal clarification path for ambiguous chart requests', () => {
    const snippet = buildDocumentWidgetClarificationSnippet('帮我做个数据图表，先看看动态')
    assert.match(snippet, /澄清建议/)
    assert.match(snippet, /折线趋势/)
    assert.match(snippet, /柱状对比/)
    assert.match(snippet, /流程图/)
  })

  it('documents weekly focus chart and style vocabulary in widget baselines', () => {
    const baselines = readFileSync(
      resolve(process.cwd(), 'docs/DOCUMENT_WIDGET_BASELINES.md'),
      'utf8',
    )

    assert.match(baselines, /Weekly Focus Chart/i)
    assert.match(baselines, /Style Vocabulary/i)
    assert.match(baselines, /科研绘图/)
    assert.match(baselines, /投资趋向/)
  })

  it('publishes a widget fixture library and capability matrix', () => {
    const matrix = readFileSync(
      resolve(process.cwd(), 'docs/DOCUMENT_WIDGET_CAPABILITY_MATRIX.md'),
      'utf8',
    )
    const fixtureIndex = readFileSync(
      resolve(process.cwd(), 'docs/widget-fixtures/README.md'),
      'utf8',
    )

    assert.match(matrix, /stats_card/)
    assert.match(matrix, /weekly_focus_chart/)
    assert.match(matrix, /partial|planned/i)
    assert.match(fixtureIndex, /score_calculator/)
    assert.match(fixtureIndex, /weekly_focus_chart/)
  })
})
