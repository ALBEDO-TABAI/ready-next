import { randomUUID } from 'crypto'
import { dirname } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import type { SkillRunRequest, SkillRunResult } from '../skills-runtime/runtime-manager'
import { upsertDetachedSkillTaskRun } from './skill-task-tracker'

export type DetachedSkillTaskStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'blocked'

export interface DetachedSkillTaskRecord {
  id: string
  scopeId?: string | null
  sessionId?: string | null
  agent?: string | null
  skillId: string
  action: string
  params: Record<string, unknown>
  status: DetachedSkillTaskStatus
  outputDir?: string | null
  runStatePath?: string | null
  sceneScoresPath?: string | null
  deliveryReportPath?: string | null
  error?: string | null
  startedAt: string
  updatedAt: string
  finishedAt?: string | null
}

export interface DetachedSkillTaskStartRequest {
  scopeId?: string | null
  sessionId?: string | null
  agent?: string | null
  skillId: string
  action: string
  params?: Record<string, unknown>
}

export interface DetachedSkillTaskTrackerOptions {
  storagePath: string
  runSkill: (request: SkillRunRequest) => Promise<SkillRunResult>
  onUpdate?: (record: DetachedSkillTaskRecord) => void
}

let defaultDetachedSkillTaskTracker: DetachedSkillTaskTracker | null = null

function clone(record: DetachedSkillTaskRecord): DetachedSkillTaskRecord {
  return {
    ...record,
    params: { ...(record.params || {}) },
  }
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function extractOutputPaths(result: SkillRunResult): Pick<
  DetachedSkillTaskRecord,
  'outputDir' | 'runStatePath' | 'sceneScoresPath' | 'deliveryReportPath'
> {
  const outputs = result.outputs || {}
  return {
    outputDir: stringField(outputs.outputDir) || stringField(result.outputDir),
    runStatePath: stringField(outputs.runStatePath),
    sceneScoresPath: stringField(outputs.sceneScoresPath),
    deliveryReportPath: stringField(outputs.deliveryReportPath),
  }
}

function statusFromSkillResult(result: SkillRunResult): DetachedSkillTaskStatus {
  if (result.status === 'blocked') return 'blocked'
  if (result.status === 'error') return 'failed'
  return result.success ? 'done' : 'failed'
}

function pathFromParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function newestFileNamed(root: string, fileName: string): string | null {
  if (!existsSync(root)) return null
  const stat = statSync(root)
  if (stat.isFile()) return root.endsWith(fileName) ? root : null
  if (!stat.isDirectory()) return null
  let newestPath: string | null = null
  let newestMtimeMs = -1
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile() || entry.name !== fileName) continue
      const mtimeMs = statSync(path).mtimeMs
      if (mtimeMs > newestMtimeMs) {
        newestPath = path
        newestMtimeMs = mtimeMs
      }
    }
  }
  visit(root)
  return newestPath
}

function inferOutputPathsFromParams(params: Record<string, unknown>): Pick<
  DetachedSkillTaskRecord,
  'outputDir' | 'runStatePath' | 'sceneScoresPath' | 'deliveryReportPath'
> {
  const sceneScoresPath = pathFromParam(params, 'sceneScoresPath') || pathFromParam(params, 'source')
  if (sceneScoresPath) {
    const outputDir = sceneScoresPath.endsWith('/scene_scores.json')
      ? dirname(sceneScoresPath)
      : sceneScoresPath
    return {
      outputDir,
      sceneScoresPath: sceneScoresPath.endsWith('/scene_scores.json') ? sceneScoresPath : `${outputDir}/scene_scores.json`,
      runStatePath: `${outputDir}/run_state.json`,
      deliveryReportPath: existsSync(`${outputDir}/delivery_report.json`) ? `${outputDir}/delivery_report.json` : null,
    }
  }

  const outputDirParam = pathFromParam(params, 'outputDir')
  if (!outputDirParam) return {}
  const runStatePath = newestFileNamed(outputDirParam, 'run_state.json')
  if (!runStatePath) {
    const directRunState = `${outputDirParam}/run_state.json`
    if (!existsSync(directRunState)) return {}
    return {
      outputDir: outputDirParam,
      runStatePath: directRunState,
      sceneScoresPath: `${outputDirParam}/scene_scores.json`,
      deliveryReportPath: existsSync(`${outputDirParam}/delivery_report.json`) ? `${outputDirParam}/delivery_report.json` : null,
    }
  }
  const outputDir = dirname(runStatePath)
  const scoresPath = `${outputDir}/scene_scores.json`
  return {
    outputDir,
    runStatePath,
    sceneScoresPath: existsSync(scoresPath) ? scoresPath : null,
    deliveryReportPath: existsSync(`${outputDir}/delivery_report.json`) ? `${outputDir}/delivery_report.json` : null,
  }
}

function normalizeRecord(raw: unknown): DetachedSkillTaskRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = stringField(item.id)
  const skillId = stringField(item.skillId)
  const action = stringField(item.action)
  const status = stringField(item.status)
  const startedAt = stringField(item.startedAt)
  const updatedAt = stringField(item.updatedAt)
  if (!id || !skillId || !action || !startedAt || !updatedAt) return null
  if (
    status !== 'running' &&
    status !== 'done' &&
    status !== 'failed' &&
    status !== 'cancelled' &&
    status !== 'blocked'
  ) {
    return null
  }
  return {
    id,
    scopeId: stringField(item.scopeId),
    sessionId: stringField(item.sessionId),
    agent: stringField(item.agent),
    skillId,
    action,
    params: item.params && typeof item.params === 'object'
      ? { ...(item.params as Record<string, unknown>) }
      : {},
    status,
    outputDir: stringField(item.outputDir),
    runStatePath: stringField(item.runStatePath),
    sceneScoresPath: stringField(item.sceneScoresPath),
    deliveryReportPath: stringField(item.deliveryReportPath),
    error: stringField(item.error),
    startedAt,
    updatedAt,
    finishedAt: stringField(item.finishedAt),
  }
}

export class DetachedSkillTaskTracker {
  private readonly records = new Map<string, DetachedSkillTaskRecord>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly runningTasks = new Map<string, Promise<void>>()

  constructor(private readonly options: DetachedSkillTaskTrackerOptions) {
    this.load()
  }

  start(request: DetachedSkillTaskStartRequest): DetachedSkillTaskRecord {
    const nowIso = new Date().toISOString()
    const record: DetachedSkillTaskRecord = {
      id: `dst-${randomUUID().slice(0, 8)}`,
      scopeId: request.scopeId || null,
      sessionId: request.sessionId || request.scopeId || null,
      agent: request.agent || null,
      skillId: request.skillId,
      action: request.action,
      params: { ...(request.params || {}) },
      status: 'running',
      ...inferOutputPathsFromParams(request.params || {}),
      error: null,
      startedAt: nowIso,
      updatedAt: nowIso,
      finishedAt: null,
    }
    const controller = new AbortController()
    this.controllers.set(record.id, controller)
    this.saveRecord(record)
    const task = this.run(record, controller)
    this.runningTasks.set(record.id, task)
    task.finally(() => {
      this.controllers.delete(record.id)
      this.runningTasks.delete(record.id)
    }).catch(() => undefined)
    return clone(record)
  }

  inspect(taskId: string): DetachedSkillTaskRecord | null {
    const record = this.records.get(String(taskId || '').trim())
    return record ? clone(record) : null
  }

  list(params?: { scopeId?: string | null }): DetachedSkillTaskRecord[] {
    const scopeId = String(params?.scopeId || '').trim()
    return Array.from(this.records.values())
      .filter((record) => (scopeId ? record.scopeId === scopeId || record.sessionId === scopeId : true))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map(clone)
  }

  findLatestForScope(scopeId: string): DetachedSkillTaskRecord | null {
    return this.list({ scopeId })[0] || null
  }

  cancel(taskId: string): DetachedSkillTaskRecord | null {
    const id = String(taskId || '').trim()
    const record = this.records.get(id)
    if (!record) return null
    if (record.status === 'done' || record.status === 'failed' || record.status === 'cancelled') {
      return clone(record)
    }
    this.controllers.get(id)?.abort()
    const nowIso = new Date().toISOString()
    const next = {
      ...record,
      status: 'cancelled' as const,
      error: null,
      updatedAt: nowIso,
      finishedAt: nowIso,
    }
    this.saveRecord(next)
    return clone(next)
  }

  async waitForTask(taskId: string): Promise<DetachedSkillTaskRecord | null> {
    await this.runningTasks.get(taskId)
    return this.inspect(taskId)
  }

  private async run(record: DetachedSkillTaskRecord, controller: AbortController): Promise<void> {
    try {
      const result = await this.options.runSkill({
        skillId: record.skillId,
        action: record.action,
        params: record.params,
        triggerType: 'tool',
        sessionId: record.sessionId || undefined,
        signal: controller.signal,
      })
      const current = this.records.get(record.id)
      if (!current || current.status === 'cancelled') return
      const nowIso = new Date().toISOString()
      if (controller.signal.aborted) {
        this.saveRecord({
          ...current,
          status: 'cancelled',
          updatedAt: nowIso,
          finishedAt: nowIso,
        })
        return
      }
      this.saveRecord({
        ...current,
        ...extractOutputPaths(result),
        status: statusFromSkillResult(result),
        error: result.success ? null : result.error || result.stderr || 'Detached skill task failed.',
        updatedAt: nowIso,
        finishedAt: result.status === 'blocked' ? null : nowIso,
      })
    } catch (error) {
      const current = this.records.get(record.id)
      if (!current || current.status === 'cancelled') return
      const nowIso = new Date().toISOString()
      this.saveRecord({
        ...current,
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        error: controller.signal.aborted ? null : error instanceof Error ? error.message : String(error),
        updatedAt: nowIso,
        finishedAt: nowIso,
      })
    }
  }

  private load(): void {
    const raw = readJsonFile(this.options.storagePath)
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown[] }).tasks)
      ? (raw as { tasks: unknown[] }).tasks
      : []
    let changed = false
    const nowIso = new Date().toISOString()
    for (const item of list) {
      const record = normalizeRecord(item)
      if (!record) continue
      if (record.status === 'running') {
        const inferred = inferOutputPathsFromParams(record.params)
        Object.assign(record, {
          outputDir: record.outputDir || inferred.outputDir || null,
          runStatePath: record.runStatePath || inferred.runStatePath || null,
          sceneScoresPath: record.sceneScoresPath || inferred.sceneScoresPath || null,
          deliveryReportPath: record.deliveryReportPath || inferred.deliveryReportPath || null,
        })
        record.status = 'blocked'
        record.error = record.runStatePath
          ? 'Ready restarted before this detached task finished. Send continue to resume from its run_state.'
          : 'Ready restarted before this detached task finished. No run_state path was found yet; send continue to restart from the original params.'
        record.updatedAt = nowIso
        changed = true
      }
      this.records.set(record.id, record)
    }
    if (changed) this.persist()
  }

  private saveRecord(record: DetachedSkillTaskRecord): void {
    this.records.set(record.id, clone(record))
    this.persist()
    upsertDetachedSkillTaskRun(record)
    this.options.onUpdate?.(clone(record))
  }

  private persist(): void {
    mkdirSync(dirname(this.options.storagePath), { recursive: true })
    writeFileSync(
      this.options.storagePath,
      JSON.stringify({ tasks: Array.from(this.records.values()) }, null, 2),
      'utf-8',
    )
  }
}

export function registerDetachedSkillTaskTracker(tracker: DetachedSkillTaskTracker): void {
  defaultDetachedSkillTaskTracker = tracker
}

export function getDetachedSkillTaskTracker(): DetachedSkillTaskTracker | null {
  return defaultDetachedSkillTaskTracker
}
