// B8-D R1 — DetachedSkillService: detached (background) skill task
// start/inspect/list/cancel plus the scope-run-event publication of task
// updates, extracted from AgentControlRuntime (runtime.ts) as a delegated
// sub-service. Method bodies are mechanical moves; the only substitution is
// `this.publishScopeRunEvent(...)` → `this.deps.publishScopeRunEvent(...)`.
// The DetachedSkillTaskTracker field (with its construction + module-level
// registration wiring) is cluster-exclusive and migrated here; the
// SkillTaskRunRepository is NOT migrated because it is shared with the
// skill-child-runner wiring and session abort-controller registry that stay
// on the runtime.
import { app } from 'electron'
import { join } from 'path'
import {
  DetachedSkillTaskTracker,
  registerDetachedSkillTaskTracker,
  type DetachedSkillTaskRecord,
} from '../detached-skill-task-tracker'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import type { ScopeRunEventPayload } from '../contracts/types'

export interface DetachedSkillServiceDeps {
  publishScopeRunEvent: (payload: ScopeRunEventPayload) => void
}

export class DetachedSkillService {
  private readonly detachedSkillTasks: DetachedSkillTaskTracker

  constructor(private readonly deps: DetachedSkillServiceDeps) {
    this.detachedSkillTasks = new DetachedSkillTaskTracker({
      storagePath: join(app.getPath('userData'), 'skill-runtime', 'detached-tasks.json'),
      runSkill: (request) => getSkillsRuntimeManager().runSkill(request),
      onUpdate: (record) => this.publishDetachedSkillTaskUpdate(record),
    })
    registerDetachedSkillTaskTracker(this.detachedSkillTasks)
  }

  startDetachedSkillAction(payload: {
    scopeId?: string | null
    sessionId?: string | null
    agent?: string | null
    parentTaskId?: string | null
    parentStepId?: string | null
    taskProjectionId?: string | null
    skillId: string
    action: string
    params?: Record<string, unknown>
  }): DetachedSkillTaskRecord {
    return this.detachedSkillTasks.start(payload)
  }

  inspectDetachedSkillTask(taskId: string, scopeId?: string | null): DetachedSkillTaskRecord | null {
    const task = this.detachedSkillTasks.inspect(taskId)
    if (!task) return null
    const normalizedScopeId = String(scopeId || '').trim()
    if (normalizedScopeId && task.scopeId !== normalizedScopeId && task.sessionId !== normalizedScopeId) return null
    return task
  }

  listDetachedSkillTasks(payload?: { scopeId?: string | null }): DetachedSkillTaskRecord[] {
    return this.detachedSkillTasks.list(payload)
  }

  cancelDetachedSkillTask(taskId: string, scopeId?: string | null): DetachedSkillTaskRecord | null {
    const normalizedScopeId = String(scopeId || '').trim()
    const task = this.detachedSkillTasks.inspect(taskId)
    if (!task) return null
    if (normalizedScopeId && task.scopeId !== normalizedScopeId && task.sessionId !== normalizedScopeId) return null
    return this.detachedSkillTasks.cancel(taskId)
  }

  publishRestoredDetachedSkillTasks(): void {
    for (const record of this.detachedSkillTasks.list()) {
      if (record.status === 'blocked' || record.status === 'running') {
        this.publishDetachedSkillTaskUpdate(record)
      }
    }
  }

  private buildDetachedSkillArtifacts(record: DetachedSkillTaskRecord): NonNullable<ScopeRunEventPayload['artifactRefs']> {
    const nowIso = record.updatedAt
    const entries: Array<{ key: string; path?: string | null; label: string; kind: string }> = [
      { key: 'outputDir', path: record.outputDir, label: '技能输出目录', kind: 'directory' },
      { key: 'runStatePath', path: record.runStatePath, label: 'run_state.json', kind: 'artifact' },
      { key: 'sceneScoresPath', path: record.sceneScoresPath, label: 'scene_scores.json', kind: 'artifact' },
      { key: 'deliveryReportPath', path: record.deliveryReportPath, label: '交付报告', kind: 'artifact' },
    ]
    const seen = new Set<string>()
    return entries
      .filter((entry) => {
        const path = String(entry.path || '').trim()
        if (!path || seen.has(path)) return false
        seen.add(path)
        return true
      })
      .map((entry) => ({
        id: `${record.id}:${entry.key}`,
        module: 'skill',
        kind: entry.kind,
        label: entry.label,
        path: entry.path || null,
        createdAt: nowIso,
        meta: {
          detachedTaskId: record.id,
          skillId: record.skillId,
          action: record.action,
          outputKey: entry.key,
        },
      }))
  }

  private publishDetachedSkillTaskUpdate(record: DetachedSkillTaskRecord): void {
    const scopeId = record.scopeId || record.sessionId
    if (!scopeId) return
    const phase: ScopeRunEventPayload['phase'] =
      record.status === 'running' ? 'tool_running'
        : record.status === 'done' ? 'done'
          : record.status === 'cancelled' ? 'cancelled'
            : record.status === 'blocked' ? 'checkpoint'
              : 'error'
    const stepStatus =
      record.status === 'running' ? 'running'
        : record.status === 'done' ? 'done'
          : record.status === 'blocked' ? 'blocked'
            : 'error'
    const artifacts = this.buildDetachedSkillArtifacts(record)
    const taskId = `detached:${record.id}`
    const summary =
      record.status === 'running' ? '后台技能任务正在执行'
        : record.status === 'done' ? '后台技能任务已完成'
          : record.status === 'blocked' ? (record.error || '后台技能任务需要继续')
            : record.status === 'cancelled' ? '后台技能任务已取消'
              : (record.error || '后台技能任务失败')
    this.deps.publishScopeRunEvent({
      type: record.status === 'running' ? 'started' : record.status === 'blocked' ? 'updated' : 'finished',
      scopeId,
      agent: record.agent || 'assistant',
      runId: record.id,
      taskId,
      taskProjectionId: taskId,
      phase,
      module: 'skill',
      executionKind: 'job',
      jobId: record.id,
      taskTitle: `后台技能任务 · ${record.skillId}`,
      taskSummary: summary,
      steps: [{
        id: record.action,
        title: record.action,
        status: stepStatus,
        detail: record.error || record.outputDir || null,
        updatedAt: record.updatedAt,
      }],
      currentStepId: record.action,
      waitingFor: record.status === 'running' || record.status === 'blocked' ? 'background' : 'none',
      resumableActions: record.status === 'running'
        ? ['cancel']
        : record.status === 'blocked'
          ? ['continue', 'cancel']
          : artifacts.length > 0
            ? ['open_artifact']
            : ['none'],
      recentArtifacts: artifacts,
      artifactRefs: artifacts,
      blockedReason: record.status === 'blocked' ? record.error || '后台任务需要继续' : null,
      error: record.status === 'failed' ? record.error || '后台技能任务失败' : undefined,
      timestamp: record.updatedAt,
    })
  }
}
