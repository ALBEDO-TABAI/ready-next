/**
 * Stage S (PR-S11 / W10.2) — RunMetaRepository.
 *
 * Per-run aggregator backing the `run_meta` table (migration 034). Owns:
 *   - status snapshot
 *   - cumulative token usage (input / output / total)
 *   - first / last / follow-up message text snapshots
 *
 * Constructor takes the same minimal database connection shape used by the
 * main-process DatabaseManager, while remaining structurally compatible with
 * better-sqlite3 in tests.
 */
import type { DatabaseConnection } from '../../database'
import type { AbortInitiator } from '../contracts/run-contracts-internal'
import type { TaskExecutionBinding } from '../../../../shared/agent-execution-profile'
import { assertTaskExecutionBinding } from './task-agent-binding'

export interface RunMetaRecord {
  runId: string
  taskId: string | null
  scopeId: string | null
  agentId: string | null
  executionBinding: TaskExecutionBinding | null
  status: string
  initiator: AbortInitiator | null
  durationMs: number | null
  taskType: string | null
  terminalReason: string | null
  providerProtocol: string | null
  wireApi: string | null
  contextWindow: number | null
  providerDiagnostics: Record<string, unknown> | null
  budget: Record<string, unknown> | null
  continuationRef: Record<string, unknown> | null
  recoveryHistory: unknown[] | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
  firstMessageText: string | null
  lastMessageText: string | null
  followUpText: string | null
  createdAt: number
  updatedAt: number
}

export interface RunMetaCreateInput {
  runId: string
  taskId?: string | null
  scopeId?: string | null
  agentId?: string | null
  executionBinding?: TaskExecutionBinding | null
  status: string
  initiator?: AbortInitiator | null
  durationMs?: number | null
  taskType?: string | null
  terminalReason?: string | null
  providerProtocol?: string | null
  wireApi?: string | null
  contextWindow?: number | null
  providerDiagnostics?: Record<string, unknown> | null
  budget?: Record<string, unknown> | null
  continuationRef?: Record<string, unknown> | null
  recoveryHistory?: unknown[] | null
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  firstMessageText?: string | null
  lastMessageText?: string | null
  followUpText?: string | null
}

export type RunMetaUpdatePatch = Partial<
  Omit<RunMetaRecord, 'runId' | 'createdAt'>
>

export interface RunMetaTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface RunMetaListOptions {
  scopeId?: string | null
  taskId?: string | null
  limit?: number
}

interface RunMetaRow {
  run_id: string
  task_id: string | null
  scope_id: string | null
  agent_id: string | null
  execution_binding_json?: string | null
  status: string
  initiator?: AbortInitiator | null
  duration_ms?: number | null
  task_type?: string | null
  terminal_reason?: string | null
  provider_protocol?: string | null
  wire_api?: string | null
  context_window?: number | null
  provider_diagnostics_json?: string | null
  budget_json?: string | null
  continuation_ref_json?: string | null
  recovery_history_json?: string | null
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  first_message_text: string | null
  last_message_text: string | null
  follow_up_text: string | null
  created_at: number
  updated_at: number
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

function rowToRecord(row: RunMetaRow): RunMetaRecord {
  const executionBinding = row.execution_binding_json
    ? assertTaskExecutionBinding(parseJson<TaskExecutionBinding | null>(row.execution_binding_json, null) as TaskExecutionBinding)
    : null
  return {
    runId: row.run_id,
    taskId: row.task_id,
    scopeId: row.scope_id,
    agentId: row.agent_id,
    executionBinding,
    status: row.status,
    initiator: row.initiator ?? null,
    durationMs: row.duration_ms ?? null,
    taskType: row.task_type ?? null,
    terminalReason: row.terminal_reason ?? null,
    providerProtocol: row.provider_protocol ?? null,
    wireApi: row.wire_api ?? null,
    contextWindow: row.context_window ?? null,
    providerDiagnostics: parseJson<Record<string, unknown> | null>(row.provider_diagnostics_json, null),
    budget: parseJson<Record<string, unknown> | null>(row.budget_json, null),
    continuationRef: parseJson<Record<string, unknown> | null>(row.continuation_ref_json, null),
    recoveryHistory: parseJson<unknown[] | null>(row.recovery_history_json, null),
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    firstMessageText: row.first_message_text,
    lastMessageText: row.last_message_text,
    followUpText: row.follow_up_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class RunMetaRepository {
  constructor(private readonly db: DatabaseConnection) {}

  create(input: RunMetaCreateInput, now: number = Date.now()): RunMetaRecord {
    const record: RunMetaRecord = {
      runId: input.runId,
      taskId: input.taskId ?? null,
      scopeId: input.scopeId ?? null,
      agentId: input.agentId ?? null,
      executionBinding: input.executionBinding ? assertTaskExecutionBinding(input.executionBinding) : null,
      status: input.status,
      initiator: input.initiator ?? null,
      durationMs: input.durationMs ?? null,
      taskType: input.taskType ?? null,
      terminalReason: input.terminalReason ?? null,
      providerProtocol: input.providerProtocol ?? null,
      wireApi: input.wireApi ?? null,
      contextWindow: input.contextWindow ?? null,
      providerDiagnostics: input.providerDiagnostics ?? null,
      budget: input.budget ?? null,
      continuationRef: input.continuationRef ?? null,
      recoveryHistory: input.recoveryHistory ?? null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      totalTokens: input.totalTokens ?? 0,
      firstMessageText: input.firstMessageText ?? null,
      lastMessageText: input.lastMessageText ?? null,
      followUpText: input.followUpText ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO run_meta (
          run_id, task_id, scope_id, agent_id, execution_binding_json, status,
          initiator, duration_ms,
          task_type, terminal_reason, provider_protocol, wire_api, context_window,
          provider_diagnostics_json, budget_json, continuation_ref_json, recovery_history_json,
          input_tokens, output_tokens, total_tokens,
          first_message_text, last_message_text, follow_up_text,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.runId,
        record.taskId,
        record.scopeId,
        record.agentId,
        jsonOrNull(record.executionBinding),
        record.status,
        record.initiator,
        record.durationMs,
        record.taskType,
        record.terminalReason,
        record.providerProtocol,
        record.wireApi,
        record.contextWindow,
        jsonOrNull(record.providerDiagnostics),
        jsonOrNull(record.budget),
        jsonOrNull(record.continuationRef),
        jsonOrNull(record.recoveryHistory),
        record.inputTokens,
        record.outputTokens,
        record.totalTokens,
        record.firstMessageText,
        record.lastMessageText,
        record.followUpText,
        record.createdAt,
        record.updatedAt,
      )
    return record
  }

  get(runId: string): RunMetaRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM run_meta WHERE run_id = ?`)
      .get(runId) as RunMetaRow | undefined
    return row ? rowToRecord(row) : null
  }

  update(runId: string, patch: RunMetaUpdatePatch, now: number = Date.now()): RunMetaRecord | null {
    const existing = this.get(runId)
    if (!existing) return null

    const merged: RunMetaRecord = {
      ...existing,
      ...patch,
      runId: existing.runId,
      createdAt: existing.createdAt,
      updatedAt: now,
    }
    if (existing.executionBinding && patch.executionBinding !== undefined) {
      const next = patch.executionBinding ? JSON.stringify(patch.executionBinding) : null
      if (next !== JSON.stringify(existing.executionBinding)) {
        throw new Error('[run-meta-repository] execution binding is immutable')
      }
    }

    this.db
      .prepare(
        `UPDATE run_meta SET
          task_id = ?, scope_id = ?, agent_id = ?, execution_binding_json = ?, status = ?,
          initiator = ?, duration_ms = ?,
          task_type = ?, terminal_reason = ?, provider_protocol = ?, wire_api = ?, context_window = ?,
          provider_diagnostics_json = ?, budget_json = ?, continuation_ref_json = ?, recovery_history_json = ?,
          input_tokens = ?, output_tokens = ?, total_tokens = ?,
          first_message_text = ?, last_message_text = ?, follow_up_text = ?,
          updated_at = ?
         WHERE run_id = ?`
      )
      .run(
        merged.taskId,
        merged.scopeId,
        merged.agentId,
        jsonOrNull(merged.executionBinding),
        merged.status,
        merged.initiator,
        merged.durationMs,
        merged.taskType,
        merged.terminalReason,
        merged.providerProtocol,
        merged.wireApi,
        merged.contextWindow,
        jsonOrNull(merged.providerDiagnostics),
        jsonOrNull(merged.budget),
        jsonOrNull(merged.continuationRef),
        jsonOrNull(merged.recoveryHistory),
        merged.inputTokens,
        merged.outputTokens,
        merged.totalTokens,
        merged.firstMessageText,
        merged.lastMessageText,
        merged.followUpText,
        merged.updatedAt,
        merged.runId,
      )
    return merged
  }

  /**
   * Cumulative token-usage upsert. Adds the deltas to the existing counters.
   * Required by W5 token-attribution telemetry which streams partial usage
   * fragments per LLM turn rather than a single end-of-run total.
   */
  upsertTokens(runId: string, usage: RunMetaTokenUsage, now: number = Date.now()): RunMetaRecord | null {
    const existing = this.get(runId)
    if (!existing) return null

    const next: RunMetaRecord = {
      ...existing,
      inputTokens: existing.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: existing.outputTokens + (usage.outputTokens ?? 0),
      totalTokens: existing.totalTokens + (usage.totalTokens ?? 0),
      updatedAt: now,
    }

    this.db
      .prepare(
        `UPDATE run_meta SET
          input_tokens = ?, output_tokens = ?, total_tokens = ?, updated_at = ?
         WHERE run_id = ?`
      )
      .run(next.inputTokens, next.outputTokens, next.totalTokens, next.updatedAt, runId)

    return next
  }

  delete(runId: string): boolean {
    const result = this.db.prepare(`DELETE FROM run_meta WHERE run_id = ?`).run(runId) as {
      changes: number
    }
    return result.changes > 0
  }

  list(options: RunMetaListOptions = {}): RunMetaRecord[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (options.scopeId !== undefined) {
      conditions.push('scope_id = ?')
      params.push(options.scopeId)
    }
    if (options.taskId !== undefined) {
      conditions.push('task_id = ?')
      params.push(options.taskId)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = options.limit && options.limit > 0 ? `LIMIT ${Math.floor(options.limit)}` : ''
    const sql = `SELECT * FROM run_meta ${where} ORDER BY updated_at DESC ${limit}`.trim()

    const rows = this.db.prepare(sql).all(...params) as RunMetaRow[]
    return rows.map(rowToRecord)
  }
}
