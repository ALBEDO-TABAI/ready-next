import { MemorySession, type AgentInputItem } from '@openai/agents'

function cloneItems(items: readonly AgentInputItem[]): AgentInputItem[] {
  return structuredClone(items) as AgentInputItem[]
}

const CANONICAL_RECEIPT_TYPES = new Set([
  'function_call', 'function_call_result', 'computer_call', 'computer_call_result', 'hosted_tool_call',
])

function isCanonicalReceipt(item: AgentInputItem): boolean {
  return CANONICAL_RECEIPT_TYPES.has(String((item as { type?: unknown }).type))
}

export async function buildSanitizedCheckpointFromSession(input: {
  committedBase: readonly AgentInputItem[]
  workingSession: MemorySession
}): Promise<AgentInputItem[]> {
  const working = await input.workingSession.getItems()
  if (working.length < input.committedBase.length) {
    throw new Error('[dynamic-delivery] working session lost committed base items')
  }
  const prefix = working.slice(0, input.committedBase.length)
  if (JSON.stringify(prefix) !== JSON.stringify(input.committedBase)) {
    throw new Error('[dynamic-delivery] working session mutated committed base items')
  }
  return cloneItems([
    ...input.committedBase,
    ...working.slice(input.committedBase.length).filter(isCanonicalReceipt),
  ])
}

export class CandidateSessionTransaction {
  readonly workingSession: MemorySession
  private closed = false
  private preparedDelta: AgentInputItem[] | null = null

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
    return cloneItems(working.slice(this.committedBase.length).filter(isCanonicalReceipt))
  }

  async collectAcceptedInputItems(): Promise<AgentInputItem[]> {
    const working = await this.workingSession.getItems()
    return cloneItems(working.slice(this.committedBase.length).filter((item) =>
      (item as { role?: unknown }).role === 'user'
      || isCanonicalReceipt(item),
    ))
  }

  async collectAcceptedAssistantProviderData(): Promise<Record<string, unknown> | undefined> {
    const working = await this.workingSession.getItems()
    for (let index = working.length - 1; index >= this.committedBase.length; index -= 1) {
      const item = working[index] as AgentInputItem & {
        role?: unknown
        providerData?: unknown
      }
      if (item.role !== 'assistant') continue
      const providerData = item.providerData
      return providerData && typeof providerData === 'object' && !Array.isArray(providerData)
        ? structuredClone(providerData) as Record<string, unknown>
        : undefined
    }
    return undefined
  }

  async prepareAccepted(acceptedItems?: readonly AgentInputItem[]): Promise<AgentInputItem[]> {
    if (this.closed) throw new Error('[dynamic-delivery] candidate transaction is already closed')
    if (this.preparedDelta) throw new Error('[dynamic-delivery] candidate transaction is already prepared')
    const working = await this.workingSession.getItems()
    if (working.length < this.committedBase.length) {
      throw new Error('[dynamic-delivery] working session lost committed base items')
    }
    const prefix = working.slice(0, this.committedBase.length)
    if (JSON.stringify(prefix) !== JSON.stringify(this.committedBase)) {
      throw new Error('[dynamic-delivery] working session mutated committed base items')
    }
    this.preparedDelta = acceptedItems
      ? cloneItems(acceptedItems)
      : cloneItems(working.slice(this.committedBase.length))
    return cloneItems(this.preparedDelta)
  }

  async commitPrepared(): Promise<AgentInputItem[]> {
    if (this.closed) throw new Error('[dynamic-delivery] candidate transaction is already closed')
    if (!this.preparedDelta) throw new Error('[dynamic-delivery] candidate transaction is not prepared')
    const acceptedDelta = cloneItems(this.preparedDelta)
    if (acceptedDelta.length > 0) await this.committedSession.addItems(acceptedDelta)
    this.closed = true
    this.preparedDelta = null
    return acceptedDelta
  }

  inspectPrepared(): { committedBase: AgentInputItem[]; acceptedDelta: AgentInputItem[] } {
    if (this.closed) throw new Error('[dynamic-delivery] candidate transaction is already closed')
    if (!this.preparedDelta) throw new Error('[dynamic-delivery] candidate transaction is not prepared')
    return {
      committedBase: cloneItems(this.committedBase),
      acceptedDelta: cloneItems(this.preparedDelta),
    }
  }

  abortCandidate(): void {
    if (this.closed) throw new Error('[dynamic-delivery] candidate transaction is already closed')
    this.closed = true
    this.preparedDelta = null
  }
}
