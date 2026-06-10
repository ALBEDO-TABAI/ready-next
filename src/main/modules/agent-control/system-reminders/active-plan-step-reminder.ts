/**
 * S4-3 — per-scope active plan store with per-turn re-injection (C4.2a).
 *
 * The live Agent SDK loop has no cross-turn plan memory: a multi-step task is
 * re-guessed every turn from the recalled summary. This module gives the loop
 * a code-owned plan slot:
 *
 *  - collection dispatch tools synthesize a deterministic plan (no LLM);
 *  - every tool result may advance the current step (weak criterion: the
 *    step's declared tool produced a result — `verify=weak` until Plan P
 *    WP3+WP5 land evidence-based verification, see S4-5);
 *  - before each model call the current step + completion hint is re-injected
 *    through the system-reminder seam, so follow-up turns keep the plan
 *    without re-deriving intent.
 *
 * Cross-process persistence (projection steps_json) is a recorded residual:
 * the scope-run event flow that owns `steps` lives outside this seam; the
 * in-process slot covers the model-facing behavior. State is per main-process
 * lifetime, scoped by the same session key the reminder queue uses.
 */

export interface ActivePlanStep {
  id: string
  title: string
  /** Weak completion criterion: a result from any of these tools advances. */
  advanceOnTools: string[]
  status: 'pending' | 'done'
}

export interface ActivePlan {
  taskGoal: string
  steps: ActivePlanStep[]
  verify: 'weak'
  updatedAtMs: number
}

const plansByScope = new Map<string, ActivePlan>()

/** Plans older than this are stale — do not re-inject. */
const ACTIVE_PLAN_TTL_MS = 30 * 60_000

const COLLECTION_DISPATCH_TOOLS = new Set(['browser_visible_collect', 'browser_collect_notes'])

export function deriveCollectionPlanFromToolCall(
  toolName: string,
  args: Record<string, unknown>,
  nowMs: number,
): ActivePlan | null {
  if (!COLLECTION_DISPATCH_TOOLS.has(toolName)) return null
  const target = typeof args.url === 'string'
    ? args.url
    : typeof args.target_profile_url === 'string'
      ? args.target_profile_url
      : '目标页面'
  return {
    taskGoal: `采集 ${target} 的内容并交付到指定位置`,
    steps: [
      {
        id: 'discover',
        title: '发现并冻结条目清单',
        advanceOnTools: ['browser_visible_collect'],
        status: 'pending',
      },
      {
        id: 'collect',
        title: '启动逐项后台采集',
        advanceOnTools: ['browser_collect_notes'],
        status: 'pending',
      },
      {
        id: 'review',
        title: '复核采集结果并向用户交付（核对数量与失败明细）',
        advanceOnTools: ['browser_get_task'],
        status: 'pending',
      },
    ],
    verify: 'weak',
    updatedAtMs: nowMs,
  }
}

/**
 * Single funnel hook — called for every recorded tool result. Synthesizes the
 * plan on first dispatch and advances the current step on matching results.
 */
export function noteToolResultForActivePlan(
  scope: string | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
  nowMs: number = Date.now(),
): void {
  if (!scope) return
  let plan = plansByScope.get(scope) || null
  if (!plan && COLLECTION_DISPATCH_TOOLS.has(toolName)) {
    plan = deriveCollectionPlanFromToolCall(toolName, args, nowMs)
    if (plan) plansByScope.set(scope, plan)
  }
  if (!plan) return
  const current = plan.steps.find((step) => step.status === 'pending')
  if (!current) return
  if (current.advanceOnTools.includes(toolName)) {
    current.status = 'done'
    plan.updatedAtMs = nowMs
  }
}

export function getActivePlanForScope(scope: string | null | undefined): ActivePlan | null {
  if (!scope) return null
  return plansByScope.get(scope) || null
}

export function clearActivePlanForScope(scope: string): void {
  plansByScope.delete(scope)
}

export function resetActivePlansForTests(): void {
  plansByScope.clear()
}

export function buildActivePlanReminderText(scope: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (!scope) return null
  const plan = plansByScope.get(scope)
  if (!plan) return null
  if (nowMs - plan.updatedAtMs > ACTIVE_PLAN_TTL_MS) return null
  const total = plan.steps.length
  const doneTitles = plan.steps.filter((step) => step.status === 'done').map((step) => step.title)
  const current = plan.steps.find((step) => step.status === 'pending')
  if (!current) {
    // All steps weakly complete — one final delivery nudge, then the plan has
    // served its purpose for re-injection.
    return [
      `[活动计划] 目标：${plan.taskGoal}。`,
      `全部 ${total} 步已按弱判据完成（verify=weak）。请核对交付物与失败明细后向用户收口，不要重新规划。`,
    ].join('')
  }
  const currentIndex = plan.steps.indexOf(current) + 1
  return [
    `[活动计划] 目标：${plan.taskGoal}。`,
    `当前步骤 ${currentIndex}/${total}：${current.title}`,
    `（完成判据：${current.advanceOnTools.join('/')} 工具结果出现；verify=weak）。`,
    doneTitles.length > 0 ? `已完成：${doneTitles.join('、')}。` : '',
    '请按计划推进当前步骤，不要跳步、不要重新规划、不要只口头宣布。',
  ].join('')
}
