import { MemoryRepository } from '../../repositories/memory-repository'

export interface MaintenanceResult {
  archivedL1Count: number
  archivedL2Count: number
  prunedCount: number
  optimizedTriggers: number
  timestamp: string
}

export interface MemoryLifecycleConfig {
  l1ExpiryDays: number // Default: 30 days
  l2ExpiryDays: number // Default: 90 days
  archivalRetentionDays: number // Default: 365 days
  maintenanceIntervalMs: number // Default: 6 hours
  minAccessCountForL2: number // Default: 3
}

const DEFAULT_CONFIG: MemoryLifecycleConfig = {
  l1ExpiryDays: 30,
  l2ExpiryDays: 90,
  archivalRetentionDays: 365,
  maintenanceIntervalMs: 6 * 60 * 60 * 1000, // 6 hours
  minAccessCountForL2: 3,
}

export class MemoryLifecycleManager {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private lastMaintenanceAt: Date | null = null

  constructor(
    private readonly memoryRepository: MemoryRepository,
    private readonly config: Partial<MemoryLifecycleConfig> = {}
  ) {}

  private getConfig(): MemoryLifecycleConfig {
    return { ...DEFAULT_CONFIG, ...this.config }
  }

  start(): void {
    if (this.running) return
    this.running = true

    const config = this.getConfig()
    this.timer = setInterval(() => {
      void this.runMaintenance()
    }, config.maintenanceIntervalMs)

    // Run initial maintenance after 1 minute
    setTimeout(() => {
      void this.runMaintenance()
    }, 60_000)

    console.log('[MemoryLifecycleManager] Started with config:', config)
  }

  stop(): void {
    if (!this.running) return
    this.running = false

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    console.log('[MemoryLifecycleManager] Stopped')
  }

  async runMaintenance(): Promise<MaintenanceResult> {
    if (!this.running) {
      throw new Error('MemoryLifecycleManager is not running')
    }

    const config = this.getConfig()
    const now = new Date()

    console.log('[MemoryLifecycleManager] Running maintenance...')

    // 1. Archive expired L1 memories (30 days by default)
    const archivedL1Count = await this.archiveOldL1Memories(config.l1ExpiryDays)

    // 2. Archive low-access L2 memories (90 days by default)
    const archivedL2Count = await this.archiveOldL2Memories(config.l2ExpiryDays, config.minAccessCountForL2)

    // 3. Prune old archived memories (365 days by default)
    const prunedCount = await this.memoryRepository.pruneArchivedMemories(config.archivalRetentionDays)

    // 4. Optimize trigger priorities based on hit rates
    const optimizedTriggers = await this.optimizeTriggerPriorities()

    this.lastMaintenanceAt = now

    const result: MaintenanceResult = {
      archivedL1Count,
      archivedL2Count,
      prunedCount,
      optimizedTriggers,
      timestamp: now.toISOString(),
    }

    console.log('[MemoryLifecycleManager] Maintenance complete:', result)

    return result
  }

  getLastMaintenanceAt(): Date | null {
    return this.lastMaintenanceAt
  }

  isRunning(): boolean {
    return this.running
  }

  // ============================================================
  // Private Maintenance Operations
  // ============================================================

  private async archiveOldL1Memories(expiryDays: number): Promise<number> {
    const cutoffTime = Math.floor(Date.now() / 1000) - (expiryDays * 86400)

    // Find L1 memories older than cutoff that haven't been accessed recently
    const oldMemories = await this.memoryRepository.queryMemories({
      layer: 'l1',
      includeArchived: false,
    })

    let archivedCount = 0
    for (const memory of oldMemories) {
      const lastAccess = memory.lastAccessedAt || memory.createdAt
      if (lastAccess < cutoffTime) {
        await this.memoryRepository.archiveMemory(memory.id)
        archivedCount++
      }
    }

    return archivedCount
  }

  private async archiveOldL2Memories(expiryDays: number, minAccessCount: number): Promise<number> {
    const cutoffTime = Math.floor(Date.now() / 1000) - (expiryDays * 86400)

    // Find L2 memories older than cutoff with low access counts
    const oldMemories = await this.memoryRepository.queryMemories({
      layer: 'l2',
      includeArchived: false,
    })

    let archivedCount = 0
    for (const memory of oldMemories) {
      const lastAccess = memory.lastAccessedAt || memory.createdAt
      const shouldArchive = lastAccess < cutoffTime && memory.accessCount < minAccessCount

      if (shouldArchive) {
        await this.memoryRepository.archiveMemory(memory.id)
        archivedCount++
      }
    }

    return archivedCount
  }

  private async optimizeTriggerPriorities(): Promise<number> {
    const triggers = await this.memoryRepository.listTriggers({ enabled: true })

    // Sort triggers by hit count
    const sortedTriggers = [...triggers].sort((a, b) => b.hitCount - a.hitCount)

    let optimizedCount = 0
    for (let i = 0; i < sortedTriggers.length; i++) {
      const trigger = sortedTriggers[i]
      const newPriority = Math.max(0, sortedTriggers.length - i - 1)

      if (trigger.priority !== newPriority) {
        await this.memoryRepository.updateTrigger(trigger.id, { priority: newPriority })
        optimizedCount++
      }
    }

    return optimizedCount
  }
}
