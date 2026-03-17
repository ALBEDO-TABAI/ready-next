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
})
