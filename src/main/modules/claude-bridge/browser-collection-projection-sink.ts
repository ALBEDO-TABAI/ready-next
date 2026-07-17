import type { BrowserTaskProjectionInput, BrowserTaskProjectionSink } from '../browser-engine/content-task-runner'
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
    startedAt?: string | null
    finishedAt?: string | null
    outputRootDir?: string | null
  }): string => {
    const discovered = Math.max(0, Number(input.discovered ?? input.total ?? 0) || 0)
    const saved = Math.max(0, Number(input.saved ?? input.completed ?? 0) || 0)
    const failed = Math.max(0, Number(input.failed ?? 0) || 0)
    const remaining = Math.max(0, Number(input.remaining ?? Math.max(0, discovered - saved - failed)) || 0)
    const expected = Math.max(0, Number(input.userExpectedTotal ?? 0) || 0)
    const startedMs = input.startedAt ? new Date(input.startedAt).getTime() : NaN
    const finishedMs = input.finishedAt ? new Date(input.finishedAt).getTime() : Date.now()
    const durationMinutes = Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs
      ? Math.max(1, Math.round((finishedMs - startedMs) / 60_000))
      : null
    return [
      `发现 ${discovered}${expected > 0 ? `/${expected}` : ''}`,
      `保存 ${saved}`,
      failed > 0 ? `失败 ${failed}` : null,
      `剩余 ${remaining}`,
      durationMinutes ? `后台运行约 ${durationMinutes} 分钟` : null,
      input.outputRootDir ? `保存到 ${input.outputRootDir}` : null,
    ].filter(Boolean).join(' · ')
  }

  const collectionArtifacts = (
    input: BrowserTaskProjectionInput,
    existing?: TaskProjectionRecord | null,
  ): NonNullable<TaskProjectionRecord['recentArtifacts']> => {
    const now = new Date().toISOString()
    const entries = [
      input.outputRootDir ? { path: input.outputRootDir, kind: 'collection_output', label: '采集结果文件夹' } : null,
      input.reportPath ? { path: input.reportPath, kind: 'collection_report', label: '采集报告' } : null,
      input.manifestPath ? { path: input.manifestPath, kind: 'collection_manifest', label: '采集清单' } : null,
    ].filter((entry): entry is { path: string; kind: string; label: string } => Boolean(entry))
      .map((entry) => ({
        id: `${input.taskId}:${entry.kind}`,
        module: 'browser',
        ...entry,
        sourceRunId: input.ownerRunId || input.taskId,
        createdAt: now,
      }))
    const byPath = new Map<string, NonNullable<TaskProjectionRecord['recentArtifacts']>[number]>()
    for (const artifact of [...(existing?.recentArtifacts || []), ...entries]) {
      if (artifact.path) byPath.set(artifact.path, artifact)
    }
    return [...byPath.values()]
  }

  const buildContinuationRef = (
    input: { taskId: string; sourceTaskId?: string; canResume?: boolean },
    projectionTaskId: string,
  ): TaskProjectionRecord['continuationRef'] => {
    if (input.canResume !== true) return null
    const resumeTaskId = String(input.taskId || '').trim()
    if (!resumeTaskId.startsWith('browser-task-')) return null
    return {
      taskId: projectionTaskId,
      detachedTaskId: resumeTaskId,
      resumeKind: 'paused',
      action: 'browser_task',
    }
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
    aggregate.contributions.set(input.taskId, {
        discovered: Math.max(0, Number(input.total ?? input.discovered ?? 0) || 0),
        saved: Math.max(0, Number(input.saved ?? input.completed ?? 0) || 0),
        failed: Math.max(0, Number(input.failed ?? 0) || 0),
        completedSourceIds: Array.from(new Set((input.completedSourceIds || []).map((id) => String(id).trim()).filter(Boolean))),
        failedSourceIds: Array.from(new Set((input.failedSourceIds || []).map((id) => String(id).trim()).filter(Boolean))),
    })
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
    input: BrowserTaskProjectionInput,
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
      taskOrigin: existing?.taskOrigin ?? (input.ownerAgentId ? 'workflow_child' : 'system_background'),
      scopeId: input.scopeId,
      runId: input.executionBinding?.runId || input.ownerRunId || input.taskId,
      parentTaskId: input.parentTaskId ?? existing?.parentTaskId ?? null,
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
        detail: input.progressDetail || progressDetail({
          ...input,
          discovered: aggregate.discovered,
          saved: aggregate.saved,
          failed: aggregate.failed,
          remaining: aggregate.remaining,
          userExpectedTotal: aggregate.userExpectedTotal || input.userExpectedTotal,
        }),
      },
      continuationRef: buildContinuationRef(input, projectionTaskId),
      recentArtifacts: collectionArtifacts(input, existing),
      ownerAgentId: input.ownerAgentId ?? existing?.ownerAgentId ?? null,
      executionBinding: input.executionBinding ?? existing?.executionBinding ?? null,
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
    async resolveCollectionConsent(input): Promise<void> {
      const store = activeRuntime.getTaskProjectionStore()
      const existing = await store.get(input.sourceTaskId)
      if (!existing || existing.scopeId !== input.scopeId) return
      const now = new Date().toISOString()
      await store.update(input.sourceTaskId, {
        status: 'recoverable_paused',
        interactionState: 'suspended',
        waitingFor: 'none',
        blockedReason: null,
        progress: existing.progress
          ? {
              ...existing.progress,
              stage: 'consent_confirmed',
              fingerprint: input.requestId,
              updatedAt: now,
              detail: '用户已确认继续处理当前已发现的部分内容。',
              browserCollectionConsent: null,
            }
          : existing.progress,
        updatedAt: now,
      })
    },
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
        if (existing && (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'killed')) {
          const destinationSuffix = input.outputRootDir ? `保存到 ${input.outputRootDir}` : ''
          const currentDetail = String(existing.progress?.detail || '').trim()
          activeRuntime.getTaskProjectionStore().update(existing.taskId, {
            ...existing,
            recentArtifacts: collectionArtifacts(input, existing),
            ownerAgentId: input.ownerAgentId ?? existing.ownerAgentId ?? null,
            executionBinding: input.executionBinding ?? existing.executionBinding ?? null,
            parentTaskId: input.parentTaskId ?? existing.parentTaskId ?? null,
            progress: existing.progress
              ? {
                  ...existing.progress,
                  detail: destinationSuffix && !currentDetail.includes(destinationSuffix)
                    ? [currentDetail, destinationSuffix].filter(Boolean).join(' · ')
                    : existing.progress.detail,
                }
              : existing.progress,
          })
        } else write(input, terminal, 'none', true)
        return
      }
      write(input, 'running', 'background', true)
      const dwellTimer = setTimeout(() => {
        write(input, terminal, 'none', false)
      }, NOTE_COLLECT_TERMINAL_DWELL_MS)
      dwellTimer.unref?.()
    },
  }
}
