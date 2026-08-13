export type InteractionDisposition = 'resume_with_result' | 'checkpoint' | 'terminate'

export const __breaksInvariants = ['interaction lifecycle singleton state'] as const

export interface InteractionLifecycleIdentity {
  interactionId: string
  runId: string
  agentId: string
  scopeId: string
  type: 'ask_user' | 'ask_user_questions' | 'action_confirmation' | 'browser_confirmation' | 'page_challenge' | 'handoff' | 'human_takeover'
}

export interface InteractionLifecycleEvent extends InteractionLifecycleIdentity {
  phase: 'suspended' | 'resumed' | 'checkpointed' | 'terminated'
  pendingCount: number
}

interface InteractionRecord extends InteractionLifecycleIdentity {
  state: 'pending' | 'settled' | 'cancelled'
  disposition: InteractionDisposition | null
  timeoutHandle: NodeJS.Timeout | null
}

function runKey(input: Pick<InteractionLifecycleIdentity, 'runId' | 'agentId' | 'scopeId'>): string {
  return `${input.agentId}\u0000${input.scopeId}\u0000${input.runId}`
}

const TERMINAL_INTERACTION_TOMBSTONE_LIMIT = 2_048

export class InteractionLifecycleRegistry {
  private readonly records = new Map<string, InteractionRecord>()
  private readonly terminalInteractionIds = new Set<string>()
  private readonly listeners = new Set<(event: InteractionLifecycleEvent) => void>()

  subscribe(listener: (event: InteractionLifecycleEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(record: InteractionRecord, phase: InteractionLifecycleEvent['phase']): void {
    const event: InteractionLifecycleEvent = {
      interactionId: record.interactionId,
      runId: record.runId,
      agentId: record.agentId,
      scopeId: record.scopeId,
      type: record.type,
      phase,
      pendingCount: this.pendingCount(record),
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[InteractionLifecycleRegistry] listener failed:', error)
      }
    }
  }

  register(input: InteractionLifecycleIdentity & {
    timeoutMs?: number
    timeoutDisposition?: InteractionDisposition
  }): boolean {
    if (!input.interactionId || !input.runId || !input.agentId || !input.scopeId) return false
    if (this.records.has(input.interactionId) || this.terminalInteractionIds.has(input.interactionId)) return false
    const record: InteractionRecord = { ...input, state: 'pending', disposition: null, timeoutHandle: null }
    this.records.set(input.interactionId, record)
    if (Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0) {
      record.timeoutHandle = setTimeout(() => {
        this.settle({
          interactionId: record.interactionId,
          runId: record.runId,
          agentId: record.agentId,
          scopeId: record.scopeId,
          disposition: input.timeoutDisposition || 'terminate',
        })
      }, Number(input.timeoutMs))
      record.timeoutHandle.unref?.()
    }
    this.emit(record, 'suspended')
    return true
  }

  settle(input: {
    interactionId: string
    runId: string
    agentId: string
    scopeId: string
    disposition: InteractionDisposition
  }): boolean {
    const record = this.records.get(input.interactionId)
    if (
      !record
      || record.state !== 'pending'
      || record.runId !== input.runId
      || record.agentId !== input.agentId
      || record.scopeId !== input.scopeId
    ) return false
    if (record.timeoutHandle) clearTimeout(record.timeoutHandle)
    record.timeoutHandle = null
    record.state = 'settled'
    record.disposition = input.disposition

    if (input.disposition === 'terminate' || input.disposition === 'checkpoint') {
      for (const candidate of [...this.records.values()]) {
        if (candidate.state === 'pending' && runKey(candidate) === runKey(record)) {
          if (candidate.timeoutHandle) clearTimeout(candidate.timeoutHandle)
          candidate.timeoutHandle = null
          candidate.state = 'cancelled'
          this.retire(candidate)
        }
      }
      this.retire(record)
      this.emit(record, input.disposition === 'terminate' ? 'terminated' : 'checkpointed')
      return true
    }
    this.retire(record)
    if (this.pendingCount(record) === 0) this.emit(record, 'resumed')
    return true
  }

  hasPending(input: { runId: string; agentId: string; scopeId: string }): boolean {
    return this.pendingCount(input) > 0
  }

  cancelScope(scopeId: string): number {
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId) return 0
    const representatives = new Map<string, InteractionRecord>()
    let cancelled = 0
    for (const record of [...this.records.values()]) {
      if (record.scopeId !== normalizedScopeId || record.state !== 'pending') continue
      if (record.timeoutHandle) clearTimeout(record.timeoutHandle)
      record.timeoutHandle = null
      record.state = 'cancelled'
      representatives.set(runKey(record), record)
      this.retire(record)
      cancelled += 1
    }
    for (const record of representatives.values()) this.emit(record, 'terminated')
    return cancelled
  }

  private pendingCount(input: { runId: string; agentId: string; scopeId: string }): number {
    const key = runKey(input)
    let count = 0
    for (const record of this.records.values()) {
      if (record.state === 'pending' && runKey(record) === key) count += 1
    }
    return count
  }

  private retire(record: InteractionRecord): void {
    this.records.delete(record.interactionId)
    if (this.terminalInteractionIds.size >= TERMINAL_INTERACTION_TOMBSTONE_LIMIT) {
      const oldest = this.terminalInteractionIds.values().next().value
      if (typeof oldest === 'string') this.terminalInteractionIds.delete(oldest)
    }
    this.terminalInteractionIds.add(record.interactionId)
  }

  clear(): void {
    for (const record of this.records.values()) {
      if (record.timeoutHandle) clearTimeout(record.timeoutHandle)
    }
    this.records.clear()
    this.terminalInteractionIds.clear()
  }
}

let sharedRegistry: InteractionLifecycleRegistry | null = null

export function getInteractionLifecycleRegistry(): InteractionLifecycleRegistry {
  if (!sharedRegistry) sharedRegistry = new InteractionLifecycleRegistry()
  return sharedRegistry
}

export function __resetInteractionLifecycleRegistryForTests(): void {
  sharedRegistry = new InteractionLifecycleRegistry()
}
