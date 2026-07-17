export type EbookReaderState = {
  path: string
  size: number
  modifiedTime: number
  fraction?: number
  index?: number
  updatedAt: number
}

export class EbookReadingStateWriter {
  private latest: EbookReaderState | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly write: (state: EbookReaderState) => void,
    private readonly delayMs = 500,
  ) {}

  queue(state: EbookReaderState): void {
    this.latest = state
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.delayMs)
  }

  flush(): boolean {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.latest) return false
    const state = this.latest
    this.latest = null
    this.write(state)
    return true
  }
}
