import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  inferDocumentWidgetTaskKind,
  shouldForceDocumentToolCall,
} from '../main/modules/claude-bridge/tool-policy-heuristics'

describe('document tool heuristics', () => {
  it('forces document tools for chart generation inside the current document', () => {
    const prompt = '用下面这组信息在当前文档里生成 30 天股票价格波动图'
    assert.equal(inferDocumentWidgetTaskKind(prompt), 'create')
    assert.equal(shouldForceDocumentToolCall(prompt), true)
  })

  it('forces document tools for follow-up edits on an existing chart widget', () => {
    const prompt = '在这个股票价格趋势图里增加一个计算输入栏，可以输入买入时间 买入价格 计算收益'
    assert.equal(inferDocumentWidgetTaskKind(prompt), 'update')
    assert.equal(shouldForceDocumentToolCall(prompt), true)
  })

  it('treats style-only chart follow-up requests as widget updates', () => {
    const prompt = '把收益计算的部分的设计风格和上面股价收益图的设计风格统一一下'
    assert.equal(inferDocumentWidgetTaskKind(prompt), 'update')
    assert.equal(shouldForceDocumentToolCall(prompt), true)
  })

  it('treats widget preview surface fixes as document widget updates', () => {
    const prompt = '现在预览还有灰色的底，而且计算器的部分输入的数值需要有输入框'
    assert.equal(inferDocumentWidgetTaskKind(prompt), 'update')
    assert.equal(shouldForceDocumentToolCall(prompt), true)
  })

  it('forces document widget creation for file-referenced info card requests', () => {
    const prompt = '用@[20260324 Kleon - YC总裁每天只睡四小时，开源了他的”AI工程.md]的内容在@[新文档.md]中生成一张学习信息卡'
    assert.equal(inferDocumentWidgetTaskKind(prompt), 'create')
    assert.equal(shouldForceDocumentToolCall(prompt), true)
  })

  it('forces document widget creation for tables and personal data cards', () => {
    const tablePrompt = '在当前文档里做一个数据表格，把这周的发布数据对比列出来'
    const schedulePrompt = '给我做一个今天的日程卡，按时间列出安排'

    assert.equal(inferDocumentWidgetTaskKind(tablePrompt), 'create')
    assert.equal(shouldForceDocumentToolCall(tablePrompt), true)
    assert.equal(inferDocumentWidgetTaskKind(schedulePrompt), 'create')
    assert.equal(shouldForceDocumentToolCall(schedulePrompt), true)
  })

  it('treats explicit bottom-insert info card requests as widget creation even when they mention minimalist style', () => {
    const prompt = '直接在最下方开始做一个竖向 9:16 的极简绿色风格的信息卡'

    assert.equal(inferDocumentWidgetTaskKind(prompt), 'create')
    assert.equal(shouldForceDocumentToolCall(prompt), true)
  })
})
