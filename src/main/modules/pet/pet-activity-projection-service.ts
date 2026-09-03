import type { DatabaseConnection } from '../database'
import type { TaskProjectionRepository } from '../repositories/task-projection-repository'
import type { PetActivitySnapshot } from '../../../shared/pet'
import type { PetWindowManager } from './pet-window-manager'
import type { ScopeRunEventPayload } from '../agent-control/contracts/types'
import {
  isPetActivityAfterCutover,
  isPetTerminalActivityUnread,
  readPetActivityCutoverAt,
  readPetActivityMarker,
} from './pet-activity-read-marker'

type Candidate = {
  priority: number
  projection: ReturnType<TaskProjectionRepository['listRecentTasks']>[number]
  kind: PetActivitySnapshot['kind']
  messageId: string | null
}

type LiveNarration = {
  scopeId: string
  taskId: string
  runId: string
  text: string
  timestamp: string
}

export class PetActivityProjectionService {
  private revision = 0
  private lastDigest = ''
  private readonly liveNarrations = new Map<string, LiveNarration>()

  constructor(
    private readonly store: TaskProjectionRepository,
    private readonly db: DatabaseConnection,
    private readonly manager: PetWindowManager,
  ) {
    this.manager.setActivityRefresh(() => this.refresh())
  }

  observeScopeRunEvent(event: ScopeRunEventPayload): void {
    const scopeId = String(event.scopeId || '').trim()
    const taskId = String(event.taskId || '').trim()
    const runId = String(event.runId || '').trim()
    if (!scopeId || !taskId || !runId) {
      if (['done', 'error', 'cancelled'].includes(event.phase)) this.refresh()
      return
    }
    const key = this.liveNarrationKey(scopeId, taskId, runId)
    if (['done', 'error', 'cancelled'].includes(event.phase)) {
      this.liveNarrations.delete(key)
      this.refresh()
      return
    }
    const text = event.activityNarration?.text?.trim()
    if (!text) return
    const previous = this.liveNarrations.get(key)
    if (!previous || Date.parse(event.timestamp) >= Date.parse(previous.timestamp)) {
      this.liveNarrations.set(key, { scopeId, taskId, runId, text, timestamp: event.timestamp })
      while (this.liveNarrations.size > 100) {
        const oldest = this.liveNarrations.keys().next().value
        if (typeof oldest !== 'string') break
        this.liveNarrations.delete(oldest)
      }
    }
    this.refresh()
  }

  refresh(): void {
    const cutoverAt = readPetActivityCutoverAt(this.db)
    const candidates = this.store.listRecentTasks(100).flatMap((projection): Candidate[] => {
      const marker = readPetActivityMarker(this.db, projection.scopeId)
      if (!marker) return []
      if (['awaiting_clarification', 'awaiting_confirmation', 'human_takeover'].includes(projection.interactionState)) {
        return [{ priority: 5, projection, kind: 'needs_input', messageId: null }]
      }
      if (['blocked', 'recoverable_paused', 'budget_paused'].includes(projection.status)) {
        return isPetActivityAfterCutover(projection.updatedAt, cutoverAt)
          ? [{ priority: 4, projection, kind: 'blocked', messageId: null }]
          : []
      }
      if (projection.status === 'failed') {
        return isPetTerminalActivityUnread(projection.updatedAt, marker, cutoverAt)
          ? [{ priority: 4, projection, kind: 'blocked', messageId: null }]
          : []
      }
      if (projection.status === 'completed') {
        const messageId = this.latestVisibleAssistantMessage(projection.scopeId)
        return messageId && isPetTerminalActivityUnread(projection.updatedAt, marker, cutoverAt)
          ? [{ priority: 3, projection, kind: 'ready', messageId }]
          : []
      }
      if (projection.status === 'running' || projection.status === 'queued') {
        return [{ priority: 2, projection, kind: 'running', messageId: null }]
      }
      return []
    }).sort((left, right) => (
      right.priority - left.priority
      || Date.parse(right.projection.updatedAt) - Date.parse(left.projection.updatedAt)
    ))
    const candidate = candidates[0] || null
    const summary = candidate ? this.summaryFor(candidate) : ''
    const digest = candidate
      ? JSON.stringify({
          kind: candidate.kind,
          taskId: candidate.projection.taskId,
          runId: candidate.projection.runId,
          updatedAt: candidate.projection.updatedAt,
          messageId: candidate.messageId,
          summary,
        })
      : 'idle'
    if (digest === this.lastDigest) return
    this.lastDigest = digest
    this.revision += 1
    this.manager.updateActivity(candidate ? this.toSnapshot(candidate, summary) : {
      revision: this.revision,
      kind: 'idle',
      taskId: null,
      scopeId: null,
      runId: null,
      messageId: null,
      busy: false,
      state: 'idle',
      title: '空闲',
      summary: '',
      events: [],
      updatedAt: new Date().toISOString(),
    })
  }

  private toSnapshot(candidate: Candidate, summary: string): PetActivitySnapshot {
    const projection = candidate.projection
    const title = candidate.kind === 'needs_input'
      ? '等你确认'
      : candidate.kind === 'blocked'
        ? '遇到阻碍'
        : candidate.kind === 'ready'
          ? '结果已就绪'
          : '正在处理'
    return {
      revision: this.revision,
      kind: candidate.kind,
      taskId: projection.taskId,
      scopeId: projection.scopeId,
      runId: projection.runId,
      messageId: candidate.messageId,
      busy: true,
      state: candidate.kind === 'needs_input'
        ? 'waiting'
        : candidate.kind === 'blocked'
          ? 'failed'
          : candidate.kind === 'ready'
            ? 'review'
            : 'running',
      title,
      summary,
      events: [],
      updatedAt: projection.updatedAt,
    }
  }

  private summaryFor(candidate: Candidate): string {
    const projection = candidate.projection
    if (candidate.kind === 'running') {
      const narration = this.liveNarrations.get(
        this.liveNarrationKey(projection.scopeId, projection.taskId, projection.runId),
      )
      if (narration) return narration.text
    }
    return projection.taskSummary || projection.taskTitle || ''
  }

  private liveNarrationKey(scopeId: string, taskId: string, runId: string): string {
    return `${scopeId}\u0000${taskId}\u0000${runId}`
  }

  private latestVisibleAssistantMessage(scopeId: string): string | null {
    return this.db.prepare(`
      SELECT message.id
        FROM chat_messages message
        JOIN chat_conversations scope ON scope.id = message.conversation_id
       WHERE message.conversation_id = ?
         AND message.role = 'assistant'
         AND scope.closed_at IS NULL
         AND message.message_visibility_epoch = scope.message_visibility_epoch
       ORDER BY message.timestamp DESC LIMIT 1
    `).get<{ id: string }>(scopeId)?.id || null
  }
}
