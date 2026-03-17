import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  compactToolPolicyHistory,
  isContextDependentEditPrompt,
  isHostInjectedUserPrompt,
  isRetryOnlyPrompt,
  resolveToolPolicyInput,
} from '../main/modules/claude-bridge/tool-policy-context'

describe('tool policy context', () => {
  it('keeps concrete prompts unchanged', () => {
    const prompt = '在这个股票价格趋势图里增加一个计算输入栏'
    assert.equal(resolveToolPolicyInput(prompt, ['再试一次']), prompt)
  })

  it('reuses the last document widget prompt for retry-only input', () => {
    const retry = resolveToolPolicyInput('再试一次', [
      '在这个股票价格趋势图里增加一个计算输入栏，可以输入买入时间 买入价格 计算收益',
      '继续',
    ])

    assert.match(retry, /股票价格趋势图/)
  })

  it('detects short retry commands', () => {
    assert.equal(isRetryOnlyPrompt('再试一次'), true)
    assert.equal(isRetryOnlyPrompt('continue'), true)
    assert.equal(isRetryOnlyPrompt('在图里增加输入栏'), false)
    assert.equal(isContextDependentEditPrompt('再把细边框也去掉'), true)
  })

  it('skips host-injected follow-up prompts when resolving retry context', () => {
    const retry = resolveToolPolicyInput('继续', [
      '系统检查：你还没有执行真实文档修改。',
      '[tool_result]\ncall_id: abc\ntool: document_list_widgets\nresult:\n当前文档共有 1 个 widget',
      '在这个股票价格趋势图里增加一个计算输入栏，可以输入买入时间 买入价格 计算收益',
    ])

    assert.match(retry, /股票价格趋势图/)
    assert.equal(isHostInjectedUserPrompt('系统检查：你还没有执行真实文档修改。'), true)
  })

  it('filters host-injected history before trimming the retry window', () => {
    const noisyInputs = [
      '在这个股票价格趋势图里增加一个计算输入栏，可以输入买入时间 买入价格 计算收益',
      ...Array.from({ length: 60 }, (_, index) => `系统检查：第 ${index + 1} 次提示`),
    ]

    const history = compactToolPolicyHistory(noisyInputs, 40)
    assert.equal(history[history.length - 1], '在这个股票价格趋势图里增加一个计算输入栏，可以输入买入时间 买入价格 计算收益')

    const retry = resolveToolPolicyInput('继续', noisyInputs)
    assert.match(retry, /股票价格趋势图/)
  })

  it('merges short follow-up edit instructions onto the previous widget request', () => {
    const merged = resolveToolPolicyInput('再把细边框也去掉', [
      '把收益计算的部分的设计风格和上面股价收益图的设计风格统一一下',
    ])

    assert.match(merged, /股价收益图/)
    assert.match(merged, /追加要求：再把细边框也去掉/)
  })
})
