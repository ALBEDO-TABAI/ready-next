import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isRetryOnlyPrompt, resolveToolPolicyInput } from '../main/modules/claude-bridge/tool-policy-context'

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
  })
})
