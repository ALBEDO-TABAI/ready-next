import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { describe, it } from 'node:test'

import {
  createGraphSimulation,
  graphSimulationCadence,
  pinGraphSimulationNode,
  releaseGraphSimulationNode,
  snapshotGraphPositions,
  stepGraphSimulation,
} from '../renderer/components/graph/graph-layout-engine'
import type { GraphEdge, GraphNode } from '../renderer/components/graph/graph-types'

function makeLargeSparseGraph(nodeCount = 1700, edgeCount = 600): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = Array.from({ length: nodeCount }, (_, index) => ({
    id: `doc:${index}`,
    type: index % 7 === 0 ? 'tag' : 'doc',
    label: `Node ${index}`,
  }))
  const edges: GraphEdge[] = Array.from({ length: edgeCount }, (_, index) => ({
    source: `doc:${index % nodeCount}`,
    target: `doc:${(index * 17 + 31) % nodeCount}`,
    kind: index % 3 === 0 ? 'tag-of' : 'wikilink',
  }))
  return { nodes, edges }
}

describe('progressive graph layout engine', () => {
  it('uses smaller, steadier updates for large graphs', () => {
    assert.deepEqual(graphSimulationCadence(1700), { iterations: 1, delayMs: 10 })
    assert.deepEqual(graphSimulationCadence(600), { iterations: 2, delayMs: 10 })
    assert.deepEqual(graphSimulationCadence(120), { iterations: 4, delayMs: 12 })
  })

  it('lays out a real-workspace-sized sparse graph without all-pairs scanning', () => {
    const graph = makeLargeSparseGraph()
    const state = createGraphSimulation(graph.nodes, graph.edges)
    const before = snapshotGraphPositions(state)
    let pairChecks = 0

    for (let tick = 0; tick < 12; tick += 1) {
      pairChecks += stepGraphSimulation(state).pairChecks
    }

    const after = snapshotGraphPositions(state)
    assert.equal(after.length, graph.nodes.length * 2)
    assert.ok(after.every(Number.isFinite), 'all layout coordinates must stay finite')
    assert.notDeepEqual([...after], [...before], 'successive ticks must visibly move the graph')

    const allPairsPerTick = graph.nodes.length * (graph.nodes.length - 1) / 2
    assert.ok(
      pairChecks < allPairsPerTick,
      `12 progressive ticks should inspect fewer pairs than one all-pairs tick (${pairChecks} < ${allPairsPerTick})`,
    )

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let index = 0; index < after.length; index += 2) {
      minX = Math.min(minX, after[index])
      maxX = Math.max(maxX, after[index])
      minY = Math.min(minY, after[index + 1])
      maxY = Math.max(maxY, after[index + 1])
    }
    const aspect = (maxX - minX) / Math.max(1, maxY - minY)
    assert.ok(aspect > 0.72 && aspect < 1.38, `global layout should remain broadly circular (aspect=${aspect})`)

    pinGraphSimulationNode(state, 'doc:0', after[0] + 120, after[1] - 80)
    const localPairChecks = stepGraphSimulation(state).pairChecks
    assert.ok(
      localPairChecks < pairChecks / 48,
      `dragging should only scan its local neighbourhood (${localPairChecks} < ${pairChecks / 48})`,
    )
  })

  it('keeps a 3600-node sparse layout tick within the animation budget', () => {
    const graph = makeLargeSparseGraph(3625, 2902)
    const initializeStarted = performance.now()
    const state = createGraphSimulation(graph.nodes, graph.edges)
    const initializeDuration = performance.now() - initializeStarted
    stepGraphSimulation(state, 2)
    const samples: number[] = []
    for (let tick = 0; tick < 12; tick += 1) {
      const started = performance.now()
      stepGraphSimulation(state)
      samples.push(performance.now() - started)
    }
    samples.sort((left, right) => left - right)
    const median = samples[Math.floor(samples.length / 2)]
    assert.ok(
      initializeDuration < 250,
      `large graph initialization should stay below 250ms (actual ${initializeDuration.toFixed(2)}ms)`,
    )
    assert.ok(median < 40, `median layout tick should stay below 40ms (actual ${median.toFixed(2)}ms)`)
  })

  it('pins a dragged node and reheats it after release', () => {
    const graph = makeLargeSparseGraph(80, 60)
    const state = createGraphSimulation(graph.nodes, graph.edges)

    assert.equal(pinGraphSimulationNode(state, 'doc:4', 240, -130), true)
    stepGraphSimulation(state, 8)
    let positions = snapshotGraphPositions(state)
    assert.equal(positions[8], 240)
    assert.equal(positions[9], -130)

    assert.equal(releaseGraphSimulationNode(state, 'doc:4'), true)
    stepGraphSimulation(state, 16)
    positions = snapshotGraphPositions(state)
    assert.ok(
      Math.hypot(positions[8] - 240, positions[9] + 130) > 0.5,
      'released node should rejoin the dynamic layout',
    )
  })

  it('pulls the local connection chain elastically without stirring unrelated nodes', () => {
    const nodes: GraphNode[] = ['a', 'b', 'c', 'unrelated'].map((id) => ({ id, type: 'doc', label: id }))
    const edges: GraphEdge[] = [
      { source: 'a', target: 'b', kind: 'wikilink' },
      { source: 'b', target: 'c', kind: 'wikilink' },
    ]
    const state = createGraphSimulation(nodes, edges)
    stepGraphSimulation(state, 80)
    const before = snapshotGraphPositions(state)

    pinGraphSimulationNode(state, 'a', before[0] + 220, before[1] - 120)
    stepGraphSimulation(state, 12)
    const dragged = snapshotGraphPositions(state)
    const movement = (index: number) => Math.hypot(
      dragged[index * 2] - before[index * 2],
      dragged[index * 2 + 1] - before[index * 2 + 1],
    )

    assert.ok(movement(1) > 25, `direct neighbour should visibly follow the drag (${movement(1)})`)
    assert.ok(movement(2) > movement(3) * 2, 'second-hop neighbour should flex more than an unrelated node')
    assert.ok(movement(3) < 0.01, `unrelated node should remain still during local drag (${movement(3)})`)

    const stretchedDistance = Math.hypot(dragged[0] - dragged[2], dragged[1] - dragged[3])
    releaseGraphSimulationNode(state, 'a')
    stepGraphSimulation(state, 36)
    const released = snapshotGraphPositions(state)
    const releasedDistance = Math.hypot(released[0] - released[2], released[1] - released[3])
    assert.ok(releasedDistance < stretchedDistance, 'the stretched connection should ease back after release')
    assert.ok(
      Math.hypot(released[6] - before[6], released[7] - before[7]) < 0.01,
      'unrelated node should remain still through the release animation',
    )
  })

  it('keeps disconnected relationship islands spatially separate', () => {
    const nodes: GraphNode[] = [
      { id: 'a:hub', type: 'tag', label: 'A' },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `a:${index}`, type: 'doc' as const, label: `A${index}` })),
      { id: 'b:hub', type: 'tag', label: 'B' },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `b:${index}`, type: 'doc' as const, label: `B${index}` })),
    ]
    const edges: GraphEdge[] = [
      ...Array.from({ length: 12 }, (_, index) => ({ source: 'a:hub', target: `a:${index}`, kind: 'tag-of' })),
      ...Array.from({ length: 12 }, (_, index) => ({ source: 'b:hub', target: `b:${index}`, kind: 'tag-of' })),
    ]
    const state = createGraphSimulation(nodes, edges)
    stepGraphSimulation(state, 240)
    const positions = snapshotGraphPositions(state)

    const bounds = (prefix: string) => {
      const members = nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => node.id.startsWith(prefix))
      const xs = members.map(({ index }) => positions[index * 2])
      const ys = members.map(({ index }) => positions[index * 2 + 1])
      return {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
      }
    }
    const a = bounds('a:')
    const b = bounds('b:')
    const horizontalGap = Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX)
    const verticalGap = Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY)

    assert.ok(
      horizontalGap > 36 || verticalGap > 36,
      `disconnected islands should retain a visible gap (horizontal=${horizontalGap}, vertical=${verticalGap})`,
    )
  })

  it('fills free space around relationship islands before expanding isolated nodes outward', () => {
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []
    for (const prefix of ['a', 'b', 'c']) {
      nodes.push({ id: `${prefix}:hub`, type: 'tag', label: prefix.toUpperCase() })
      for (let index = 0; index < 12; index += 1) {
        nodes.push({ id: `${prefix}:${index}`, type: 'doc', label: `${prefix}${index}` })
        edges.push({ source: `${prefix}:hub`, target: `${prefix}:${index}`, kind: 'tag-of' })
      }
    }
    for (let index = 0; index < 80; index += 1) {
      nodes.push({ id: `isolated:${index}`, type: 'doc', label: `Isolated ${index}` })
    }

    const state = createGraphSimulation(nodes, edges)
    const positions = snapshotGraphPositions(state)
    const connectedIndices = nodes.flatMap((node, index) => (
      node.id.startsWith('isolated:') ? [] : [index]
    ))
    const isolatedIndices = nodes.flatMap((node, index) => (
      node.id.startsWith('isolated:') ? [index] : []
    ))
    const centerX = connectedIndices.reduce((sum, index) => sum + positions[index * 2], 0) / connectedIndices.length
    const centerY = connectedIndices.reduce((sum, index) => sum + positions[index * 2 + 1], 0) / connectedIndices.length
    const connectedOuterRadius = Math.max(...connectedIndices.map((index) => Math.hypot(
      positions[index * 2] - centerX,
      positions[index * 2 + 1] - centerY,
    )))
    const nearestIsolatedRadius = Math.min(...isolatedIndices.map((index) => Math.hypot(
      positions[index * 2] - centerX,
      positions[index * 2 + 1] - centerY,
    )))

    assert.ok(
      nearestIsolatedRadius < connectedOuterRadius,
      `isolated nodes should use gaps inside the relationship field before forming an outer ring (${nearestIsolatedRadius} < ${connectedOuterRadius})`,
    )
  })

  it('lets nearby unrelated nodes yield during a drag without disturbing distant nodes', () => {
    const nodes: GraphNode[] = ['dragged', 'linked', 'blocker', 'distant'].map((id) => ({ id, type: 'doc', label: id }))
    const state = createGraphSimulation(nodes, [{ source: 'dragged', target: 'linked', kind: 'wikilink' }])
    stepGraphSimulation(state, 100)
    const before = snapshotGraphPositions(state)

    pinGraphSimulationNode(state, 'dragged', before[4], before[5])
    stepGraphSimulation(state, 12)
    const after = snapshotGraphPositions(state)
    const blockerMovement = Math.hypot(after[4] - before[4], after[5] - before[5])
    const distantMovement = Math.hypot(after[6] - before[6], after[7] - before[7])

    assert.ok(blockerMovement > 4, `nearby unrelated node should yield (${blockerMovement})`)
    assert.ok(distantMovement < 0.5, `distant unrelated node should remain steady (${distantMovement})`)
  })

  it('keeps indirectly related hubs from collapsing onto each other', () => {
    const nodes: GraphNode[] = [
      { id: 'tag:a', type: 'tag', label: 'A' },
      { id: 'tag:b', type: 'tag', label: 'B' },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `doc:${index}`, type: 'doc' as const, label: `D${index}` })),
    ]
    const edges: GraphEdge[] = nodes.slice(2).flatMap((node) => [
      { source: 'tag:a', target: node.id, kind: 'tag-of' },
      { source: 'tag:b', target: node.id, kind: 'tag-of' },
    ])
    const state = createGraphSimulation(nodes, edges)
    stepGraphSimulation(state, 360)
    const positions = snapshotGraphPositions(state)
    const hubDistance = Math.hypot(positions[0] - positions[2], positions[1] - positions[3])

    assert.ok(hubDistance > 44, `indirectly related hubs should preserve repulsion (${hubDistance})`)
  })

  it('handles an empty graph', () => {
    const state = createGraphSimulation([], [])
    assert.deepEqual([...snapshotGraphPositions(state)], [])
    assert.deepEqual(stepGraphSimulation(state), { moved: 0, pairChecks: 0, settled: true })
  })

  it('stops consuming frames after a bounded settling window', () => {
    const graph = makeLargeSparseGraph(120, 80)
    const state = createGraphSimulation(graph.nodes, graph.edges)
    let settled = false
    for (let tick = 0; tick < 360 && !settled; tick += 1) {
      settled = stepGraphSimulation(state).settled
    }
    assert.equal(settled, true)
  })
})
