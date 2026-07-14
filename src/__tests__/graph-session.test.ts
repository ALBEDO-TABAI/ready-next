import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GraphSessionRegistry,
  type GraphDataFetcher,
} from '../renderer/components/graph/graph-session'
import type { GraphData, GraphQuery } from '../renderer/components/graph/graph-types'

const graph: GraphData = {
  nodes: [{ id: 'doc:1', type: 'doc', label: 'one.md', sourceType: 'document', path: '/workspace/one.md' }],
  edges: [],
  totalDocs: 1,
  truncated: false,
}

function query(workspaceRoot: string): GraphQuery {
  return { workspaceRoot, depth: 2 }
}

test('graph session reuses one fetch across unmount/remount and preserves each view viewport', async () => {
  const registry = new GraphSessionRegistry({ createWorker: () => null })
  const session = registry.get(query('/workspace'))
  let calls = 0
  const fetcher: GraphDataFetcher = async () => {
    calls += 1
    return graph
  }

  const unsubscribe = session.subscribe(() => undefined)
  await session.ensureLoaded(fetcher)
  unsubscribe()
  await session.ensureLoaded(fetcher)

  assert.equal(calls, 1, 'a ready session must not refetch just because its view remounted')
  assert.equal(session.getSnapshot().graph.nodes.length, 1)

  session.setViewState('panel', { viewport: { x: 12, y: 24, zoom: 0.8 }, userAdjusted: true })
  session.setViewState('workspace', { viewport: { x: -30, y: 9, zoom: 1.7 }, userAdjusted: true })
  assert.deepEqual(session.getViewState('panel'), {
    viewport: { x: 12, y: 24, zoom: 0.8 },
    userAdjusted: true,
  })
  assert.deepEqual(session.getViewState('workspace'), {
    viewport: { x: -30, y: 9, zoom: 1.7 },
    userAdjusted: true,
  })
})

test('workspace invalidation refreshes only matching sessions and keeps the last graph on failure', async () => {
  const registry = new GraphSessionRegistry({ createWorker: () => null })
  const first = registry.get(query('/workspace-a'))
  const second = registry.get(query('/workspace-b'))
  let firstCalls = 0
  let secondCalls = 0

  const firstFetcher: GraphDataFetcher = async () => {
    firstCalls += 1
    if (firstCalls > 1) throw new Error('temporary read failure')
    return graph
  }
  const secondFetcher: GraphDataFetcher = async () => {
    secondCalls += 1
    return graph
  }

  const unsubscribeFirst = first.subscribe(() => undefined)
  const unsubscribeSecond = second.subscribe(() => undefined)
  await Promise.all([first.ensureLoaded(firstFetcher), second.ensureLoaded(secondFetcher)])

  await registry.invalidateWorkspace('/workspace-a')

  assert.equal(firstCalls, 2)
  assert.equal(secondCalls, 1, 'unrelated workspace must not be invalidated')
  assert.equal(first.getSnapshot().graph.nodes.length, 1, 'refresh failure must not blank the last successful graph')
  assert.match(first.getSnapshot().error || '', /temporary read failure/)
  unsubscribeFirst()
  unsubscribeSecond()
})

test('stale async response cannot overwrite a newer refresh', async () => {
  const registry = new GraphSessionRegistry({ createWorker: () => null })
  const session = registry.get(query('/workspace'))
  let resolveFirst: ((data: GraphData) => void) | null = null
  const oldGraph: GraphData = { ...graph, nodes: [{ ...graph.nodes[0], label: 'old.md' }] }
  const newGraph: GraphData = { ...graph, nodes: [{ ...graph.nodes[0], label: 'new.md' }] }
  const firstFetcher: GraphDataFetcher = () => new Promise((resolve) => { resolveFirst = resolve })

  const firstLoad = session.ensureLoaded(firstFetcher)
  const refresh = session.refresh(async () => newGraph)
  await refresh
  resolveFirst?.(oldGraph)
  await firstLoad

  assert.equal(session.getSnapshot().graph.nodes[0]?.label, 'new.md')
})

test('static fallback reports a truthful settled state after load, drag, and release', async () => {
  const registry = new GraphSessionRegistry({ createWorker: () => null })
  const session = registry.get(query('/workspace'))

  await session.ensureLoaded(async () => graph)
  assert.equal(session.getSnapshot().settled, true)

  session.pinNode('doc:1', 100, 120)
  assert.equal(session.getSnapshot().settled, true)
  assert.deepEqual([...session.getSnapshot().positions], [100, 120])

  session.releaseNode('doc:1')
  assert.equal(session.getSnapshot().settled, true)
})

test('worker position bursts commit only the latest snapshot once per display frame', async () => {
  let worker: {
    onmessage: ((event: MessageEvent) => void) | null
    onerror: ((event: ErrorEvent) => void) | null
    postMessage(message: unknown): void
    terminate(): void
  } | null = null
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  const registry = new GraphSessionRegistry({
    createWorker: () => {
      worker = {
        onmessage: null,
        onerror: null,
        postMessage() {},
        terminate() {},
      }
      return worker
    },
    requestFrame: (callback) => {
      const handle = nextFrame++
      frames.set(handle, callback)
      return handle
    },
    cancelFrame: (handle) => { frames.delete(handle) },
  })
  const session = registry.get(query('/workspace'))
  await session.ensureLoaded(async () => graph)
  let notifications = 0
  const unsubscribe = session.subscribe(() => { notifications += 1 })
  const revision = session.getSnapshot().revision

  for (let index = 1; index <= 10; index += 1) {
    worker!.onmessage?.({
      data: {
        type: 'positions',
        revision,
        positions: Float32Array.from([index, index * 2]),
        settled: index === 10,
      },
    } as MessageEvent)
  }

  assert.equal(notifications, 0)
  assert.equal(frames.size, 1)
  const [[handle, frame]] = [...frames.entries()]
  frames.delete(handle)
  frame(0)
  assert.equal(notifications, 1)
  assert.deepEqual([...session.getSnapshot().positions], [10, 20])
  assert.equal(session.getSnapshot().settled, true)
  unsubscribe()
})

test('idle focus sessions are bounded and evicted workers are terminated', async () => {
  const workers: Array<{ terminated: boolean }> = []
  const registry = new GraphSessionRegistry({
    createWorker: () => {
      const state = { terminated: false }
      workers.push(state)
      return {
        onmessage: null,
        onerror: null,
        postMessage() {},
        terminate() { state.terminated = true },
      }
    },
  })
  const panorama = registry.get(query('/workspace'))
  await panorama.ensureLoaded(async () => graph)
  const panoramaWorker = workers[0]

  for (let index = 0; index < 20; index += 1) {
    const focus = registry.get({
      workspaceRoot: '/workspace',
      centerPath: `/workspace/${index}.md`,
      depth: 2,
    })
    await focus.ensureLoaded(async () => graph)
  }

  assert.equal(panoramaWorker.terminated, false, 'the recent panorama session should remain reusable')
  assert.ok(workers.filter((workerState) => !workerState.terminated).length <= 9)
  assert.ok(workers.filter((workerState) => workerState.terminated).length >= 12)
})
