import type { MapMetrics } from './types'
import { MapPlannerError } from './types'

type ApiCallKind = keyof MapMetrics['apiCalls']

export class AmapRateLimitedError extends Error {
  constructor(message = 'Amap rate limit exceeded') {
    super(message)
    this.name = 'AmapRateLimitedError'
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortSignal = signal
    if (abortSignal?.aborted) {
      reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Operation aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error('Operation aborted'))
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class MapRateLimiter {
  private tail = Promise.resolve()
  private requestCount = 0

  constructor(
    private readonly metrics: MapMetrics,
    private readonly options: { maxRequests?: number; signal?: AbortSignal } = {},
  ) {}

  async run<T>(kind: ApiCallKind, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release: () => void = () => {}
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await this.runWithRetries(kind, operation)
    } finally {
      release()
    }
  }

  private async runWithRetries<T>(kind: ApiCallKind, operation: () => Promise<T>): Promise<T> {
    const retryDelays = [500, 1500, 3500]
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      this.beforeRequest(kind)
      try {
        return await operation()
      } catch (error) {
        if (error instanceof AmapRateLimitedError && attempt >= retryDelays.length) {
          throw new MapPlannerError('amap_rate_limited', '高德地图请求被限流。请稍后重试或缩小搜索范围。')
        }
        if (!(error instanceof AmapRateLimitedError)) {
          throw error
        }
        await delay(retryDelays[attempt]!, this.options.signal)
      }
    }
    throw new MapPlannerError('amap_rate_limited', '高德地图请求被限流。请稍后重试或缩小搜索范围。')
  }

  private beforeRequest(kind: ApiCallKind): void {
    const maxRequests = this.options.maxRequests ?? 20
    if (this.requestCount >= maxRequests) {
      throw new MapPlannerError('amap_rate_limited', '已达到本次规划请求预算，缩小搜索范围后重试。')
    }
    this.requestCount += 1
    this.metrics.apiCalls[kind] += 1
  }
}
