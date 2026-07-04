// ────────────────────────────────────────────────────────────────────────
// Phase 7 — `startSkillChildRunAndWait` compatibility helper.
//
// Product callers (e.g. `item-analysis-manager.ts`) historically awaited
// `runSkill` for VEA long actions. After Phase 6/7 those actions are
// child-loop owned; the runtime helper below preserves the await-style
// contract: launch a child run, block until its close event, and return
// the structured close + childRunId. RSS visual analysis keeps its
// existing flow — internally the long work is now child-owned.
//
// The helper is a thin wrapper around `startSkillChildRun` /
// `getSkillChildRunCloseEvent` from `agent-control/skill-child-runner.ts`.
// We import lazily inside the function body to avoid a hard cycle between
// runtime-manager and the child-runner module (the runner's
// SkillChildRunnerConfig already depends on this file).
// ────────────────────────────────────────────────────────────────────────

import type {
  SkillChildCloseEvent,
  SkillChildRunStatus,
} from '../agent-control/skills/skill-child-run-types'

export interface StartSkillChildRunAndWaitParams {
  skillId: string
  action: string
  params: Record<string, unknown>
  scopeId?: string | null
  sessionId?: string | null
  /** Hard upper bound on observer wait time. When elapsed the helper
   *  returns `status:'running'` with observerTimeout metadata; it does
   *  not cancel or mutate the child run. Set null/undefined for no timeout. */
  timeoutMs?: number
  triggerType?: 'tool' | 'product' | 'agent'
}

export interface StartSkillChildRunAndWaitResult {
  childRunId: string
  /** Final status from the close event, or `running` when only this
   *  observer timed out while the child continues in the background. */
  status: Exclude<SkillChildRunStatus, 'queued'>
  closeEvent: SkillChildCloseEvent | null
  observerTimeout?: {
    elapsedMs: number
  } | null
  /** True only when `closeEvent.status === 'completed'`. Provided as a
   *  convenience so existing product code doesn't have to re-derive it. */
  success: boolean
}

/**
 * Phase 7 — launch a skill child run and await its close event.
 *
 * Single-flight semantics are honored: when the underlying runner returns
 * `'reused'` the helper waits on the existing child's close event. A
 * `'recoverable_paused'` / `'failed'` / `'killed'` / `'completed'` close
 * that arrives synchronously on launch is also forwarded immediately.
 */
export async function startSkillChildRunAndWait(
  params: StartSkillChildRunAndWaitParams,
): Promise<StartSkillChildRunAndWaitResult> {
  // Lazy require to break the runtime-manager ⇄ skill-child-runner cycle.
  const childRunner = await import('../agent-control/skills/skill-child-runner')

  const launch = await childRunner.startSkillChildRun({
    scopeId: params.scopeId ?? null,
    sessionId: params.sessionId ?? null,
    skillId: params.skillId,
    action: params.action,
    requestedInput: params.params,
    parentNextHint: 'wait_for_close_event',
    triggerType: params.triggerType ?? 'product',
  })

  // Synchronous launch refusal (no driver, nested-child, queued, infra
  // error). Forward the close event verbatim — caller decides retry.
  if (launch.closeEvent) {
    return {
      childRunId: launch.childRunId,
      status: launch.closeEvent.status,
      closeEvent: launch.closeEvent,
      success: launch.closeEvent.status === 'completed',
    }
  }

  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs
    : null

  const waitResult = await childRunner.waitForSkillChildRunClose(launch.childRunId, { timeoutMs })
  if (waitResult.kind === 'closed') {
    return {
      childRunId: launch.childRunId,
      status: waitResult.closeEvent.status,
      closeEvent: waitResult.closeEvent,
      success: waitResult.closeEvent.status === 'completed',
      observerTimeout: null,
    }
  }

  return {
    childRunId: launch.childRunId,
    status: 'running',
    closeEvent: null,
    success: false,
    observerTimeout: {
      elapsedMs: waitResult.elapsedMs,
    },
  }
}
