import type { AgentInputItem, MemorySession } from '@openai/agents'

import type { CollaborationDecision, DeliveryStateV1 } from '../../../../../shared/dynamic-delivery'
import type { WorkerReport } from '../../quality/worker-report'
import type { RunUsage } from '../run-usage-accumulator'
import { RunUsageAccumulator } from '../run-usage-accumulator'
import type { CandidateSessionTransaction } from './candidate-session-fork'
import type { DeliveryOutputBuffer } from './delivery-output-buffer'
import type { VerifierResourceBundle } from './verifier-resource-bundle'

export interface DeliveryRunContext {
  runId: string
  taskId: string
  userRequestVerbatim: string
  decision: CollaborationDecision
  state: DeliveryStateV1
  committedSession: MemorySession
  ownerSession: MemorySession
  transaction: CandidateSessionTransaction | null
  outputBuffer: DeliveryOutputBuffer | null
  workerReports: WorkerReport[]
  usage: RunUsageAccumulator
  canonicalReceiptItems: AgentInputItem[]
  evidenceResources: VerifierResourceBundle['items']
}

export class DeliveryRunContextStore {
  private readonly contexts = new Map<string, DeliveryRunContext>()

  create(context: Omit<DeliveryRunContext, 'usage'>): DeliveryRunContext {
    if (this.contexts.has(context.runId)) throw new Error('[dynamic-delivery] duplicate run context')
    const value = { ...context, usage: new RunUsageAccumulator() }
    this.contexts.set(context.runId, value)
    return value
  }

  get(runId: string): DeliveryRunContext | null {
    return this.contexts.get(runId) ?? null
  }

  addUsage(runId: string, usage: Parameters<RunUsageAccumulator['add']>[0]): RunUsage | null {
    return this.get(runId)?.usage.add(usage) ?? null
  }

  snapshotUsage(runId: string): RunUsage | null {
    return this.get(runId)?.usage.snapshot() ?? null
  }

  close(runId: string): void {
    this.contexts.delete(runId)
  }
}
