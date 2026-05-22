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

test('classifyMapSemanticIntent calls the semantic classifier for English route requests', async () => {
  _resetMapSemanticIntentCacheForTests()
  let calls = 0
  const prompts = [
    'How do I get from Union Square to Brooklyn Bridge?',
    'How do we get from Union Square to Brooklyn Bridge?',
    'How to get from Union Square to Brooklyn Bridge?',
    'What is the best way from Union Square to Brooklyn Bridge?',
    'What is the best way to get from Union Square to Brooklyn Bridge?',
    "What's the fastest way to Golden Gate Park from Union Square?",
    "What's the best way to Brooklyn Bridge from Union Square?",
    'Best route from Union Square to Brooklyn Bridge?',
    'Fastest way from Union Square to Brooklyn Bridge?',
    'Fastest way to Golden Gate Park from Union Square?',
    'Fastest route from Union Square to Brooklyn Bridge avoiding traffic?',
    'How long does it take to get from Union Square to Brooklyn Bridge?',
    'How do I get from Gateway Arch to City Museum?',
    'Cab directions from Union Square to Brooklyn Bridge.',
    'Taxi from Union Square to Brooklyn Bridge.',
    'Uber from Union Square to Brooklyn Bridge.',
    'Drive from Union Square to the Port Authority Bus Terminal.',
    'Drive from Union Square to Golden Gate Park via Ferry Building.',
    'Walk from Union Square to Golden Gate Park via Train Station.',
  ]
  for (const prompt of prompts) {
    const result = await classifyMapSemanticIntent({
      prompt,
      requestLLM: async () => {
        calls += 1
        return JSON.stringify({
          isMapIntent: true,
          primaryTask: 'route',
          secondarySignals: [],
          confidence: 0.88,
        })
      },
    })

    assert.equal(result?.isMapIntent, true)
    assert.equal(result?.primaryTask, 'route')
    assert.equal(isMapSemanticIntentActive(result), true)
  }

  assert.equal(calls, prompts.length)
})

test('classifyMapSemanticIntent does not call the semantic classifier for ordinary English non-route text', async () => {
  _resetMapSemanticIntentCacheForTests()
  let calls = 0
  const requestLLM = async (): Promise<string> => {
    calls += 1
    return JSON.stringify({
      isMapIntent: false,
      primaryTask: 'none',
      secondarySignals: [],
      confidence: 0.1,
    })
  }

  const prompts = [
    'How do I get an API key?',
    'How do I get from Union Square to Brooklyn Bridge by subway?',
    'How do I get from Union Square to Brooklyn Bridge by train?',
    'How do I get from Union Square to Brooklyn Bridge on the subway?',
    'How do I get from Union Square to Brooklyn Bridge via train?',
    'How do I get from Union Square to Brooklyn Bridge by public transport?',
    'How do I get from Union Square to Brooklyn Bridge by public transit?',
    'How do I get from Union Square to Brooklyn Bridge by public transportation?',
    'How do I get from Union Square to Brooklyn Bridge on public transportation?',
    'Take the bus from A to B.',
    'Take the train from A to B.',
    'Bus from A to B.',
    'Train from A to B.',
    'Move the file from Google Drive to Dropbox.',
    'Route API traffic from service A to service B.',
    'Route network traffic from service A to service B.',
    'Route gateway traffic from service A to service B.',
    'Route the event bus from service A to service B.',
    'Follow these directions to configure the SDK.',
    'What is the best way to translate from Chinese to English?',
    'What is the best way to migrate from Chinese to English?',
    'What is the best way to convert from CSV to JSON?',
    'Translate this sentence from Chinese to English.',
    'Walk me through this code.',
    'Map these fields into the new schema.',
    'Open the Google Drive file.',
  ]
  for (const prompt of prompts) {
    const result = await classifyMapSemanticIntent({ prompt, requestLLM })
    assert.equal(result, null)
  }

  assert.equal(calls, 0)
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
