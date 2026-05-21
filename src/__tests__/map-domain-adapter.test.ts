import assert from 'node:assert/strict'
import test from 'node:test'

import { MapDomainAdapter } from '../main/modules/agent-control/map-domain-adapter'
import { ResearchDomainAdapter } from '../main/modules/agent-control/domain-adapters/research-domain-adapter'
import { selectDomainAdapter, type DomainAdapter } from '../main/modules/agent-control/domain-adapters/domain-adapter'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

function createRoute(executor: 'map' | 'research' | 'browser') {
  return {
    taskId: 'task-1',
    taskType: executor === 'research' ? 'research' as const : 'short_task' as const,
    chain: 'tool_loop' as const,
    executor,
    steps: [],
    continuation: null,
  }
}

function createExecutionIntentContext(signals: Array<'document_output' | 'research_lookup' | 'browser_lookup'> = []) {
  return {
    mapSemanticIntent: {
      isMapIntent: true,
      primaryTask: 'route',
      secondarySignals: signals,
      confidence: 0.8,
    },
  } as never
}

test('MapDomainAdapter is selected synchronously from precomputed semantic intent', () => {
  const adapters: DomainAdapter[] = [
    new MapDomainAdapter(),
    new ResearchDomainAdapter(),
  ]
  const selected = selectDomainAdapter(adapters, {
    route: createRoute('map'),
    userText: '从 A 到 B 怎么走',
    hasTools: true,
    executionIntentContext: createExecutionIntentContext(),
  })

  assert.equal(selected?.id, 'map')
})

test('MapDomainAdapter wins over stale browser route when semantic intent is map', () => {
  const adapters: DomainAdapter[] = [
    new MapDomainAdapter(),
    new ResearchDomainAdapter(),
  ]
  const selected = selectDomainAdapter(adapters, {
    route: createRoute('browser'),
    userText: '成都 4 个地点怎么走，给我最省时间的顺序',
    hasTools: true,
    executionIntentContext: createExecutionIntentContext(),
  })

  assert.equal(selected?.id, 'map')
})

test('MapDomainAdapter narrows to map and admitted secondary tools only', () => {
  const adapter = new MapDomainAdapter()
  const result = adapter.prepare({
    route: createRoute('map'),
    request: { abortSignal: new AbortController().signal } as never,
    host: { log: () => undefined } as never,
    session: { messages: [] } as never,
    userText: '查一下评价，路上找咖啡并写成文档',
    pureUserInput: '查一下评价，路上找咖啡并写成文档',
    requestEnvelope: {} as never,
    executionIntentContext: createExecutionIntentContext(['document_output', 'research_lookup']),
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: [
      'map_plan_route',
      'ask_user_questions',
      'document_set_content',
      'web_search',
      'browser_click',
      'calendar_create_event',
    ],
  })

  assert.deepEqual(result.allowedToolNames, [
    'map_plan_route',
    'ask_user_questions',
    'document_set_content',
    'web_search',
  ])
})

test('MapDomainAdapter does not admit research tools without explicit research wording', () => {
  const adapter = new MapDomainAdapter()
  const result = adapter.prepare({
    route: createRoute('map'),
    request: { abortSignal: new AbortController().signal } as never,
    host: { log: () => undefined } as never,
    session: { messages: [] } as never,
    userText: '这条路线逛完要多久',
    pureUserInput: '这条路线逛完要多久',
    requestEnvelope: {} as never,
    executionIntentContext: createExecutionIntentContext(['research_lookup']),
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: [
      'map_plan_route',
      'web_search',
      'web_fetch',
    ],
  })

  assert.deepEqual(result.allowedToolNames, [
    'map_plan_route',
  ])
})

test('MapDomainAdapter treats "do not search web" as a lookup denial', () => {
  const adapter = new MapDomainAdapter()
  const result = adapter.prepare({
    route: createRoute('browser'),
    request: { abortSignal: new AbortController().signal } as never,
    host: { log: () => undefined } as never,
    session: { messages: [] } as never,
    userText: '成都 4 个地点怎么走，给我总耗时，不要查网页',
    pureUserInput: '成都 4 个地点怎么走，给我总耗时，不要查网页',
    requestEnvelope: {} as never,
    executionIntentContext: createExecutionIntentContext(['research_lookup', 'browser_lookup']),
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: [
      'map_plan_route',
      'web_search',
      'web_fetch',
      'browser_click',
    ],
  })

  assert.deepEqual(result.allowedToolNames, [
    'map_plan_route',
  ])
})

test('MapDomainAdapter closes pure map tasks after map_plan_route returns', () => {
  const adapter = new MapDomainAdapter()
  const result = adapter.applyResult({
    route: createRoute('map'),
    request: { abortSignal: new AbortController().signal } as never,
    host: { log: () => undefined } as never,
    session: { messages: [] } as never,
    userText: '从 A 到 B 怎么走',
    pureUserInput: '从 A 到 B 怎么走',
    requestEnvelope: {} as never,
    executionIntentContext: createExecutionIntentContext(),
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: ['map_plan_route'],
    emitStructuredTaskPayload: () => undefined,
    domainState: null,
    phase: 'tool_batch',
    toolBatch: {
      executedTools: [{
        id: 'tool-1',
        name: 'map_plan_route',
        input: {},
        result: createToolExecutionOutput(JSON.stringify({
          ok: true,
          origin: { name: 'A', location: '1,1', source: 'input' },
          destination: { name: 'B', location: '2,2', source: 'input' },
          selectedRoute: {
            transportMode: 'walking',
            distanceM: 1500,
            durationSec: 1500,
            polyline: '',
            steps: [],
          },
        }), {
          shape: 'json',
          data: {
            ok: true,
            origin: { name: 'A', location: '1,1', source: 'input' },
            destination: { name: 'B', location: '2,2', source: 'input' },
            selectedRoute: {
              transportMode: 'walking',
              distanceM: 1500,
              durationSec: 1500,
              polyline: '',
              steps: [],
            },
          },
        }),
      }],
    },
  })

  assert.match(result.finalText || '', /地图路线已经规划好/)
  assert.equal(result.projection?.phase, 'done')
})

test('MapDomainAdapter refuses weak or non-map semantic intent', () => {
  const adapter = new MapDomainAdapter()
  assert.equal(adapter.shouldHandle({
    route: createRoute('map'),
    userText: '附近有什么咖啡店',
    hasTools: true,
    executionIntentContext: {
      mapSemanticIntent: {
        isMapIntent: false,
        primaryTask: 'none',
        secondarySignals: [],
        confidence: 0.2,
      },
    } as never,
  }), false)
})
