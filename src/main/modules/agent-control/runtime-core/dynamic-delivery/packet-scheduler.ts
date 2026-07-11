import {
  createParallelBranchOrchestrator,
  PARALLEL_BRANCH_HARD_CAP,
  type ParallelBranchOrchestrator,
} from '../parallel-branch-orchestrator'
import { linkParentAbort } from '../../link-parent-abort'

export type DeliveryScheduledResult =
  | { packageId: string; status: 'fulfilled'; value: unknown }
  | { packageId: string; status: 'failed'; reason: unknown }
  | { packageId: string; status: 'capacity_exceeded'; reason: 'delivery_scheduler_capacity_exceeded' }

export class DynamicDeliveryPacketScheduler {
  private readonly orchestrator: ParallelBranchOrchestrator
  private readonly parentSignal: AbortSignal | null
  private readonly packageByBranch = new Map<string, string>()
  private readonly immediate: DeliveryScheduledResult[] = []

  constructor(options: {
    orchestrator?: ParallelBranchOrchestrator
    parentSignal?: AbortSignal | null
  } = {}) {
    this.orchestrator = options.orchestrator ?? createParallelBranchOrchestrator()
    this.parentSignal = options.parentSignal ?? null
  }

  schedule(packageId: string, run: (signal: AbortSignal) => Promise<unknown>): void {
    const branch = this.orchestrator.spawn(`dynamic-delivery:${packageId}`, async (branchSignal) => {
      const linkedController = new AbortController()
      const branchLink = linkParentAbort(branchSignal, linkedController)
      const parentLink = linkParentAbort(this.parentSignal, linkedController)
      try {
        if (linkedController.signal.aborted) {
          throw linkedController.signal.reason ?? new DOMException('aborted', 'AbortError')
        }
        return await run(linkedController.signal)
      } finally {
        parentLink.dispose()
        branchLink.dispose()
      }
    })
    if (!branch) {
      this.immediate.push({
        packageId,
        status: 'capacity_exceeded',
        reason: 'delivery_scheduler_capacity_exceeded',
      })
      return
    }
    this.packageByBranch.set(branch.id, packageId)
  }

  async awaitAll(): Promise<DeliveryScheduledResult[]> {
    const settled = await this.orchestrator.awaitAll()
    const results = settled.map((entry): DeliveryScheduledResult => {
      const packageId = this.packageByBranch.get(entry.branchId) ?? entry.branchId
      this.packageByBranch.delete(entry.branchId)
      if (this.parentSignal?.aborted) {
        return {
          packageId,
          status: 'failed',
          reason: this.parentSignal.reason ?? new DOMException('aborted', 'AbortError'),
        }
      }
      return entry.status === 'fulfilled'
        ? { packageId, status: 'fulfilled', value: entry.value }
        : { packageId, status: 'failed', reason: entry.reason }
    })
    return [...this.immediate.splice(0), ...results]
  }

  static hardCap(): number {
    return PARALLEL_BRANCH_HARD_CAP
  }
}
