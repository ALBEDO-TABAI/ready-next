import {
  createGraphSimulation,
  snapshotGraphPositions,
  stepGraphSimulation,
} from './graph-layout-engine'
import type { GraphData, GraphQuery, GraphViewState } from './graph-types'

interface GraphLayoutWorkerLike {
  onmessage: ((event: MessageEvent<GraphLayoutWorkerMessage>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage: (message: unknown) => void
  terminate: () => void
}

interface GraphLayoutWorkerMessage {
  type: 'positions'
  revision: number
  positions: Float32Array
  settled: boolean
}

interface GraphSessionRuntime {
  createWorker: () => GraphLayoutWorkerLike | null
  requestFrame: ((callback: FrameRequestCallback) => number) | null
  cancelFrame: ((handle: number) => void) | null
  onIdle: () => void
}

export type GraphDataFetcher = (query: GraphQuery) => Promise<GraphData>

export interface GraphSessionSnapshot {
  graph: GraphData
  positions: Float32Array
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  settled: boolean
  revision: number
}

const EMPTY_GRAPH: GraphData = {
  nodes: [],
  edges: [],
  totalDocs: 0,
  truncated: false,
}

function normalizeRoot(root: string): string {
  const normalized = root.trim().replace(/[\\/]+$/, '')
  return normalized || root.trim()
}

function canonicalQuery(query: GraphQuery): GraphQuery {
  const centerPath = query.centerPath || undefined
  return {
    workspaceRoot: normalizeRoot(query.workspaceRoot),
    centerPath,
    depth: centerPath ? Math.max(1, Math.floor(query.depth ?? 2)) : undefined,
  }
}

function queryKey(query: GraphQuery): string {
  const normalized = canonicalQuery(query)
  return JSON.stringify([normalized.workspaceRoot, normalized.centerPath ?? null, normalized.depth ?? null])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultCreateWorker(): GraphLayoutWorkerLike | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./graph-layout.worker.ts', import.meta.url), { type: 'module' }) as GraphLayoutWorkerLike
  } catch {
    return null
  }
}

export class GraphSession {
  readonly query: GraphQuery

  private readonly listeners = new Set<() => void>()
  private readonly viewStates = new Map<string, GraphViewState>()
  private readonly runtime: GraphSessionRuntime
  private worker: GraphLayoutWorkerLike | null | undefined
  private pendingWorkerMessage: GraphLayoutWorkerMessage | null = null
  private workerFrameHandle: number | null = null
  private latestFetcher: GraphDataFetcher | null = null
  private requestGeneration = 0
  private stale = false
  private disposed = false
  private snapshot: GraphSessionSnapshot = {
    graph: EMPTY_GRAPH,
    positions: new Float32Array(),
    status: 'idle',
    error: null,
    settled: true,
    revision: 0,
  }

  constructor(query: GraphQuery, runtime: GraphSessionRuntime) {
    this.query = canonicalQuery(query)
    this.runtime = runtime
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.runtime.onIdle()
    }
  }

  getSnapshot = (): GraphSessionSnapshot => this.snapshot

  isActive(): boolean {
    return this.listeners.size > 0
  }

  private updateSnapshot(patch: Partial<GraphSessionSnapshot>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private ensureWorker(): GraphLayoutWorkerLike | null {
    if (this.worker !== undefined) return this.worker
    this.worker = this.runtime.createWorker()
    if (!this.worker) return null
    this.worker.onmessage = (event) => {
      const message = event.data
      if (message.type !== 'positions' || message.revision !== this.snapshot.revision) return
      this.queueWorkerMessage(message)
    }
    this.worker.onerror = () => { this.disableWorker() }
    return this.worker
  }

  private queueWorkerMessage(message: GraphLayoutWorkerMessage): void {
    if (!this.runtime.requestFrame) {
      this.updateSnapshot({ positions: message.positions, settled: message.settled })
      return
    }
    this.pendingWorkerMessage = message
    if (this.workerFrameHandle !== null) return
    this.workerFrameHandle = this.runtime.requestFrame(() => {
      this.workerFrameHandle = null
      const pending = this.pendingWorkerMessage
      this.pendingWorkerMessage = null
      if (!pending || pending.revision !== this.snapshot.revision) return
      this.updateSnapshot({ positions: pending.positions, settled: pending.settled })
    })
  }

  private disableWorker(): void {
    const worker = this.worker
    this.worker = null
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
    if (this.workerFrameHandle !== null) this.runtime.cancelFrame?.(this.workerFrameHandle)
    this.workerFrameHandle = null
    const pending = this.pendingWorkerMessage
    this.pendingWorkerMessage = null
    this.updateSnapshot({
      ...(pending?.revision === this.snapshot.revision ? { positions: pending.positions } : {}),
      settled: true,
    })
  }

  private postWorkerMessage(message: unknown): boolean {
    if (!this.worker) return false
    try {
      this.worker.postMessage(message)
      return true
    } catch {
      this.disableWorker()
      return false
    }
  }

  async ensureLoaded(fetcher: GraphDataFetcher): Promise<void> {
    this.latestFetcher = fetcher
    if (!this.stale && (this.snapshot.status === 'ready' || this.snapshot.status === 'loading')) return
    await this.load(fetcher)
  }

  async refresh(fetcher: GraphDataFetcher = this.latestFetcher as GraphDataFetcher): Promise<void> {
    if (!fetcher) return
    this.latestFetcher = fetcher
    await this.load(fetcher)
  }

  private async load(fetcher: GraphDataFetcher): Promise<void> {
    const generation = ++this.requestGeneration
    this.updateSnapshot({ status: 'loading', error: null })
    try {
      const graph = await fetcher(this.query)
      if (generation !== this.requestGeneration) return
      this.stale = false
      this.applyGraph(graph)
    } catch (error) {
      if (generation !== this.requestGeneration) return
      const hasGraph = this.snapshot.graph.nodes.length > 0
      this.updateSnapshot({
        status: hasGraph ? 'ready' : 'error',
        error: errorMessage(error),
        settled: true,
      })
    }
  }

  private applyGraph(graph: GraphData): void {
    const prior = new Map<string, { x: number; y: number }>()
    for (let index = 0; index < this.snapshot.graph.nodes.length; index += 1) {
      const x = this.snapshot.positions[index * 2]
      const y = this.snapshot.positions[index * 2 + 1]
      if (Number.isFinite(x) && Number.isFinite(y)) prior.set(this.snapshot.graph.nodes[index].id, { x, y })
    }
    const simulation = createGraphSimulation(graph.nodes, graph.edges, prior)
    const worker = graph.nodes.length > 0 ? this.ensureWorker() : null
    if (!worker && graph.nodes.length <= 320) stepGraphSimulation(simulation, 8)
    const positions = snapshotGraphPositions(simulation)
    const revision = this.snapshot.revision + 1
    this.updateSnapshot({
      graph,
      positions,
      status: 'ready',
      error: null,
      settled: graph.nodes.length === 0 || !worker,
      revision,
    })
    if (worker) this.postWorkerMessage({
      type: 'initialize',
      revision,
      nodes: graph.nodes,
      edges: graph.edges,
      positions,
    })
  }

  invalidate(): Promise<void> {
    this.stale = true
    if (this.listeners.size > 0 && this.latestFetcher) return this.refresh(this.latestFetcher)
    return Promise.resolve()
  }

  getViewState(viewId: string): GraphViewState | null {
    const state = this.viewStates.get(viewId)
    return state ? { viewport: { ...state.viewport }, userAdjusted: state.userAdjusted } : null
  }

  setViewState(viewId: string, state: GraphViewState): void {
    this.viewStates.set(viewId, { viewport: { ...state.viewport }, userAdjusted: state.userAdjusted })
  }

  pinNode(id: string, x: number, y: number): void {
    const index = this.snapshot.graph.nodes.findIndex((node) => node.id === id)
    if (index < 0) return
    const positions = this.snapshot.positions.slice()
    positions[index * 2] = x
    positions[index * 2 + 1] = y
    const hasWorker = Boolean(this.worker)
    this.updateSnapshot({ positions, settled: !hasWorker })
    if (hasWorker) this.postWorkerMessage({ type: 'pin', revision: this.snapshot.revision, id, x, y })
  }

  releaseNode(id: string): void {
    if (!this.postWorkerMessage({ type: 'release', revision: this.snapshot.revision, id })) {
      this.updateSnapshot({ settled: true })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.requestGeneration += 1
    if (this.workerFrameHandle !== null) this.runtime.cancelFrame?.(this.workerFrameHandle)
    this.workerFrameHandle = null
    this.pendingWorkerMessage = null
    const worker = this.worker
    this.worker = null
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
    this.listeners.clear()
  }
}

export class GraphSessionRegistry {
  private readonly sessions = new Map<string, GraphSession>()
  private readonly createWorker: () => GraphLayoutWorkerLike | null
  private readonly requestFrame: ((callback: FrameRequestCallback) => number) | null
  private readonly cancelFrame: ((handle: number) => void) | null

  constructor(options: {
    createWorker?: () => GraphLayoutWorkerLike | null
    requestFrame?: ((callback: FrameRequestCallback) => number) | null
    cancelFrame?: ((handle: number) => void) | null
  } = {}) {
    this.createWorker = options.createWorker ?? defaultCreateWorker
    this.requestFrame = options.requestFrame === undefined
      ? (typeof globalThis.requestAnimationFrame === 'function'
          ? globalThis.requestAnimationFrame.bind(globalThis)
          : null)
      : options.requestFrame
    this.cancelFrame = options.cancelFrame === undefined
      ? (typeof globalThis.cancelAnimationFrame === 'function'
          ? globalThis.cancelAnimationFrame.bind(globalThis)
          : null)
      : options.cancelFrame
  }

  get(query: GraphQuery): GraphSession {
    const key = queryKey(query)
    const existing = this.sessions.get(key)
    if (existing) {
      this.sessions.delete(key)
      this.sessions.set(key, existing)
      return existing
    }
    const session = new GraphSession(query, {
      createWorker: this.createWorker,
      requestFrame: this.requestFrame,
      cancelFrame: this.cancelFrame,
      onIdle: () => { this.pruneIdleSessions() },
    })
    this.sessions.set(key, session)
    this.pruneIdleSessions()
    return session
  }

  private pruneIdleSessions(): void {
    this.pruneIdleGroup((session) => Boolean(session.query.centerPath), 8)
    this.pruneIdleGroup((session) => !session.query.centerPath, 3)
  }

  private pruneIdleGroup(predicate: (session: GraphSession) => boolean, maximum: number): void {
    const idle = [...this.sessions.entries()]
      .filter(([, session]) => predicate(session) && !session.isActive())
    const removeCount = Math.max(0, idle.length - maximum)
    for (let index = 0; index < removeCount; index += 1) {
      const [key, session] = idle[index]
      this.sessions.delete(key)
      session.dispose()
    }
  }

  async invalidateWorkspace(workspaceRoot: string): Promise<void> {
    const normalizedRoot = normalizeRoot(workspaceRoot)
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.query.workspaceRoot === normalizedRoot)
        .map((session) => session.invalidate()),
    )
  }
}

export const graphSessionRegistry = new GraphSessionRegistry()

export function invalidateGraphWorkspace(workspaceRoot: string): Promise<void> {
  return graphSessionRegistry.invalidateWorkspace(workspaceRoot)
}
