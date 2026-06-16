import type { BrowserTaskProjectionSink } from '../browser-engine/content-task-runner'
import type { AgentControlRuntime } from '../agent-control/runtime-core/runtime'
import type { TaskProjectionRecord } from '../agent-control/contracts/run-contracts'

const NOTE_COLLECT_TERMINAL_DWELL_MS = 30_000

interface CollectionProjectionContribution {
  discovered: number
  saved: number
  failed: number
  completedSourceIds: string[]
  failedSourceIds: string[]
}

interface CollectionProjectionAggregate {
  discovered: number
  userExpectedTotal: number
  contributions: Map<string, CollectionProjectionContribution>
}

export function makeNoteCollectProjectionSink(activeRuntime: AgentControlRuntime): BrowserTaskProjectionSink {
  const aggregates = new Map<string, CollectionProjectionAggregate>()

  const progressDetail = (input: {
    total?: number
    completed?: number
    failed?: number
    discovered?: number
    saved?: number
    remaining?: number
    userExpectedTotal?: number
  }): string => {
    const discovered = Math.max(0, Number(input.discovered ?? input.total ?? 0) || 0)
    const saved = Math.max(0, Number(input.saved ?? input.completed ?? 0) || 0)
    const failed = Math.max(0, Number(input.failed ?? 0) || 0)
    const remaining = Math.max(0, Number(input.remaining ?? Math.max(0, discovered - saved - failed)) || 0)
    const expected = Math.max(0, Number(input.userExpectedTotal ?? 0) || 0)
    return [
      `发现 ${discovered}${expected > 0 ? `/${expected}` : ''}`,
      `保存 ${saved}`,
      failed > 0 ? `失败 ${failed}` : null,
      `剩余 ${remaining}`,
    ].filter(Boolean).join(' · ')
  }

  const updateAggregate = (input: {
    taskId: string
    sourceTaskId?: string
    total?: number
    completed?: number
    failed?: number
    discovered?: number
    saved?: number
    userExpectedTotal?: number
    completedSourceIds?: string[]
    failedSourceIds?: string[]
  }, existing?: TaskProjectionRecord | null): { discovered: number; saved: number; failed: number; effectiveTotal: number; remaining: number; userExpectedTotal: number } => {
    const projectionTaskId = input.sourceTaskId || input.taskId
    const aggregate = aggregates.get(projectionTaskId) || {
      discovered: Math.max(0, Number(existing?.progress?.total ?? 0) || 0),
      userExpectedTotal: 0,
      contributions: new Map<string, CollectionProjectionContribution>(),
    }
    const discovered = Math.max(
      aggregate.discovered,
      Math.max(0, Number(input.discovered ?? input.total ?? 0) || 0),
    )
    const userExpectedTotal = Math.max(
      aggregate.userExpectedTotal,
      Math.max(0, Number(input.userExpectedTotal ?? 0) || 0),
    )
    aggregate.discovered = discovered
    aggregate.userExpectedTotal = userExpectedTotal
    if (input.sourceTaskId) {
      aggregate.contributions.set(input.taskId, {
        discovered: Math.max(0, Number(input.total ?? input.discovered ?? 0) || 0),
        saved: Math.max(0, Number(input.saved ?? input.completed ?? 0) || 0),
        failed: Math.max(0, Number(input.failed ?? 0) || 0),
        completedSourceIds: Array.from(new Set((input.completedSourceIds || []).map((id) => String(id).trim()).filter(Boolean))),
        failedSourceIds: Array.from(new Set((input.failedSourceIds || []).map((id) => String(id).trim()).filter(Boolean))),
      })
    }
    aggregates.set(projectionTaskId, aggregate)
    const savedSourceIds = new Set<string>()
    const failedSourceIds = new Set<string>()
    let savedWithoutSourceId = 0
    let failedWithoutSourceId = 0
    for (const item of aggregate.contributions.values()) {
      for (const sourceId of item.completedSourceIds) savedSourceIds.add(sourceId)
      for (const sourceId of item.failedSourceIds) failedSourceIds.add(sourceId)
      savedWithoutSourceId += Math.max(0, item.saved - item.completedSourceIds.length)
      failedWithoutSourceId += Math.max(0, item.failed - item.failedSourceIds.length)
    }
    const rawSaved = savedSourceIds.size + savedWithoutSourceId
    const saved = discovered > 0 ? Math.min(discovered, rawSaved) : rawSaved
    let failedSourceIdCount = 0
    for (const sourceId of failedSourceIds) {
      if (!savedSourceIds.has(sourceId)) failedSourceIdCount += 1
    }
    const rawFailed = failedSourceIdCount + failedWithoutSourceId
    const failed = discovered > 0 ? Math.min(Math.max(0, discovered - saved), rawFailed) : rawFailed
    // EP2 dogfood follow-up — the user cares about the CLAIMED total: when a
    // page declares 72 and we discovered 53, the card must read 52/72 with
    // 剩余 including the 19 undiscovered, never 52/53 · 剩余 0.
    const effectiveTotal = userExpectedTotal > 0 ? Math.max(userExpectedTotal, discovered) : discovered
    return {
      discovered,
      saved,
      failed,
      effectiveTotal,
      remaining: Math.max(0, effectiveTotal - saved - failed),
      userExpectedTotal,
    }
  }

  const write = (
    input: {
      taskId: string
      sourceTaskId?: string
      scopeId: string
      title: string
      summary: string
      total?: number
      completed?: number
      failed?: number
      waitingFor?: 'background' | 'none' | 'verification'
      discovered?: number
      saved?: number
      remaining?: number
      userExpectedTotal?: number
      completedSourceIds?: string[]
      failedSourceIds?: string[]
      terminalDwell?: boolean
      canResume?: boolean
    },
    status: TaskProjectionRecord['status'],
    waitingFor: 'background' | 'none' | 'verification',
    createIfMissing: boolean,
  ): void => {
    const store = activeRuntime.getTaskProjectionStore()
    const projectionTaskId = input.sourceTaskId || input.taskId
    const existing = store.get(projectionTaskId)
    if (!existing && !createIfMissing) return
    const aggregate = updateAggregate(input, existing)
    const now = new Date().toISOString()
    const record: TaskProjectionRecord = {
      taskId: projectionTaskId,
      scopeId: input.scopeId,
      runId: input.taskId,
      taskType: 'multi_step_task',
      module: 'browser',
      taskTitle: input.title,
      taskSummary: input.summary,
      status,
      interactionState: waitingFor === 'background' ? 'running' : 'suspended',
      waitingFor,
      steps: [],
      progress: {
        stage: status,
        total: aggregate.effectiveTotal,
        completed: aggregate.saved,
        coverage: aggregate.effectiveTotal ? aggregate.saved / aggregate.effectiveTotal : null,
        fingerprint: null,
        updatedAt: now,
        lastError: status === 'failed' ? input.summary : null,
        detail: progressDetail({
          ...input,
          discovered: aggregate.discovered,
          saved: aggregate.saved,
          failed: aggregate.failed,
          remaining: aggregate.remaining,
          userExpectedTotal: aggregate.userExpectedTotal || input.userExpectedTotal,
        }),
      },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      canResume: input.canResume === true,
      resumableActions: input.canResume === true
        ? ['continue', 'cancel']
        : (status === 'running' ? ['cancel'] : ['none']),
    }
    if (existing) store.update(projectionTaskId, record)
    else store.create(record)
  }

  return {
    upsert(input): void {
      if (!input.scopeId) return
      // EP2 dogfood follow-up — progress-only refresh: keep the existing
      // status, just move the numbers (download write-back path).
      if (input.refreshOnly) {
        const store = activeRuntime.getTaskProjectionStore()
        const existing = store.get(input.sourceTaskId || input.taskId)
        if (!existing) return
        const unresolved = (Number(input.remaining ?? 0) || 0) > 0 || (Number(input.failed ?? 0) || 0) > 0
        write(
          input,
          unresolved ? 'recoverable_paused' : existing.status,
          unresolved ? 'none' : (existing.waitingFor === 'background' || existing.waitingFor === 'verification' ? existing.waitingFor : 'none') as 'background' | 'verification' | 'none',
          false,
        )
        return
      }
      if (input.state === 'running') {
        write(input, 'running', 'background', true)
        return
      }
      if (input.state === 'paused') {
        write(input, 'recoverable_paused', input.waitingFor === 'verification' ? 'verification' : 'none', true)
        return
      }
      const terminal: TaskProjectionRecord['status'] = input.state === 'completed'
        ? 'completed'
        : input.state === 'failed'
          ? 'failed'
          : 'killed'
      const existing = activeRuntime.getTaskProjectionStore().get(input.sourceTaskId || input.taskId)
      if (input.terminalDwell === false) {
        if (existing && (
          existing.status === 'queued'
          || existing.status === 'running'
          || existing.status === 'recoverable_paused'
          || existing.status === 'budget_paused'
          || existing.status === 'blocked'
        )) {
          write(input, terminal, 'none', false)
        }
        return
      }
      write(input, 'running', 'background', true)
      setTimeout(() => {
        write(input, terminal, 'none', false)
      }, NOTE_COLLECT_TERMINAL_DWELL_MS)
    },
  }
}
