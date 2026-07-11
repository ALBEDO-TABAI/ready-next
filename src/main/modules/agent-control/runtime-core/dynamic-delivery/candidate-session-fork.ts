import { MemorySession, type AgentInputItem } from '@openai/agents'

function cloneItems(items: readonly AgentInputItem[]): AgentInputItem[] {
  return structuredClone(items) as AgentInputItem[]
}

export class CandidateSessionTransaction {
  readonly workingSession: MemorySession
  private closed = false

  private constructor(
    private readonly committedSession: MemorySession,
    private readonly committedBase: AgentInputItem[],
    sessionId: string,
  ) {
    this.workingSession = new MemorySession({
      sessionId,
      initialItems: cloneItems(committedBase),
    })
  }

  static async create(committedSession: MemorySession, sessionId: string): Promise<CandidateSessionTransaction> {
    const base = await committedSession.getItems()
    return new CandidateSessionTransaction(committedSession, cloneItems(base), sessionId)
  }

  buildSanitizedCheckpoint(canonicalReceiptItems: readonly AgentInputItem[] = []): AgentInputItem[] {
    return cloneItems([...this.committedBase, ...canonicalReceiptItems])
  }

  async collectCanonicalReceiptItems(): Promise<AgentInputItem[]> {
    const working = await this.workingSession.getItems()
    const receiptTypes = new Set([
      'function_call', 'function_call_result', 'computer_call', 'computer_call_result', 'hosted_tool_call',
    ])
    return cloneItems(working.slice(this.committedBase.length).filter((item) =>
      receiptTypes.has(String((item as { type?: unknown }).type)),
    ))
  }

  async collectAcceptedInputItems(): Promise<AgentInputItem[]> {
    const working = await this.workingSession.getItems()
    const receiptTypes = new Set([
      'function_call', 'function_call_result', 'computer_call', 'computer_call_result', 'hosted_tool_call',
    ])
    return cloneItems(working.slice(this.committedBase.length).filter((item) =>
      (item as { role?: unknown }).role === 'user'
      || receiptTypes.has(String((item as { type?: unknown }).type)),
    ))
  }

  async commitAccepted(acceptedItems?: readonly AgentInputItem[]): Promise<AgentInputItem[]> {
    if (this.closed) throw new Error('[dynamic-delivery] candidate transaction is already closed')
    const working = await this.workingSession.getItems()
    if (working.length < this.committedBase.length) {
      throw new Error('[dynamic-delivery] working session lost committed base items')
    }
    const prefix = working.slice(0, this.committedBase.length)
    if (JSON.stringify(prefix) !== JSON.stringify(this.committedBase)) {
      throw new Error('[dynamic-delivery] working session mutated committed base items')
    }
    const acceptedDelta = acceptedItems
      ? cloneItems(acceptedItems)
      : cloneItems(working.slice(this.committedBase.length))
    if (acceptedDelta.length > 0) await this.committedSession.addItems(acceptedDelta)
    this.closed = true
    return acceptedDelta
  }

  abortCandidate(): void {
    if (this.closed) throw new Error('[dynamic-delivery] candidate transaction is already closed')
    this.closed = true
  }
}
