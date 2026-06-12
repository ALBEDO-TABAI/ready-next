import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { validatePacketFields, assertPacketDepth, type PacketDepthRow } from '../agent-control/quality/packet-fields'
import type {
  TaskProjectionChangeEvent,
  TaskProjectionRecord,
  TaskProjectionStore,
  TaskProjectionWriteOptions,
} from '../agent-control/contracts/run-contracts'

interface TaskProjectionStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

interface TaskProjectionRawDatabase {
  prepare(sql: string): TaskProjectionStatement
}

interface TaskProjectionDatabaseAccessor {
  getRawDb(): TaskProjectionRawDatabase | null
}

interface TaskProjectionRow {
  task_id: string
  scope_id: string
  run_id: string
  parent_task_id: string | null
  parent_step_id: string | null
  task_type: TaskProjectionRecord['taskType']
  module: string
  task_title: string | null
  task_summary: string | null
  status: TaskProjectionRecord['status']
  interaction_state: TaskProjectionRecord['interactionState']
  waiting_for: TaskProjectionRecord['waitingFor'] | null
  steps_json: string
  current_step_id: string | null
  budget_json: string | null
  budget_usage_percent: number | null
  budget_warning_level: string | null
  recovery_history_json: string | null
  degradation_reason: string | null
  blocked_reason: string | null
  resumable_actions_json: string | null
  continuation_ref_json: string | null
  progress_json: string | null
  criteria_json?: string | null
  checkins_json?: string | null
  proof_refs_json?: string | null
  learning_refs_json?: string | null
  owner_agent_id?: string | null
  packet_role?: string | null
  context_refs_json?: string | null
  recent_artifacts_json: string | null
  created_at: string
  updated_at: string
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Like safeParse but also rejects parses of the wrong container shape —
 * a malformed quality cell must degrade to the default, never leak a
 * mis-shaped value into consumers (EP2-Q1). */
function safeParseArray(raw: string | null | undefined): unknown[] {
  const parsed = safeParse<unknown>(raw, [])
  return Array.isArray(parsed) ? parsed : []
}

function safeParseObject(raw: string | null | undefined): Record<string, unknown> | null {
  const parsed = safeParse<unknown>(raw, null)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null
}

/**
 * EP2-Q1 — write-side structural validation for the quality fields.
 * Loud rejection: a writer (Q3 proof collector / Q4 adjudicator) passing
 * malformed values is a programming error, not data to tolerate. Limits
 * (checkins ≤50 / proofRefs ≤100 + archiving) belong to the writers.
 */
const taskQualityFieldsSchema = z.object({
  criteria: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
  checkins: z.union([z.array(z.unknown()), z.null()]).optional(),
  proofRefs: z.union([z.array(z.unknown()), z.null()]).optional(),
  learningRefs: z.union([z.array(z.unknown()), z.null()]).optional(),
})

function validateTaskQualityFields(patch: Partial<TaskProjectionRecord>, context: string): void {
  // EP3-PK1 — packet fields share the loud write-side validation channel.
  if ('packetRole' in patch || 'contextRefs' in patch) {
    try {
      validatePacketFields({ packetRole: patch.packetRole as never, contextRefs: patch.contextRefs as never })
    } catch (error) {
      throw new Error(`[task-projection-repository] ${context}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const candidate: Record<string, unknown> = {}
  if ('criteria' in patch) candidate.criteria = patch.criteria
  if ('checkins' in patch) candidate.checkins = patch.checkins
  if ('proofRefs' in patch) candidate.proofRefs = patch.proofRefs
  if ('learningRefs' in patch) candidate.learningRefs = patch.learningRefs
  if (Object.keys(candidate).length === 0) return
  const result = taskQualityFieldsSchema.safeParse(candidate)
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`[task-projection-repository] malformed quality field(s) rejected (${context}): ${fields}`)
  }
}

function artifactsMatchSibling(
  artifacts: Array<Record<string, unknown>> | undefined | null,
  normalizedOutputDir: string | null,
  runStatePath: string | null,
): boolean {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return false
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') continue
    const path = typeof artifact.path === 'string' ? artifact.path : ''
    if (runStatePath && path && path === runStatePath) return true
    if (
      normalizedOutputDir
      && path
      && path.split(/[\\/]/).pop() === 'run_state.json'
      && (path.startsWith(`${normalizedOutputDir}/`) || path.startsWith(`${normalizedOutputDir}\\`))
    ) {
      return true
    }
    if (normalizedOutputDir) {
      const meta = artifact.meta as Record<string, unknown> | undefined
      const metaOutputDir = typeof meta?.outputDir === 'string' ? meta.outputDir : null
      if (metaOutputDir && metaOutputDir.replace(/[\\/]+$/, '') === normalizedOutputDir) return true
      if (
        path
        && (path === normalizedOutputDir
          || path.startsWith(`${normalizedOutputDir}/`)
          || path.startsWith(`${normalizedOutputDir}\\`))
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * Stage F3 (Zeta) — extract any skillId carried on artifact meta. Rows that
 * never recorded a skillId (legacy short_task) return null and remain
 * matchable; rows that explicitly carry a different skillId are rejected
 * by the caller so cross-skill non-supersede holds.
 */
function artifactSiblingSkillId(
  artifacts: Array<Record<string, unknown>> | undefined | null,
): string | null {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object') continue
    const meta = artifact.meta as Record<string, unknown> | undefined
    const value = typeof meta?.skillId === 'string' ? meta.skillId.trim() : ''
    if (value) return value
  }
  return null
}

export class TaskProjectionRepository implements TaskProjectionStore {
  /**
   * Stage O — `change` listeners are notified after every successful
   * create/update/delete (unless the writer passes `{ silent: true }`).
   * The IPC bridge subscribes here and forwards as
   * `agent:taskProjectionsChanged` to the renderer; the renderer drops
   * the 2-second `agent:listActiveChildRuns` polling timer and reacts
   * to the push event instead. See plan §0.2 for the wiring contract.
   */
  private readonly emitter = new EventEmitter()

  constructor(private readonly dbManager: TaskProjectionDatabaseAccessor) {
    this.emitter.setMaxListeners(0)
  }

  on(event: 'change', listener: (payload: TaskProjectionChangeEvent) => void): this {
    this.emitter.on(event, listener)
    return this
  }

  off(event: 'change', listener: (payload: TaskProjectionChangeEvent) => void): this {
    this.emitter.off(event, listener)
    return this
  }

  private emitChange(event: TaskProjectionChangeEvent, options?: TaskProjectionWriteOptions): void {
    if (options?.silent) return
    try {
      this.emitter.emit('change', event)
    } catch (error) {
      console.warn(
        '[task-projection-repository] change emit failed:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** EP3-PK1 — two-level packet nesting is enforced AT THE WRITE SIDE, not
   *  just offered as a free function: any row carrying a packet_role must
   *  pass the depth assertion against rows already in the store. Ordinary
   *  tasks (no packetRole) skip the lookup entirely (存量零感知). */
  private assertPacketDepthAgainstStore(candidate: PacketDepthRow, context: string): void {
    if (!candidate.packetRole) return
    try {
      assertPacketDepth(candidate, (id) => {
        const row = this.get(id)
        return row
          ? { taskId: id, packetRole: row.packetRole ?? null, parentTaskId: row.parentTaskId ?? null }
          : null
      })
    } catch (error) {
      throw new Error(`[task-projection-repository] ${context}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  create(record: TaskProjectionRecord, options?: TaskProjectionWriteOptions): void {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    validateTaskQualityFields(record, 'create')
    this.assertPacketDepthAgainstStore(
      { taskId: record.taskId, packetRole: record.packetRole ?? null, parentTaskId: record.parentTaskId ?? null },
      'create',
    )

    db.prepare(`
      INSERT INTO task_projections (
        task_id, scope_id, run_id, parent_task_id, parent_step_id, task_type, module, task_title, task_summary, status, interaction_state, waiting_for,
        steps_json, current_step_id, budget_json, budget_usage_percent, budget_warning_level,
        recovery_history_json, degradation_reason, blocked_reason, resumable_actions_json,
        continuation_ref_json, progress_json, recent_artifacts_json,
        criteria_json, checkins_json, proof_refs_json, learning_refs_json,
        owner_agent_id, packet_role, context_refs_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.scopeId,
      record.runId,
      record.parentTaskId ?? null,
      record.parentStepId ?? null,
      record.taskType,
      record.module,
      record.taskTitle ?? null,
      record.taskSummary ?? null,
      record.status,
      record.interactionState,
      record.waitingFor ?? 'none',
      JSON.stringify(record.steps || []),
      record.currentStepId ?? null,
      record.budget ? JSON.stringify(record.budget) : null,
      record.budgetUsagePercent ?? null,
      record.budgetWarningLevel ?? null,
      record.recoveryHistory ? JSON.stringify(record.recoveryHistory) : null,
      record.degradationReason ?? null,
      record.blockedReason ?? null,
      record.resumableActions ? JSON.stringify(record.resumableActions) : null,
      record.continuationRef ? JSON.stringify(record.continuationRef) : null,
      record.progress ? JSON.stringify(record.progress) : null,
      record.recentArtifacts ? JSON.stringify(record.recentArtifacts) : null,
      record.criteria ? JSON.stringify(record.criteria) : null,
      record.checkins ? JSON.stringify(record.checkins) : null,
      record.proofRefs ? JSON.stringify(record.proofRefs) : null,
      record.learningRefs ? JSON.stringify(record.learningRefs) : null,
      record.ownerAgentId ?? null,
      record.packetRole ?? null,
      record.contextRefs ? JSON.stringify(record.contextRefs) : null,
      record.createdAt,
      record.updatedAt,
    )
    this.emitChange(
      {
        scopeId: record.scopeId,
        changedTaskIds: [record.taskId],
        reason: options?.reasonHint ?? 'create',
      },
      options,
    )
  }

  update(taskId: string, patch: Partial<TaskProjectionRecord>, options?: TaskProjectionWriteOptions): void {
    // Stage O — capture the OLD scopeId before the SQL UPDATE so a
    // cross-scope move can notify both scopes. Reading post-update
    // would only return the new scope; the old scope's renderer would
    // never refetch. Errors here fall back to null (we still emit for
    // the new scope).
    let priorScopeId: string | null = null
    let priorRecord: TaskProjectionRecord | null = null
    try {
      const prior = this.get(taskId)
      priorRecord = prior ?? null
      priorScopeId = prior?.scopeId || null
    } catch {
      priorScopeId = null
    }
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    validateTaskQualityFields(patch, 'update')
    // EP3-PK1 — re-assert nesting on the EFFECTIVE row (patch merged over
    // prior) whenever the packet shape can change.
    if ('packetRole' in patch || 'parentTaskId' in patch) {
      const effectiveRole = ('packetRole' in patch ? patch.packetRole : priorRecord?.packetRole) ?? null
      this.assertPacketDepthAgainstStore(
        {
          taskId,
          packetRole: effectiveRole,
          parentTaskId: ('parentTaskId' in patch ? patch.parentTaskId : priorRecord?.parentTaskId) ?? null,
        },
        'update',
      )
      // demoting a parent packet while child packets still hang under it
      // would orphan them into an illegal shape — reject loudly.
      if (priorRecord?.packetRole === 'parent' && effectiveRole !== 'parent') {
        const liveChildren = this.listByParentTask(taskId).filter((row) => row.packetRole === 'child')
        if (liveChildren.length > 0) {
          throw new Error(`[task-projection-repository] update: cannot demote parent packet ${taskId} with ${liveChildren.length} live child packet(s)`)
        }
      }
    }

    const updates: Array<[string, unknown]> = []
    const assign = (column: string, value: unknown): void => {
      updates.push([column, value ?? null])
    }

    if ('scopeId' in patch) assign('scope_id', patch.scopeId)
    if ('runId' in patch) assign('run_id', patch.runId)
    if ('parentTaskId' in patch) assign('parent_task_id', patch.parentTaskId)
    if ('parentStepId' in patch) assign('parent_step_id', patch.parentStepId)
    if ('taskType' in patch) assign('task_type', patch.taskType)
    if ('module' in patch) assign('module', patch.module)
    if ('taskTitle' in patch) assign('task_title', patch.taskTitle)
    if ('taskSummary' in patch) assign('task_summary', patch.taskSummary)
    if ('status' in patch) assign('status', patch.status)
    if ('interactionState' in patch) assign('interaction_state', patch.interactionState)
    if ('waitingFor' in patch) assign('waiting_for', patch.waitingFor)
    if ('steps' in patch) assign('steps_json', JSON.stringify(patch.steps || []))
    if ('currentStepId' in patch) assign('current_step_id', patch.currentStepId)
    if ('budget' in patch) assign('budget_json', patch.budget ? JSON.stringify(patch.budget) : null)
    if ('budgetUsagePercent' in patch) assign('budget_usage_percent', patch.budgetUsagePercent)
    if ('budgetWarningLevel' in patch) assign('budget_warning_level', patch.budgetWarningLevel)
    if ('recoveryHistory' in patch) assign('recovery_history_json', patch.recoveryHistory ? JSON.stringify(patch.recoveryHistory) : null)
    if ('degradationReason' in patch) assign('degradation_reason', patch.degradationReason)
    if ('blockedReason' in patch) assign('blocked_reason', patch.blockedReason)
    if ('resumableActions' in patch) assign('resumable_actions_json', patch.resumableActions ? JSON.stringify(patch.resumableActions) : null)
    if ('continuationRef' in patch) assign('continuation_ref_json', patch.continuationRef ? JSON.stringify(patch.continuationRef) : null)
    if ('progress' in patch) assign('progress_json', patch.progress ? JSON.stringify(patch.progress) : null)
    if ('recentArtifacts' in patch) assign('recent_artifacts_json', patch.recentArtifacts ? JSON.stringify(patch.recentArtifacts) : null)
    if ('criteria' in patch) assign('criteria_json', patch.criteria ? JSON.stringify(patch.criteria) : null)
    if ('checkins' in patch) assign('checkins_json', patch.checkins ? JSON.stringify(patch.checkins) : null)
    if ('proofRefs' in patch) assign('proof_refs_json', patch.proofRefs ? JSON.stringify(patch.proofRefs) : null)
    if ('learningRefs' in patch) assign('learning_refs_json', patch.learningRefs ? JSON.stringify(patch.learningRefs) : null)
    if ('ownerAgentId' in patch) assign('owner_agent_id', patch.ownerAgentId)
    if ('packetRole' in patch) assign('packet_role', patch.packetRole)
    if ('contextRefs' in patch) assign('context_refs_json', patch.contextRefs ? JSON.stringify(patch.contextRefs) : null)
    if ('createdAt' in patch) assign('created_at', patch.createdAt)
    if ('updatedAt' in patch) assign('updated_at', patch.updatedAt)

    if (updates.length === 0) return

    const setClause = updates.map(([column]) => `${column} = ?`).join(', ')
    db.prepare(`UPDATE task_projections SET ${setClause} WHERE task_id = ?`).run(
      ...updates.map(([, value]) => value),
      taskId,
    )
    // Stage O — emit after successful SQL execution. We resolve scopeId
    // from the patch first (covers callers that move a row across scopes),
    // and fall back to a re-read so the renderer can still scope its
    // refetch. If scopeId can't be determined, skip emit (no consumer
    // could have used it anyway).
    let emitScopeId = typeof patch.scopeId === 'string' && patch.scopeId.trim() ? patch.scopeId.trim() : null
    if (!emitScopeId) {
      try {
        const refreshed = this.get(taskId)
        emitScopeId = refreshed?.scopeId || null
      } catch {
        emitScopeId = null
      }
    }
    if (emitScopeId) {
      this.emitChange(
        {
          scopeId: emitScopeId,
          changedTaskIds: [taskId],
          reason: options?.reasonHint ?? 'update',
        },
        options,
      )
      // Stage O — cross-scope move: emit a second event for the prior
      // scope so its renderer also refetches and removes the row.
      // Skipped when prior is missing or identical.
      if (priorScopeId && priorScopeId !== emitScopeId) {
        this.emitChange(
          {
            scopeId: priorScopeId,
            changedTaskIds: [taskId],
            reason: options?.reasonHint ?? 'update',
          },
          options,
        )
      }
    }
  }

  get(taskId: string): TaskProjectionRecord | null {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const row = db.prepare(
      'SELECT * FROM task_projections WHERE task_id = ? LIMIT 1',
    ).get<TaskProjectionRow>(taskId)
    return row ? this.mapRow(row) : null
  }

  listByScope(scopeId: string): TaskProjectionRecord[] {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    return db.prepare(
      'SELECT * FROM task_projections WHERE scope_id = ? ORDER BY updated_at DESC',
    ).all<TaskProjectionRow>(scopeId).map((row) => this.mapRow(row))
  }

  /**
   * EP3-A4 — the scope's effective injection owner: the most recently
   * updated row carrying an ownerAgentId. Once a task in this scope was
   * handed to a specialized agent, subsequent turns inject that agent's
   * scope (A2 channel) until a later handoff changes it. Dead DB → null.
   */
  getLatestOwnerAgentForScope(scopeId: string): string | null {
    try {
      const db = this.dbManager.getRawDb()
      if (!db) return null
      const row = db.prepare(
        'SELECT owner_agent_id FROM task_projections WHERE scope_id = ? AND owner_agent_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
      ).get<{ owner_agent_id: string | null }>(scopeId)
      return row?.owner_agent_id ?? null
    } catch {
      return null
    }
  }

  /** EP4-A5 — recent tasks (most recent first, ANY owner) feeding the
   *  session preroute's state tier. Un-owned open tasks must be visible to
   *  the classifier, or a genuine continuation of a main-agent task would
   *  get hijacked by precedent matching. Dead DB → empty. */
  listRecentTasksForPreroute(limit = 10): TaskProjectionRecord[] {
    try {
      const db = this.dbManager.getRawDb()
      if (!db) return []
      return db.prepare(
        'SELECT * FROM task_projections ORDER BY updated_at DESC LIMIT ?',
      ).all<TaskProjectionRow>(limit).map((row) => this.mapRow(row))
    } catch {
      return []
    }
  }

  listByParentTask(parentTaskId: string): TaskProjectionRecord[] {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    return db.prepare(
      'SELECT * FROM task_projections WHERE parent_task_id = ? ORDER BY updated_at DESC',
    ).all<TaskProjectionRow>(parentTaskId).map((row) => this.mapRow(row))
  }

  deleteByScope(scopeId: string, options?: TaskProjectionWriteOptions): void {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    // Stage O — collect taskIds *before* delete so the change event can
    // describe what was removed. listByScope is the same path the
    // renderer uses, so it tolerates the same DB shapes.
    let removedTaskIds: string[] = []
    try {
      removedTaskIds = this.listByScope(scopeId).map((record) => record.taskId)
    } catch {
      removedTaskIds = []
    }
    db.prepare('DELETE FROM task_projections WHERE scope_id = ?').run(scopeId)
    this.emitChange(
      {
        scopeId,
        changedTaskIds: removedTaskIds,
        reason: options?.reasonHint ?? 'delete',
      },
      options,
    )
  }

  /**
   * Stage 6 supersede helper. Returns non-terminal (`running`/`blocked`/`queued`)
   * legacy `module='system' task_type='short_task'` projections in the same
   * scope whose recentArtifacts JSON references the same outputDir (via
   * artifact path prefix or `meta.outputDir`) or the same runStatePath
   * (via artifact path equality, or any `run_state.json` filename inside
   * the outputDir). Skill-keyed rows (taskId starting with `skill:`) are
   * excluded — those are already the new identities being committed.
   *
   * Stage F3 (Zeta) — `skillId` is plumbed into the filter so two skills
   * that happen to share an output path do NOT supersede each other:
   *   - When `args.skillId` is null/undefined the helper behaves as before.
   *   - When `args.skillId` is provided and a candidate row carries a
   *     different `meta.skillId` on its artifacts, that row is rejected.
   *   - Legacy rows without any `meta.skillId` continue to match (they
   *     pre-date the skill-keyed identity scheme and must still be
   *     superseded by the freshly-committed skill row).
   */
  findByArtifactSiblings(args: {
    scopeId: string
    skillId: string | null
    outputDir: string | null
    runStatePath: string | null
  }): TaskProjectionRecord[] {
    const db = this.dbManager.getRawDb()
    if (!db) throw new Error('Database not available')
    const { scopeId, skillId, outputDir, runStatePath } = args
    if (!outputDir && !runStatePath) return []
    const normalizedSkillId = typeof skillId === 'string' && skillId.trim() ? skillId.trim() : null
    // Phase 7 — apply `skillId` filter in SQL BEFORE path similarity, per
    // source plan §7. A candidate row is rejected as soon as ANY of its
    // recorded artifacts carries a `meta.skillId` that differs from
    // `normalizedSkillId`. Legacy rows that never recorded a skillId have
    // no such artifact — the inner NOT EXISTS evaluates true and they
    // remain adoptable. Rows with `skill-child:` / `skill:` prefixes are
    // also excluded here so we never re-adopt a child-run row by path
    // similarity.
    const rows = db.prepare(
      `SELECT *
       FROM task_projections tp
       WHERE tp.scope_id = ?
         AND tp.module = 'system'
         AND tp.task_type = 'short_task'
         AND tp.status NOT IN ('cancelled', 'done', 'killed', 'completed')
         AND tp.task_id NOT LIKE 'skill:%'
         AND tp.task_id NOT LIKE 'skill-child:%'
         AND (
           ? IS NULL
           OR NOT EXISTS (
             SELECT 1
             FROM json_each(COALESCE(tp.recent_artifacts_json, '[]')) artifact
             WHERE TRIM(COALESCE(json_extract(artifact.value, '$.meta.skillId'), '')) <> ''
               AND TRIM(json_extract(artifact.value, '$.meta.skillId')) <> ?
           )
         )`,
    ).all<TaskProjectionRow>(scopeId, normalizedSkillId, normalizedSkillId ?? '')
    const normalizedOutputDir = outputDir ? outputDir.replace(/[\\/]+$/, '') : null
    return rows
      .map((row) => this.mapRow(row))
      .filter((record) => {
        const artifacts = record.recentArtifacts as Array<Record<string, unknown>> | undefined
        // Path/runStatePath similarity matching applies on the already
        // skill-filtered candidate set.
        if (!artifactsMatchSibling(artifacts, normalizedOutputDir, runStatePath)) return false
        // Defense-in-depth: legacy DBs that pre-date `json_extract` quirks
        // may still yield mixed-skill artifacts inside one row. Repeat the
        // JS-side check so cross-skill rows can never sneak through.
        if (!normalizedSkillId) return true
        const siblingSkillId = artifactSiblingSkillId(artifacts)
        return !siblingSkillId || siblingSkillId === normalizedSkillId
      })
  }

  private mapRow(row: TaskProjectionRow): TaskProjectionRecord {
    return {
      taskId: row.task_id,
      scopeId: row.scope_id,
      runId: row.run_id,
      parentTaskId: row.parent_task_id ?? null,
      parentStepId: row.parent_step_id ?? null,
      taskType: row.task_type,
      module: row.module,
      taskTitle: row.task_title ?? null,
      taskSummary: row.task_summary ?? null,
      status: row.status,
      interactionState: row.interaction_state,
      waitingFor: row.waiting_for || 'none',
      steps: safeParse(row.steps_json, []),
      currentStepId: row.current_step_id ?? null,
      budget: safeParse(row.budget_json, null),
      budgetUsagePercent: row.budget_usage_percent ?? null,
      budgetWarningLevel: (row.budget_warning_level || null) as TaskProjectionRecord['budgetWarningLevel'],
      recoveryHistory: safeParse(row.recovery_history_json, []),
      degradationReason: row.degradation_reason ?? null,
      blockedReason: row.blocked_reason ?? null,
      resumableActions: safeParse(row.resumable_actions_json, []),
      continuationRef: safeParse(row.continuation_ref_json, null),
      progress: safeParse(row.progress_json, null),
      recentArtifacts: safeParse(row.recent_artifacts_json, []),
      criteria: safeParseObject(row.criteria_json),
      checkins: safeParseArray(row.checkins_json),
      proofRefs: safeParseArray(row.proof_refs_json),
      learningRefs: safeParseArray(row.learning_refs_json),
      ownerAgentId: row.owner_agent_id ?? null,
      packetRole: (row.packet_role === 'parent' || row.packet_role === 'child') ? row.packet_role : null,
      contextRefs: safeParseArray(row.context_refs_json).filter((ref): ref is string => typeof ref === 'string'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
