import { randomUUID } from 'crypto'

import { BrowserRepository } from '../repositories/browser-repository'
import type {
  BrowserCapabilityTaskHandle,
  BrowserCapabilityTaskKind,
  BrowserCapabilityTaskProgress,
  BrowserCapabilityTaskStatus,
  BrowserStartTaskRequest,
  BrowserTaskCheckpoint,
} from './capability-types'

function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export class BrowserTaskPersistenceService {
  constructor(private readonly repository = new BrowserRepository()) {}

  createTask(request: BrowserStartTaskRequest): BrowserCapabilityTaskHandle {
    const now = new Date().toISOString()
    const taskId = `browser-task-${randomUUID()}`
    this.repository.createTask({
      id: taskId,
      kind: request.kind,
      status: 'queued',
      payload_json: JSON.stringify(request.payload || {}),
      checkpoint_json: null,
      result_json: null,
      progress_total: 0,
      progress_completed: 0,
      progress_failed: 0,
      current_label: null,
      error: null,
      created_at: now,
      started_at: null,
      updated_at: now,
      finished_at: null,
    })
    return {
      taskId,
      kind: request.kind,
      status: 'queued',
      progress: { total: 0, completed: 0, failed: 0, currentLabel: null },
      createdAt: now,
      updatedAt: now,
    }
  }

  getTask(taskId: string): BrowserCapabilityTaskHandle | null {
    const record = this.repository.getTask(taskId)
    if (!record) return null
    return {
      taskId: record.id,
      kind: record.kind as BrowserCapabilityTaskKind,
      status: record.status as BrowserCapabilityTaskStatus,
      progress: {
        total: Number(record.progress_total || 0),
        completed: Number(record.progress_completed || 0),
        failed: Number(record.progress_failed || 0),
        currentLabel: record.current_label,
      },
      checkpoint: parseJSON<BrowserTaskCheckpoint | null>(record.checkpoint_json, null),
      result: parseJSON<unknown>(record.result_json, null),
      error: record.error,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    }
  }

  getTaskPayload(taskId: string): Record<string, unknown> | null {
    const record = this.repository.getTask(taskId)
    if (!record) return null
    return parseJSON<Record<string, unknown>>(record.payload_json, {})
  }

  updateProgress(taskId: string, progress: Partial<BrowserCapabilityTaskProgress>, extras?: {
    checkpoint?: BrowserTaskCheckpoint | null
    status?: BrowserCapabilityTaskStatus
    error?: string | null
    result?: unknown
    startedAt?: string | null
    finishedAt?: string | null
  }): BrowserCapabilityTaskHandle | null {
    const current = this.getTask(taskId)
    if (!current) return null

    const nextProgress: BrowserCapabilityTaskProgress = {
      total: progress.total ?? current.progress.total,
      completed: progress.completed ?? current.progress.completed,
      failed: progress.failed ?? current.progress.failed,
      currentLabel: progress.currentLabel ?? current.progress.currentLabel ?? null,
    }
    this.repository.updateTask(taskId, {
      status: extras?.status ?? current.status,
      checkpoint_json: extras?.checkpoint !== undefined ? JSON.stringify(extras.checkpoint) : undefined,
      result_json: extras?.result !== undefined ? JSON.stringify(extras.result) : undefined,
      progress_total: nextProgress.total,
      progress_completed: nextProgress.completed,
      progress_failed: nextProgress.failed,
      current_label: nextProgress.currentLabel ?? null,
      error: extras?.error ?? current.error ?? null,
      started_at: extras?.startedAt,
      finished_at: extras?.finishedAt,
      updated_at: new Date().toISOString(),
    })

    return this.getTask(taskId)
  }

  listPendingTasks(): BrowserCapabilityTaskHandle[] {
    return this.repository
      .listTasks(['queued', 'running', 'paused'])
      .map((record) => ({
        taskId: record.id,
        kind: record.kind as BrowserCapabilityTaskKind,
        status: record.status as BrowserCapabilityTaskStatus,
        progress: {
          total: Number(record.progress_total || 0),
          completed: Number(record.progress_completed || 0),
          failed: Number(record.progress_failed || 0),
          currentLabel: record.current_label,
        },
        checkpoint: parseJSON<BrowserTaskCheckpoint | null>(record.checkpoint_json, null),
        result: parseJSON<unknown>(record.result_json, null),
        error: record.error,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
      }))
  }

  listTasks(): BrowserCapabilityTaskHandle[] {
    return this.repository
      .listTasks()
      .map((record) => ({
        taskId: record.id,
        kind: record.kind as BrowserCapabilityTaskKind,
        status: record.status as BrowserCapabilityTaskStatus,
        progress: {
          total: Number(record.progress_total || 0),
          completed: Number(record.progress_completed || 0),
          failed: Number(record.progress_failed || 0),
          currentLabel: record.current_label,
        },
        checkpoint: parseJSON<BrowserTaskCheckpoint | null>(record.checkpoint_json, null),
        result: parseJSON<unknown>(record.result_json, null),
        error: record.error,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
      }))
  }
}
