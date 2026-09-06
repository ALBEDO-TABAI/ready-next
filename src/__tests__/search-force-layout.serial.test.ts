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

function makeMixedGraph(starSizes = [400, 40, 24, 12, 8, 6, 4], isolatedCount = 1000) {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  for (const [group, size] of starSizes.entries()) {
    const hub = `hub:${group}`
    nodes.push({ id: hub, type: 'tag', label: hub })
    for (let index = 0; index < size; index += 1) {
      const id = `member:${group}:${index}`
      nodes.push({ id, type: 'doc', label: id })
      edges.push({ source: hub, target: id, kind: 'tag-of' })
    }
  }
  for (let index = 0; index < isolatedCount; index += 1) {
    const id = `isolated:${index}`
    nodes.push({ id, type: 'doc', label: id })
  }
  return { nodes, edges }
}

function assertCohesiveField(positions: Float32Array): void {
  const count = positions.length / 2
  const xs = Array.from({ length: count }, (_, index) => positions[index * 2])
  const ys = Array.from({ length: count }, (_, index) => positions[index * 2 + 1])
  const width = Math.max(...xs) - Math.min(...xs)
  const height = Math.max(...ys) - Math.min(...ys)
  assert.ok(width / height > 0.8 && width / height < 1.25, `whole field should be round (${width / height})`)
  const centerX = xs.reduce((sum, x) => sum + x, 0) / count
  const centerY = ys.reduce((sum, y) => sum + y, 0) / count
  const outerRadii = new Array<number>(12).fill(0)
  for (let index = 0; index < count; index += 1) {
    const x = xs[index] - centerX
    const y = ys[index] - centerY
    const sector = Math.min(11, Math.floor((Math.atan2(y, x) + Math.PI) / (Math.PI * 2) * 12))
    outerRadii[sector] = Math.max(outerRadii[sector], Math.hypot(x, y))
  }
  assert.ok(Math.min(...outerRadii) / Math.max(...outerRadii) > 0.78, 'the round outline must extend in every direction, not just match width and height')

  const nearest = xs.map((x, index) => Math.sqrt(Math.min(...xs.map((otherX, other) => (
    index === other ? Infinity : (x - otherX) ** 2 + (ys[index] - ys[other]) ** 2
  ))))).sort((a, b) => a - b)
  const neighborDistance = nearest[Math.floor(count / 2)] * 3
  const visited = new Set([0])
  const queue = [0]
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head]
    for (let other = 0; other < count; other += 1) {
      if (!visited.has(other) && Math.hypot(xs[index] - xs[other], ys[index] - ys[other]) <= neighborDistance) {
        visited.add(other)
        queue.push(other)
      }
    }
  }
  assert.equal(visited.size, count, `all points should share one visual field at 3x typical spacing (${neighborDistance})`)
}

describe('progressive graph layout engine', () => {
  it('seeds a high-degree hub as a compact area instead of an oversized empty ring', () => {
    const graph = makeMixedGraph([400], 0)
    const positions = snapshotGraphPositions(createGraphSimulation(graph.nodes, graph.edges))
    const radii = graph.nodes.slice(1).map((_, index) => Math.hypot(
      positions[(index + 1) * 2] - positions[0], positions[(index + 1) * 2 + 1] - positions[1],
    )).sort((a, b) => a - b)
    assert.ok(radii.at(-1)! < Math.sqrt(400) * 60, `hub extent must be area based (${radii.at(-1)})`)
    assert.ok(radii[100] < radii[399] * 0.75, 'children must occupy the interior, not a single empty ring')
  })

  it('keeps large hubs, small relationship groups and isolated nodes in one round field', () => {
    const graph = makeMixedGraph()
    const state = createGraphSimulation(graph.nodes, graph.edges)
    assertCohesiveField(snapshotGraphPositions(state))
    stepGraphSimulation(state, 360)
    assertCohesiveField(snapshotGraphPositions(state))
  })

  it('keeps an entirely unlinked workspace in the same round field', () => {
    const graph = makeMixedGraph([], 240)
    const state = createGraphSimulation(graph.nodes, graph.edges)
    stepGraphSimulation(state, 360)
    assertCohesiveField(snapshotGraphPositions(state))
  })

  it('restores prior positions by identity when refreshed nodes arrive in a different order', () => {
    const graph = makeMixedGraph([12, 8], 20)
    const original = createGraphSimulation(graph.nodes, graph.edges)
    stepGraphSimulation(original, 360)
    const prior = new Map(graph.nodes.map((node, index) => [node.id, {
      x: original.positions[index * 2], y: original.positions[index * 2 + 1],
    }]))
    const reversed = [...graph.nodes].reverse()
    reversed.push({ id: 'new', type: 'doc', label: 'New document' })
    const refreshed = createGraphSimulation(reversed, graph.edges, prior)
    reversed.slice(0, -1).forEach((node, index) => {
      assert.equal(refreshed.positions[index * 2], prior.get(node.id)!.x)
      assert.equal(refreshed.positions[index * 2 + 1], prior.get(node.id)!.y)
    })
    assert.ok(refreshed.positions.every(Number.isFinite), 'new nodes receive valid positions without resetting existing nodes')
  })

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

  it('keeps local relationship groups recognizable inside the shared field', () => {
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

    const distance = (a: number, b: number) => Math.hypot(
      positions[a * 2] - positions[b * 2], positions[a * 2 + 1] - positions[b * 2 + 1],
    )
    const closerToOwnHub = nodes.filter((node, index) => {
      if (node.type === 'tag') return false
      const ownHub = index < 13 ? 0 : 13
      const otherHub = index < 13 ? 13 : 0
      return distance(index, ownHub) < distance(index, otherHub)
    }).length
    assert.ok(closerToOwnHub >= 22, `at least 90% of leaves should remain closer to their own hub (${closerToOwnHub}/24)`)
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
