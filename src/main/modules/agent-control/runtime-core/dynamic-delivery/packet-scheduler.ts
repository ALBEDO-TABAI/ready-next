import {
  createParallelBranchOrchestrator,
  PARALLEL_BRANCH_HARD_CAP,
  type ParallelBranchOrchestrator,
} from '../parallel-branch-orchestrator'

export type DeliveryScheduledResult =
  | { packageId: string; status: 'fulfilled'; value: unknown }
  | { packageId: string; status: 'failed'; reason: unknown }
  | { packageId: string; status: 'capacity_exceeded'; reason: 'delivery_scheduler_capacity_exceeded' }

export class DynamicDeliveryPacketScheduler {
  private readonly orchestrator: ParallelBranchOrchestrator
  private readonly packageByBranch = new Map<string, string>()
  private readonly immediate: DeliveryScheduledResult[] = []

  constructor(orchestrator: ParallelBranchOrchestrator = createParallelBranchOrchestrator()) {
    this.orchestrator = orchestrator
  }

  schedule(packageId: string, run: (signal: AbortSignal) => Promise<unknown>): void {
    const branch = this.orchestrator.spawn(`dynamic-delivery:${packageId}`, run)
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
