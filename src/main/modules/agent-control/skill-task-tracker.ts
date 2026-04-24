/**
 * In-memory todo tracker for skill primitive calls.
 *
 * B Phase 4 replaces the `skill_executions` state machine with an advisory,
 * model-driven flow: reference skills load their SKILL.md inline, and the
 * model itself decides when to call `skill_run_shell` / `skill_write_artifact`
 * / `skill_ask_user`. The renderer task card still wants to show stepwise
 * progress, so this tracker records one todo per primitive call and feeds
 * the projection patch.
 *
 * Design notes:
 *   - Pure in-memory. App quit = everything dropped. No DB coupling —
 *     persistent workflow state is exactly what Phase 4 is retiring.
 *   - Records indexed by sessionId so `clearSession` can wipe every todo
 *     when a scope run ends.
 *   - `origin` is recorded so downstream consumers (projection patch,
 *     future telemetry) can tell run_shell todos from ask_user blockers
 *     without string-sniffing the title.
 *   - `artifactPath` is optional and captures the primary disk side-effect
 *     of the call (stdout overflow path for run_shell, absolute path for
 *     write_artifact). The projection patch surfaces these into the
 *     `recentArtifacts` field.
 *
 * Not in scope here (Phase 4):
 *   - Explicit `skill_todo_write` LLM tool — Phase 5 decision.
 *   - Cross-session persistence or replay.
 *   - TTL sweeping — session clearance is callsite-driven (scope end).
 */

import { randomBytes } from 'node:crypto'

export type SkillTodoStatus = 'pending' | 'running' | 'done' | 'blocked'

export type SkillTodoOrigin =
  | 'run_shell'
  | 'write_artifact'
  | 'ask_user'
  | 'manual'

export interface SkillTodo {
  id: string
  sessionId: string
  skillId: string
  title: string
  status: SkillTodoStatus
  origin: SkillTodoOrigin
  startedAt: number
  updatedAt: number
  artifactPath?: string
  blockedReason?: string
}

export interface StartTodoParams {
  sessionId: string
  skillId: string
  title: string
  origin: SkillTodoOrigin
  /** Defaults to 'running'. Use 'blocked' for `skill_ask_user` which is
   *  born suspended. */
  status?: 'running' | 'blocked'
  /** Optional explicit id — primarily for tests. Production callers should
   *  omit and receive the auto-generated `st-<8hex>` id. */
  id?: string
}

export class SkillTaskTracker {
  private readonly todos = new Map<string, SkillTodo>()
  // sessionId -> ordered list of todoIds (insertion order preserved for UI
  // stepwise display)
  private readonly sessionIndex = new Map<string, string[]>()

  startTodo(params: StartTodoParams): string {
    const id = params.id || this.generateId()
    const now = Date.now()
    const todo: SkillTodo = {
      id,
      sessionId: params.sessionId,
      skillId: params.skillId,
      title: params.title,
      status: params.status || 'running',
      origin: params.origin,
      startedAt: now,
      updatedAt: now,
    }
    this.todos.set(id, todo)
    const ids = this.sessionIndex.get(params.sessionId) || []
    ids.push(id)
    this.sessionIndex.set(params.sessionId, ids)
    return id
  }

  markDone(todoId: string, artifactPath?: string): boolean {
    const todo = this.todos.get(todoId)
    if (!todo) return false
    todo.status = 'done'
    todo.updatedAt = Date.now()
    if (artifactPath) todo.artifactPath = artifactPath
    // Clearing blockedReason on transition out of blocked keeps the shape
    // clean for consumers that check it.
    delete todo.blockedReason
    return true
  }

  markBlocked(todoId: string, reason: string): boolean {
    const todo = this.todos.get(todoId)
    if (!todo) return false
    todo.status = 'blocked'
    todo.updatedAt = Date.now()
    todo.blockedReason = reason
    return true
  }

  findTodo(todoId: string): SkillTodo | null {
    const todo = this.todos.get(todoId)
    if (!todo) return null
    // Return a shallow clone so callers can't mutate internal state.
    return { ...todo }
  }

  /**
   * List todos for a session in insertion order. Pass `skillId` to filter
   * to a specific skill's todos (the projection patch uses this to keep
   * task cards single-skill-focused).
   */
  listTodos(sessionId: string, skillId?: string): SkillTodo[] {
    const ids = this.sessionIndex.get(sessionId)
    if (!ids || ids.length === 0) return []
    const out: SkillTodo[] = []
    for (const id of ids) {
      const todo = this.todos.get(id)
      if (!todo) continue
      if (skillId && todo.skillId !== skillId) continue
      out.push({ ...todo })
    }
    return out
  }

  /** Remove every todo associated with a session. Returns count removed. */
  clearSession(sessionId: string): number {
    const ids = this.sessionIndex.get(sessionId)
    if (!ids) return 0
    let removed = 0
    for (const id of ids) {
      if (this.todos.delete(id)) removed += 1
    }
    this.sessionIndex.delete(sessionId)
    return removed
  }

  /** Drop all state. Intended for app shutdown / test teardown. */
  clear(): void {
    this.todos.clear()
    this.sessionIndex.clear()
  }

  size(): number {
    return this.todos.size
  }

  private generateId(): string {
    return `st-${randomBytes(4).toString('hex')}`
  }
}

let sharedTracker: SkillTaskTracker | null = null

export function getSkillTaskTracker(): SkillTaskTracker {
  if (!sharedTracker) sharedTracker = new SkillTaskTracker()
  return sharedTracker
}

/** Test helper — swaps the singleton for a fresh instance. */
export function _resetSkillTaskTrackerForTests(): void {
  if (sharedTracker) sharedTracker.clear()
  sharedTracker = new SkillTaskTracker()
}
