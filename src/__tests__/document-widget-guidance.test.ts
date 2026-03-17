import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
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

  it('builds readable widget guidance snippets for agent prompts', () => {
    const profile = inferDocumentWidgetProfile('做一个本周下周对比图，像周报')
    const snippet = buildDocumentWidgetGuidanceSnippet(profile)
    assert.match(snippet, /weekly_focus_chart/)
    assert.match(snippet, /本周 \/ 下周/)
    assert.match(snippet, /implementation/)
  })

  it('documents weekly focus chart and style vocabulary in widget baselines', () => {
    const baselines = readFileSync(
      resolve(process.cwd(), 'docs/DOCUMENT_WIDGET_BASELINES.md'),
      'utf8',
    )

    assert.match(baselines, /Weekly Focus Chart/i)
    assert.match(baselines, /Style Vocabulary/i)
  })
})
