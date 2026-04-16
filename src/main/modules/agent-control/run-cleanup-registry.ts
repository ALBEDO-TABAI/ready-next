export type RunCleanupCallback = () => void | Promise<void>

interface RunCleanupEntry {
  callback: RunCleanupCallback
  drained: boolean
}

export class RunCleanupRegistry {
  private readonly entries = new Map<string, RunCleanupEntry[]>()

  register(runId: string, cleanup: RunCleanupCallback): void {
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedRunId) return
    const nextEntries = this.entries.get(normalizedRunId) || []
    nextEntries.push({ callback: cleanup, drained: false })
    this.entries.set(normalizedRunId, nextEntries)
  }

  async drain(runId: string, timeoutMs = 1_500): Promise<void> {
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedRunId) return
    const runEntries = this.entries.get(normalizedRunId)
    if (!runEntries || runEntries.length === 0) return

    const pending = runEntries.map(async (entry) => {
      if (entry.drained) return
      entry.drained = true
      await Promise.resolve(entry.callback())
    })

    await Promise.race([
      Promise.allSettled(pending).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(100, timeoutMs))),
    ])
    this.entries.delete(normalizedRunId)
  }
}
