export class DeliveryOutputBuffer {
  private chunks: string[] = []
  private released = false

  append(delta: string): void {
    if (this.released) throw new Error('[dynamic-delivery] output buffer already released')
    if (delta) this.chunks.push(delta)
  }

  snapshot(): string {
    return this.chunks.join('')
  }

  replace(text: string): void {
    if (this.released) throw new Error('[dynamic-delivery] output buffer already released')
    this.chunks = text ? [text] : []
  }

  releaseAccepted(): string {
    if (this.released) throw new Error('[dynamic-delivery] output buffer already released')
    this.released = true
    return this.snapshot()
  }

  discard(): void {
    if (this.released) throw new Error('[dynamic-delivery] output buffer already released')
    this.chunks = []
    this.released = true
  }
}
