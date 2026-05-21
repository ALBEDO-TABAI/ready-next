import assert from 'node:assert/strict'
import test from 'node:test'

import {
  _resetMapSemanticIntentCacheForTests,
  classifyMapSemanticIntent,
  isMapSemanticIntentActive,
} from '../main/modules/agent-control/map-semantic-intent'

test('classifyMapSemanticIntent parses LLM JSON and caches by prompt', async () => {
  _resetMapSemanticIntentCacheForTests()
  let calls = 0
  const first = await classifyMapSemanticIntent({
    prompt: '从北京南站到故宫怎么走',
    requestLLM: async (_prompt, timeoutMs) => {
      calls += 1
      assert.equal(timeoutMs, 1500)
      return JSON.stringify({
        isMapIntent: true,
        primaryTask: 'route',
        secondarySignals: [],
        confidence: 0.91,
      })
    },
  })
  const second = await classifyMapSemanticIntent({
    prompt: '从北京南站到故宫怎么走',
    requestLLM: async () => {
      throw new Error('cache miss')
    },
  })

  assert.equal(calls, 1)
  assert.deepEqual(second, first)
  assert.equal(isMapSemanticIntentActive(second), true)
})

test('classifyMapSemanticIntent falls back to strong route keywords after LLM failure', async () => {
  _resetMapSemanticIntentCacheForTests()
  const result = await classifyMapSemanticIntent({
    prompt: '从上海虹桥站到外滩怎么走，顺路晚餐并写成文档',
    requestLLM: async () => {
      throw new Error('timeout')
    },
  })

  assert.equal(result?.isMapIntent, true)
  assert.equal(result?.primaryTask, 'along_route_search')
  assert.deepEqual(result?.secondarySignals, ['document_output'])
  assert.equal(result?.confidence, 0.65)
  assert.equal(result?.reason, 'llm_failed_keyword_fallback')
})

test('classifyMapSemanticIntent corrects weak LLM misses with strong route keywords', async () => {
  _resetMapSemanticIntentCacheForTests()
  const result = await classifyMapSemanticIntent({
    prompt: '成都 4 个地点怎么走，给我最省时间的顺序和总耗时',
    requestLLM: async () => JSON.stringify({
      isMapIntent: false,
      primaryTask: 'none',
      secondarySignals: ['browser_lookup'],
      confidence: 0.2,
      reason: 'browser context',
    }),
  })

  assert.equal(result?.isMapIntent, true)
  assert.equal(result?.primaryTask, 'multi_point_order')
  assert.equal(result?.reason, 'llm_failed_keyword_fallback')
})

test('classifyMapSemanticIntent recognizes conversational route timing prompts after LLM failure', async () => {
  _resetMapSemanticIntentCacheForTests()
  const result = await classifyMapSemanticIntent({
    prompt: '看看这条路线逛完要多久',
    requestLLM: async () => {
      throw new Error('timeout')
    },
  })

  assert.equal(result?.isMapIntent, true)
  assert.equal(result?.primaryTask, 'route')
  assert.equal(result?.reason, 'llm_failed_keyword_fallback')
})

test('classifyMapSemanticIntent recognizes multi-point route prompts after LLM failure', async () => {
  _resetMapSemanticIntentCacheForTests()
  const result = await classifyMapSemanticIntent({
    prompt: '成都 4 个地点怎么走，给我最省时间的顺序',
    requestLLM: async () => {
      throw new Error('timeout')
    },
  })

  assert.equal(result?.isMapIntent, true)
  assert.equal(result?.primaryTask, 'multi_point_order')
})

test('classifyMapSemanticIntent returns null when LLM fails and no map signal is present', async () => {
  _resetMapSemanticIntentCacheForTests()
  const result = await classifyMapSemanticIntent({
    prompt: '明天安排一个会议行程',
    requestLLM: async () => 'not json',
  })

  assert.equal(result, null)
})
