import type { ReadyMemoryGenerationCoordinator } from './ready-memory-generation'
import type { DatabaseConnection } from '../../database/connection'

export function isReadyMemoryProductionIdle(db: DatabaseConnection): boolean {
  return !db.prepare(`
    SELECT 1 AS active FROM codex_turn_bindings turn
    JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
    JOIN run_meta run ON run.run_id = turn.ready_run_id
    JOIN task_projections projection
      ON projection.task_id = turn.ready_task_id AND projection.run_id = turn.ready_run_id
    WHERE thread.retired_at IS NULL
      AND turn.product_terminal_digest IS NULL
      AND turn.host_failure_product_terminal_digest IS NULL
      AND run.status = 'running'
      AND projection.status IN ('queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked')
    LIMIT 1
  `).get()
}

export class ReadyMemoryIdleWorker {
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private running = false

  constructor(private readonly dependencies: {
    coordinator: Pick<ReadyMemoryGenerationCoordinator, 'runOnce'>
    now?: () => string
    intervalMs?: number
    onError?: (error: unknown) => void
  }) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(0)
  }

  wake(): void {
    if (!this.running || this.inFlight) return
    if (this.timer) clearTimeout(this.timer)
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.inFlight
  }

  private schedule(delay: number): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      this.timer = null
      const run = this.dependencies.coordinator.runOnce(
        this.dependencies.now?.() || new Date().toISOString(),
      ).then((result) => {
        this.schedule(['disabled', 'busy', 'idle'].includes(result.kind)
          ? this.dependencies.intervalMs || 30_000
          : 100)
      }).catch((error) => {
        this.dependencies.onError?.(error)
        this.schedule(this.dependencies.intervalMs || 30_000)
      }).finally(() => {
        if (this.inFlight === run) this.inFlight = null
      })
      this.inFlight = run
    }, delay)
    this.timer.unref?.()
  }
}
