export interface RSSUpdateTaskStatus {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  sourceCount: number
  insertedCount: number
  errors: string[]
  digest: boolean
  message: string | null
}

const initialStatus: RSSUpdateTaskStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  sourceCount: 0,
  insertedCount: 0,
  errors: [],
  digest: false,
  message: null,
}

export class RSSUpdateLock {
  private runningPromise: Promise<{
    insertedCount: number
    errors: string[]
    sourceCount: number
    message: string
  }> | null = null

  private status: RSSUpdateTaskStatus = { ...initialStatus }

  isRunning(): boolean {
    return !!this.runningPromise
  }

  getStatus(): RSSUpdateTaskStatus {
    return { ...this.status, errors: [...this.status.errors] }
  }

  async run(
    opts: { digest: boolean },
    task: () => Promise<{
      insertedCount: number
      errors: string[]
      sourceCount: number
      message: string
    }>,
  ): Promise<
    | {
      skipped: true
      reason: 'running'
      status: RSSUpdateTaskStatus
    }
    | {
      skipped: false
      insertedCount: number
      errors: string[]
      sourceCount: number
      message: string
      status: RSSUpdateTaskStatus
    }
  > {
    if (this.runningPromise) {
      return {
        skipped: true,
        reason: 'running',
        status: this.getStatus(),
      }
    }

    const startedAt = new Date().toISOString()
    this.status = {
      ...this.status,
      running: true,
      startedAt,
      finishedAt: null,
      durationMs: null,
      sourceCount: 0,
      insertedCount: 0,
      errors: [],
      digest: opts.digest,
      message: '正在更新 RSS 源',
    }

    this.runningPromise = task()
    try {
      const result = await this.runningPromise
      const finishedAt = new Date().toISOString()
      const durationMs = Date.parse(finishedAt) - Date.parse(startedAt)
      this.status = {
        running: false,
        startedAt,
        finishedAt,
        durationMs,
        sourceCount: result.sourceCount,
        insertedCount: result.insertedCount,
        errors: result.errors,
        digest: opts.digest,
        message: result.message,
      }
      return {
        skipped: false,
        ...result,
        status: this.getStatus(),
      }
    } catch (error) {
      const finishedAt = new Date().toISOString()
      const durationMs = Date.parse(finishedAt) - Date.parse(startedAt)
      const message = error instanceof Error ? error.message : String(error)
      this.status = {
        running: false,
        startedAt,
        finishedAt,
        durationMs,
        sourceCount: 0,
        insertedCount: 0,
        errors: [message],
        digest: opts.digest,
        message,
      }
      throw error
    } finally {
      this.runningPromise = null
    }
  }

  reset(): void {
    this.runningPromise = null
    this.status = { ...initialStatus }
  }
}

export const rssUpdateLock = new RSSUpdateLock()
