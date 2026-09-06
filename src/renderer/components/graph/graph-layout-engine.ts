import type { GraphEdge, GraphNode } from './graph-types'
import { buildGraphTopology } from './graph-topology'

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const CELL_SIZE = 84
const REPULSION_RADIUS = 224
const REPULSION_RADIUS_SQUARED = REPULSION_RADIUS * REPULSION_RADIUS
const MIN_NODE_DISTANCE = 48
const NODE_SEED_SPACING = 29
const COMPONENT_CLEARANCE = 12
const DRAG_PROXIMITY_RADIUS = 72
const DRAG_PROXIMITY_RADIUS_SQUARED = DRAG_PROXIMITY_RADIUS * DRAG_PROXIMITY_RADIUS
const CHARGE_BASE = 760

// Short leaf links preserve local relationship groups inside the shared field.
function edgeIdealLength(degreeA: number, degreeB: number): number {
  const low = Math.min(degreeA, degreeB)
  const high = Math.max(degreeA, degreeB)
  if (low <= 1) return 56 + Math.min(24, Math.sqrt(high) * 3)
  return 92 + Math.min(92, Math.log2(low * high + 1) * 10)
}

// Hubs need a little more room than leaves to keep their connections readable.
function chargeScaleFor(degree: number): number {
  return Math.sqrt(1 + Math.min(2.6, Math.log2(degree + 1) * 0.5))
}

export interface GraphSimulationState {
  readonly nodes: GraphNode[]
  readonly indexById: Map<string, number>
  readonly edgePairs: Int32Array
  readonly edgeLengths: Float64Array
  readonly degrees: Uint32Array
  readonly chargeScale: Float64Array
  readonly positions: Float64Array
  readonly velocities: Float64Array
  readonly pinned: Float64Array
  readonly dragInfluence: Float64Array
  readonly interactionMask: Uint8Array
  activeDragIndex: number
  interactionActive: boolean
  interactionNodeCount: number
  alpha: number
  settledFrames: number
  ticksSinceReheat: number
}

export interface GraphSimulationStep {
  moved: number
  pairChecks: number
  settled: boolean
}

export function graphSimulationCadence(nodeCount: number): { iterations: number; delayMs: number } {
  if (nodeCount > 1000) return { iterations: 1, delayMs: 10 }
  if (nodeCount > 320) return { iterations: 2, delayMs: 10 }
  return { iterations: 4, delayMs: 12 }
}

interface GraphComponent {
  indices: number[]
  radius: number
  x: number
  y: number
}

function collectGraphComponents(
  nodes: GraphNode[],
  edgePairs: Int32Array,
): GraphComponent[] {
  const parents = Int32Array.from({ length: nodes.length }, (_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parents[root] !== root) root = parents[root]
    while (parents[index] !== index) {
      const next = parents[index]
      parents[index] = root
      index = next
    }
    return root
  }
  for (let pair = 0; pair < edgePairs.length; pair += 2) {
    const sourceRoot = find(edgePairs[pair])
    const targetRoot = find(edgePairs[pair + 1])
    if (sourceRoot !== targetRoot) parents[targetRoot] = sourceRoot
  }
  const membersByRoot = new Map<number, number[]>()
  for (let index = 0; index < nodes.length; index += 1) {
    const root = find(index)
    const members = membersByRoot.get(root)
    if (members) members.push(index)
    else membersByRoot.set(root, [index])
  }
  const components = [...membersByRoot.values()].map((indices): GraphComponent => (
    { indices, radius: 0, x: 0, y: 0 }
  ))
  components.sort((left, right) => {
    if (left.indices.length !== right.indices.length) return right.indices.length - left.indices.length
    return nodes[left.indices[0]].id.localeCompare(nodes[right.indices[0]].id)
  })
  return components
}

// Seed each connected group into an area, not a circumference. Its extent grows
// with sqrt(node count), including a hub with hundreds of leaves.
function seedComponentRelative(
  nodes: GraphNode[],
  degrees: Uint32Array,
  members: number[],
  relativeX: Float64Array,
  relativeY: Float64Array,
): number {
  const ordered = [...members].sort((left, right) => (
    degrees[right] - degrees[left] || nodes[left].id.localeCompare(nodes[right].id)
  ))
  const rotation = idRotation(nodes[ordered[0]].id)
  for (const [rank, index] of ordered.entries()) {
    const angle = rotation + rank * GOLDEN_ANGLE
    const radius = Math.sqrt(rank) * NODE_SEED_SPACING
    relativeX[index] = Math.cos(angle) * radius
    relativeY[index] = Math.sin(angle) * radius
  }
  return Math.sqrt(members.length - 1) * NODE_SEED_SPACING
}

function placeConnectedComponents(components: GraphComponent[]): void {
  const placed: GraphComponent[] = []
  let previousRadius = -1
  let rank = 0
  for (const component of components) {
    if (component.indices.length === 1) continue
    // Components are sorted by size. Previously rejected positions stay blocked
    // for the next equally sized group, so do not scan them again.
    if (component.radius !== previousRadius) rank = 0
    previousRadius = component.radius
    while (true) {
      const angle = rank * GOLDEN_ANGLE
      const radius = Math.sqrt(rank) * NODE_SEED_SPACING
      rank += 1
      component.x = Math.cos(angle) * radius
      component.y = Math.sin(angle) * radius
      if (placed.every((other) => (
        Math.hypot(component.x - other.x, component.y - other.y)
          >= component.radius + other.radius + COMPONENT_CLEARANCE
      ))) break
    }
    placed.push(component)
  }
}

function placeIsolatedComponents(components: GraphComponent[]): void {
  const connected = components.filter((component) => component.indices.length > 1)
  const isolated = components.filter((component) => component.indices.length === 1)
  let candidateRank = 0
  for (const component of isolated) {
    while (true) {
      const angle = candidateRank * GOLDEN_ANGLE
      const radius = Math.sqrt(candidateRank) * NODE_SEED_SPACING
      candidateRank += 1
      const x = Math.cos(angle) * radius
      const y = Math.sin(angle) * radius
      const overlapsRelationshipIsland = connected.some((candidate) => {
        const clearance = candidate.radius + COMPONENT_CLEARANCE
        const dx = x - candidate.x
        const dy = y - candidate.y
        return dx * dx + dy * dy < clearance * clearance
      })
      if (overlapsRelationshipIsland) continue
      component.x = x
      component.y = y
      break
    }
  }
}

function idRotation(id: string): number {
  let hash = 2166136261
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return ((hash >>> 0) / 0xffffffff) * Math.PI * 2
}

function seedComponentPositions(
  nodes: GraphNode[],
  edgePairs: Int32Array,
  degrees: Uint32Array,
  prior?: Float32Array | ReadonlyMap<string, { x: number; y: number }>,
): Float64Array {
  const positions = new Float64Array(nodes.length * 2)
  const relativeX = new Float64Array(nodes.length)
  const relativeY = new Float64Array(nodes.length)
  const components = collectGraphComponents(nodes, edgePairs)
  for (const component of components) {
    if (component.indices.length === 1) continue
    component.radius = seedComponentRelative(nodes, degrees, component.indices, relativeX, relativeY)
  }
  placeConnectedComponents(components)
  placeIsolatedComponents(components)

  for (const component of components) {
    for (const index of component.indices) {
      const localX = relativeX[index]
      const localY = relativeY[index]
      const previous = prior instanceof Float32Array
        ? { x: prior[index * 2], y: prior[index * 2 + 1] }
        : prior?.get(nodes[index].id)
      positions[index * 2] = previous && Number.isFinite(previous.x) ? previous.x : component.x + localX
      positions[index * 2 + 1] = previous && Number.isFinite(previous.y) ? previous.y : component.y + localY
    }
  }
  return positions
}

export function createGraphSimulation(
  nodes: GraphNode[],
  edges: GraphEdge[],
  prior?: Float32Array | ReadonlyMap<string, { x: number; y: number }>,
): GraphSimulationState {
  const copiedNodes = nodes.map((node) => ({ ...node }))
  const { edgePairs, degrees, indexById } = buildGraphTopology(copiedNodes, edges)
  const edgeLengths = new Float64Array(edgePairs.length / 2)
  for (let pair = 0; pair < edgePairs.length; pair += 2) {
    edgeLengths[pair / 2] = edgeIdealLength(degrees[edgePairs[pair]], degrees[edgePairs[pair + 1]])
  }
  const chargeScale = Float64Array.from(degrees, chargeScaleFor)
  const positions = seedComponentPositions(copiedNodes, edgePairs, degrees, prior)
  const pinned = new Float64Array(copiedNodes.length * 2)
  pinned.fill(Number.NaN)
  return {
    nodes: copiedNodes,
    edgePairs,
    edgeLengths,
    degrees,
    chargeScale,
    indexById,
    positions,
    velocities: new Float64Array(copiedNodes.length * 2),
    pinned,
    dragInfluence: new Float64Array(copiedNodes.length),
    interactionMask: new Uint8Array(copiedNodes.length),
    activeDragIndex: -1,
    interactionActive: false,
    interactionNodeCount: 0,
    alpha: copiedNodes.length > 0 ? 1 : 0,
    settledFrames: 0,
    ticksSinceReheat: 0,
  }
}

// Integer grid key: string keys allocate on every lookup and dominate tick cost
// once layouts spread over many cells. ±32768 cells covers ±2.7M world px.
function cellKey(x: number, y: number): number {
  return (Math.floor(x / CELL_SIZE) + 0x8000) * 0x10000 + (Math.floor(y / CELL_SIZE) + 0x8000)
}

function packedCellKey(cellX: number, cellY: number): number {
  return (cellX + 0x8000) * 0x10000 + (cellY + 0x8000)
}

function expandDragProximity(state: GraphSimulationState, grid: Map<number, number[]>): void {
  if (!state.interactionActive || state.activeDragIndex < 0) return
  const cellRange = Math.ceil(DRAG_PROXIMITY_RADIUS / CELL_SIZE)
  for (let index = 0; index < state.nodes.length; index += 1) {
    if (state.interactionMask[index] !== 1 || state.dragInfluence[index] < 0.2) continue
    const x = state.positions[index * 2]
    const y = state.positions[index * 2 + 1]
    const cellX = Math.floor(x / CELL_SIZE)
    const cellY = Math.floor(y / CELL_SIZE)
    for (let dxCell = -cellRange; dxCell <= cellRange; dxCell += 1) {
      for (let dyCell = -cellRange; dyCell <= cellRange; dyCell += 1) {
        const candidates = grid.get(packedCellKey(cellX + dxCell, cellY + dyCell))
        if (!candidates) continue
        for (const other of candidates) {
          if (state.interactionMask[other] !== 0) continue
          const dx = x - state.positions[other * 2]
          const dy = y - state.positions[other * 2 + 1]
          if (dx * dx + dy * dy >= DRAG_PROXIMITY_RADIUS_SQUARED) continue
          state.interactionMask[other] = 2
          state.dragInfluence[other] = 0.12
          state.interactionNodeCount += 1
        }
      }
    }
  }
}

function activateDragNeighborhood(state: GraphSimulationState, index: number): void {
  if (state.activeDragIndex === index) return
  state.activeDragIndex = index
  state.interactionActive = true
  state.dragInfluence.fill(0)
  state.interactionMask.fill(0)
  state.dragInfluence[index] = 1
  state.interactionMask[index] = 1
  let frontier = new Set([index])
  for (const influence of [0.62, 0.24]) {
    const next = new Set<number>()
    for (let pair = 0; pair < state.edgePairs.length; pair += 2) {
      const source = state.edgePairs[pair]
      const target = state.edgePairs[pair + 1]
      if (frontier.has(source) && state.dragInfluence[target] === 0) next.add(target)
      if (frontier.has(target) && state.dragInfluence[source] === 0) next.add(source)
    }
    for (const neighbour of next) {
      state.dragInfluence[neighbour] = Math.max(state.dragInfluence[neighbour], influence)
      state.interactionMask[neighbour] = 1
    }
    frontier = next
    if (frontier.size === 0) break
  }
  state.interactionNodeCount = state.interactionMask.reduce((count, value) => count + value, 0)
}

function singleSimulationTick(state: GraphSimulationState): { moved: number; pairChecks: number } {
  const count = state.nodes.length
  const { positions, velocities, pinned, degrees, chargeScale, edgeLengths, dragInfluence, interactionMask } = state
  const alpha = state.alpha
  const grid = new Map<number, number[]>()
  for (let index = 0; index < count; index += 1) {
    const key = cellKey(positions[index * 2], positions[index * 2 + 1])
    const occupants = grid.get(key)
    if (occupants) occupants.push(index)
    else grid.set(key, [index])
  }
  expandDragProximity(state, grid)

  let pairChecks = 0
  const cellRange = Math.ceil(REPULSION_RADIUS / CELL_SIZE)
  for (let index = 0; index < count; index += 1) {
    const offset = index * 2
    const x = positions[offset]
    const y = positions[offset + 1]
    const cellX = Math.floor(x / CELL_SIZE)
    const cellY = Math.floor(y / CELL_SIZE)
    for (let dxCell = -cellRange; dxCell <= cellRange; dxCell += 1) {
      for (let dyCell = -cellRange; dyCell <= cellRange; dyCell += 1) {
        const candidates = grid.get(packedCellKey(cellX + dxCell, cellY + dyCell))
        if (!candidates) continue
        for (const other of candidates) {
          if (other <= index) continue
          if (state.interactionActive && interactionMask[index] === 0 && interactionMask[other] === 0) continue
          pairChecks += 1
          const otherOffset = other * 2
          let dx = x - positions[otherOffset]
          let dy = y - positions[otherOffset + 1]
          let distanceSquared = dx * dx + dy * dy
          if (distanceSquared >= REPULSION_RADIUS_SQUARED) continue
          if (distanceSquared < 0.01) {
            dx = index % 2 === 0 ? 0.1 : -0.1
            dy = other % 2 === 0 ? -0.1 : 0.1
            distanceSquared = dx * dx + dy * dy
          }
          const distance = Math.sqrt(distanceSquared)
          const collisionDistance = MIN_NODE_DISTANCE + Math.min(18, Math.log2(degrees[index] + degrees[other] + 1) * 3)
          const chargeForce = ((CHARGE_BASE * chargeScale[index] * chargeScale[other]) / distanceSquared) * alpha
          const collisionForce = Math.max(0, collisionDistance - distance) * 0.032 * Math.max(alpha, 0.18)
          const force = Math.min(3.8, chargeForce + collisionForce)
          const forceX = (dx / distance) * force
          const forceY = (dy / distance) * force
          if (!state.interactionActive || interactionMask[index] !== 0) {
            velocities[offset] += forceX
            velocities[offset + 1] += forceY
          }
          if (!state.interactionActive || interactionMask[other] !== 0) {
            velocities[otherOffset] -= forceX
            velocities[otherOffset + 1] -= forceY
          }
        }
      }
    }
  }

  for (let pair = 0; pair < state.edgePairs.length; pair += 2) {
    const source = state.edgePairs[pair]
    const target = state.edgePairs[pair + 1]
    if (state.interactionActive && interactionMask[source] === 0 && interactionMask[target] === 0) continue
    const sourceOffset = source * 2
    const targetOffset = target * 2
    const dx = positions[targetOffset] - positions[sourceOffset]
    const dy = positions[targetOffset + 1] - positions[sourceOffset + 1]
    const distance = Math.max(0.001, Math.hypot(dx, dy))
    const idealLength = edgeLengths[pair / 2]
    const localInfluence = Math.max(dragInfluence[source], dragInfluence[target])
    const force = (distance - idealLength) * (0.013 + localInfluence * 0.026) * alpha
    const forceX = (dx / distance) * force
    const forceY = (dy / distance) * force
    if (!state.interactionActive || interactionMask[source] !== 0) {
      velocities[sourceOffset] += forceX
      velocities[sourceOffset + 1] += forceY
    }
    if (!state.interactionActive || interactionMask[target] !== 0) {
      velocities[targetOffset] -= forceX
      velocities[targetOffset + 1] -= forceY
    }
  }

  let moved = 0
  for (let index = 0; index < count; index += 1) {
    const offset = index * 2
    if (state.interactionActive && interactionMask[index] === 0) {
      velocities[offset] = 0
      velocities[offset + 1] = 0
      continue
    }
    if (Number.isFinite(pinned[offset])) {
      positions[offset] = pinned[offset]
      positions[offset + 1] = pinned[offset + 1]
      velocities[offset] = 0
      velocities[offset + 1] = 0
      continue
    }

    const localInfluence = dragInfluence[index]
    // One shared center allows disconnected groups and unlinked documents to
    // settle together; no node is pulled back to a private component territory.
    const centerStrength = 0.002
    const centerScale = state.activeDragIndex >= 0
      ? 1 - localInfluence * 0.72
      : 1 + localInfluence * 0.3
    velocities[offset] += -positions[offset] * centerStrength * centerScale * alpha
    velocities[offset + 1] += -positions[offset + 1] * centerStrength * centerScale * alpha
    const damping = 0.82 + localInfluence * 0.05
    velocities[offset] *= damping
    velocities[offset + 1] *= damping

    const velocity = Math.hypot(velocities[offset], velocities[offset + 1])
    if (velocity > 0.005) moved += 1
    const velocityScale = velocity > 18 ? 18 / velocity : 1
    positions[offset] += velocities[offset] * velocityScale
    positions[offset + 1] += velocities[offset + 1] * velocityScale
  }


  if (state.interactionActive && state.activeDragIndex < 0) {
    for (let index = 0; index < dragInfluence.length; index += 1) {
      dragInfluence[index] = dragInfluence[index] < 0.001 ? 0 : dragInfluence[index] * 0.91
    }
  }

  state.alpha = Math.max(0.006, alpha * 0.986)
  state.ticksSinceReheat += 1
  return { moved, pairChecks }
}

export function stepGraphSimulation(state: GraphSimulationState, iterations = 1): GraphSimulationStep {
  if (state.nodes.length === 0) return { moved: 0, pairChecks: 0, settled: true }
  let moved = 0
  let pairChecks = 0
  const steps = Math.max(1, Math.floor(iterations))
  for (let step = 0; step < steps; step += 1) {
    const result = singleSimulationTick(state)
    moved = result.moved
    pairChecks += result.pairChecks
  }
  const movingNodeCount = state.interactionActive ? state.interactionNodeCount : state.nodes.length
  if (moved < Math.max(1, movingNodeCount * 0.012) && state.alpha < 0.08) state.settledFrames += 1
  else state.settledFrames = 0
  const settled = state.settledFrames >= 4 || state.ticksSinceReheat >= 360
  if (settled && state.interactionActive && state.activeDragIndex < 0) {
    state.interactionActive = false
    state.interactionNodeCount = 0
    state.interactionMask.fill(0)
    state.dragInfluence.fill(0)
  }
  return {
    moved,
    pairChecks,
    settled,
  }
}

export function snapshotGraphPositions(state: GraphSimulationState): Float32Array {
  return Float32Array.from(state.positions)
}

export function pinGraphSimulationNode(
  state: GraphSimulationState,
  id: string,
  x: number,
  y: number,
): boolean {
  const index = state.indexById.get(id)
  if (index === undefined) return false
  const offset = index * 2
  activateDragNeighborhood(state, index)
  state.pinned[offset] = x
  state.pinned[offset + 1] = y
  state.positions[offset] = x
  state.positions[offset + 1] = y
  state.velocities[offset] = 0
  state.velocities[offset + 1] = 0
  state.alpha = Math.max(state.alpha, 0.45)
  state.settledFrames = 0
  state.ticksSinceReheat = 0
  return true
}

export function releaseGraphSimulationNode(state: GraphSimulationState, id: string): boolean {
  const index = state.indexById.get(id)
  if (index === undefined) return false
  const offset = index * 2
  state.pinned[offset] = Number.NaN
  state.pinned[offset + 1] = Number.NaN
  state.activeDragIndex = -1
  state.alpha = Math.max(state.alpha, 0.52)
  state.settledFrames = 0
  state.ticksSinceReheat = 0
  return true
}
