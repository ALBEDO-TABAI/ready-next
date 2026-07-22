export interface RunUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 最后一次 provider 请求的实报 input；累加时保留最新值，不参与求和。 */
  lastRequestInputTokens?: number
  usageSource: 'provider' | 'estimated' | 'missing'
  providerCallCount: number
  missingCallCount: number
}

function finiteNonNegative(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0
}

export function addRunUsage(
  current: Omit<RunUsage, 'usageSource' | 'providerCallCount' | 'missingCallCount'> & Partial<Pick<RunUsage, 'usageSource' | 'providerCallCount' | 'missingCallCount'>> | null | undefined,
  next: Omit<RunUsage, 'usageSource' | 'providerCallCount' | 'missingCallCount'> | null | undefined,
): RunUsage {
  if (!next) {
    return {
      inputTokens: current?.inputTokens ?? 0,
      outputTokens: current?.outputTokens ?? 0,
      totalTokens: current?.totalTokens ?? 0,
      ...(current?.lastRequestInputTokens !== undefined
        ? { lastRequestInputTokens: current.lastRequestInputTokens }
        : {}),
      usageSource: current?.usageSource === 'provider' ? 'provider' : 'missing',
      providerCallCount: current?.providerCallCount ?? 0,
      missingCallCount: (current?.missingCallCount ?? 0) + 1,
    }
  }
  const inputTokens = finiteNonNegative(next.inputTokens)
  const outputTokens = finiteNonNegative(next.outputTokens)
  const reportedTotal = finiteNonNegative(next.totalTokens)
  const totalTokens = reportedTotal || inputTokens + outputTokens
  const lastRequestInputTokens = next.lastRequestInputTokens ?? current?.lastRequestInputTokens
  return {
    inputTokens: (current?.inputTokens ?? 0) + inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + outputTokens,
    totalTokens: (current?.totalTokens ?? 0) + totalTokens,
    ...(lastRequestInputTokens !== undefined ? { lastRequestInputTokens } : {}),
    usageSource: 'provider',
    providerCallCount: (current?.providerCallCount ?? 0) + 1,
    missingCallCount: current?.missingCallCount ?? 0,
  }
}

export function mergeRunUsage(
  current: RunUsage | null | undefined,
  next: RunUsage | null | undefined,
): RunUsage | null {
  if (!current) return next ? { ...next } : null
  if (!next) return { ...current }
  const lastRequestInputTokens = next.lastRequestInputTokens ?? current.lastRequestInputTokens
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    ...(lastRequestInputTokens !== undefined ? { lastRequestInputTokens } : {}),
    usageSource: current.usageSource === 'provider' || next.usageSource === 'provider'
      ? 'provider'
      : current.usageSource === 'estimated' || next.usageSource === 'estimated'
        ? 'estimated'
        : 'missing',
    providerCallCount: current.providerCallCount + next.providerCallCount,
    missingCallCount: current.missingCallCount + next.missingCallCount,
  }
}

export class RunUsageAccumulator {
  private total: RunUsage | null = null

  add(usage: Omit<RunUsage, 'usageSource' | 'providerCallCount' | 'missingCallCount'> | null | undefined): RunUsage {
    this.total = addRunUsage(this.total, usage)
    return this.snapshot()!
  }

  snapshot(): RunUsage | null {
    return this.total ? { ...this.total } : null
  }
}
