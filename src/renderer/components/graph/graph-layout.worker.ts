import {
  createGraphSimulation,
  graphSimulationCadence,
  pinGraphSimulationNode,
  releaseGraphSimulationNode,
  snapshotGraphPositions,
  stepGraphSimulation,
  type GraphSimulationState,
} from './graph-layout-engine'
import type { GraphEdge, GraphNode } from './graph-types'

type GraphLayoutWorkerRequest =
  | { type: 'initialize'; revision: number; nodes: GraphNode[]; edges: GraphEdge[]; positions: Float32Array }
  | { type: 'pin'; revision: number; id: string; x: number; y: number }
  | { type: 'release'; revision: number; id: string }

interface GraphLayoutWorkerResponse {
  type: 'positions'
  revision: number
  positions: Float32Array
  settled: boolean
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<GraphLayoutWorkerRequest>) => void) | null
  postMessage: (message: GraphLayoutWorkerResponse, transfer: Transferable[]) => void
}

let simulation: GraphSimulationState | null = null
let revision = 0
let loopToken = 0

function publish(settled: boolean): void {
  if (!simulation) return
  const positions = snapshotGraphPositions(simulation)
  scope.postMessage({ type: 'positions', revision, positions, settled }, [positions.buffer])
}

function startLoop(): void {
  const token = ++loopToken
  const frame = () => {
    if (token !== loopToken || !simulation) return
    const cadence = graphSimulationCadence(simulation.nodes.length)
    const result = stepGraphSimulation(simulation, cadence.iterations)
    publish(result.settled)
    if (!result.settled) setTimeout(frame, cadence.delayMs)
  }
  setTimeout(frame, 0)
}

scope.onmessage = (event) => {
  const message = event.data
  if (message.type === 'initialize') {
    revision = message.revision
    simulation = createGraphSimulation(message.nodes, message.edges, message.positions)
    publish(false)
    startLoop()
    return
  }
  if (!simulation || message.revision !== revision) return
  if (message.type === 'pin') {
    pinGraphSimulationNode(simulation, message.id, message.x, message.y)
    publish(false)
    startLoop()
    return
  }
  releaseGraphSimulationNode(simulation, message.id)
  startLoop()
}
