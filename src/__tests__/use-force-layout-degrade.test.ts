import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  useForceLayout,
  MAX_NODES_BEFORE_DEGRADE,
  type ForceLayoutResult,
  type GraphEdge,
  type GraphNode,
} from '../renderer/components/graph/useForceLayout'

function makeNodes(count: number): GraphNode[] {
  const nodes: GraphNode[] = new Array(count)
  for (let i = 0; i < count; i += 1) {
    nodes[i] = { id: `n${i}`, type: 'doc', label: `N${i}` }
  }
  return nodes
}

function captureHook(nodes: GraphNode[], edges: GraphEdge[] = []): ForceLayoutResult {
  let captured: ForceLayoutResult | null = null
  function Probe(): React.ReactElement | null {
    captured = useForceLayout(nodes, edges, { width: 400, height: 300, iterations: 4 })
    return null
  }
  renderToStaticMarkup(React.createElement(Probe))
  if (!captured) throw new Error('hook did not produce a result')
  return captured
}

test('useForceLayout returns ok with positions when node count is at the cap (500)', () => {
  const result = captureHook(makeNodes(MAX_NODES_BEFORE_DEGRADE))
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') throw new Error('unreachable')
  assert.equal(result.positions.length, MAX_NODES_BEFORE_DEGRADE)
  assert.equal(result.nodes.length, MAX_NODES_BEFORE_DEGRADE)
  for (const node of result.positions) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `node ${node.id} coords not finite`)
  }
})

test('useForceLayout returns degraded with reason "too_many_nodes" when count is 501', () => {
  const result = captureHook(makeNodes(MAX_NODES_BEFORE_DEGRADE + 1))
  assert.equal(result.status, 'degraded')
  if (result.status !== 'degraded') throw new Error('unreachable')
  assert.equal(result.reason, 'too_many_nodes')
  assert.equal(result.nodeCount, MAX_NODES_BEFORE_DEGRADE + 1)
  assert.equal(result.maxSupported, MAX_NODES_BEFORE_DEGRADE)
})

test('useForceLayout returns degraded for extreme node counts (1M) without running O(N²) simulation', () => {
  const HUGE = 1_000_000
  const start = Date.now()
  // We allocate placeholder GraphNode entries cheaply; the hook must short-circuit
  // before the O(N²) inner loop, otherwise this test would not return for hours.
  const nodes = makeNodes(HUGE)
  const allocMs = Date.now() - start
  const beforeHook = Date.now()
  const result = captureHook(nodes)
  const hookMs = Date.now() - beforeHook
  assert.equal(result.status, 'degraded')
  if (result.status !== 'degraded') throw new Error('unreachable')
  assert.equal(result.reason, 'too_many_nodes')
  assert.equal(result.nodeCount, HUGE)
  assert.equal(result.maxSupported, MAX_NODES_BEFORE_DEGRADE)
  // Sanity guard: refusing the layout should be effectively instant compared to
  // even allocating the node array. Allow a generous 5s ceiling.
  assert.ok(hookMs < 5_000, `degraded path should short-circuit fast, took ${hookMs}ms (alloc=${allocMs}ms)`)
})

test('ForceLayoutResult is a discriminated union — narrowing compiles and round-trips', () => {
  // Compile-time check: each branch should expose only its own fields. If the
  // discriminant ever stops narrowing, this block fails to type-check during
  // `npm run typecheck`. The runtime assertions below additionally confirm the
  // narrowing matches reality.
  const okResult = captureHook(makeNodes(3))
  if (okResult.status === 'ok') {
    // `positions` exists on ok branch only.
    const _positions: Array<{ x: number; y: number }> = okResult.positions
    void _positions
    // @ts-expect-error degraded-only fields must not appear on the ok branch
    void okResult.reason
    // @ts-expect-error degraded-only fields must not appear on the ok branch
    void okResult.nodeCount
  } else {
    throw new Error('expected ok status for small graph')
  }

  const degradedResult = captureHook(makeNodes(MAX_NODES_BEFORE_DEGRADE + 1))
  if (degradedResult.status === 'degraded') {
    const _reason: 'too_many_nodes' = degradedResult.reason
    const _count: number = degradedResult.nodeCount
    void _reason
    void _count
    // @ts-expect-error ok-only fields must not appear on the degraded branch
    void degradedResult.positions
    // @ts-expect-error ok-only fields must not appear on the degraded branch
    void degradedResult.nodes
  } else {
    throw new Error('expected degraded status for oversized graph')
  }
})
