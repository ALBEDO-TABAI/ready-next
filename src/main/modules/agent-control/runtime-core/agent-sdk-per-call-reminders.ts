import type { TaskBudgetRuntime, TaskType } from '../contracts/run-contracts'
import {
  drainBackgroundTaskTerminalReminders,
  prependSystemReminderInput,
  registerBackgroundTaskTerminalReminder
} from '../system-reminders/background-task-terminal-reminder'
import {
  browserResearchProgressDigest,
  registerBrowserResearchProgressReminder
} from '../system-reminders/browser-research-progress-reminder'
import { registerCriteriaSelfCheckReminder } from '../system-reminders/criteria-self-check-reminder'
import { createSystemReminderRegistry } from '../system-reminders/system-reminder-registry'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import type { ReadyAgentSdkRunParams } from './agent-sdk-types'

/**
 * 模型调用前的系统提醒组装（从 turn-model-loop 外提的 leaf）。
 * 输入是模型循环的可变 state 切片：本函数只做三类注入并原地更新
 * nextInput / criteriaSelfCheckInjected / sessionRestoreNotice。
 */
interface PerCallReminderState {
  criteriaSelfCheckInjected: boolean
  liveTaskBudgetRuntime: TaskBudgetRuntime | null
  nextInput: ReadyAgentSdkRunParams['input']
  sessionRestoreNotice: string | null
}

interface ResearchReminderTracking {
  digest: string | null
  cooldown: number
}

// 账本提醒的重注节流：digest 变化立即注入；digest 不变时每 N 次模型调用
// 重注一次，保证上下文压缩把旧提醒挤掉后模型仍会周期性重新对齐持久进度。
const RESEARCH_PROGRESS_REINJECT_EVERY_CALLS = 3

const researchReminderTrackingByRun = new WeakMap<object, ResearchReminderTracking>()

export function applyPerCallSystemReminders(input: {
  state: PerCallReminderState
  /** run 级稳定对象（如 runHandle），承载跨 bridge-turn 的注入节流状态。 */
  runScopeKey: object
  sessionId: string | undefined
  turnTaskType: TaskType
  host: Pick<TurnOrchestratorHost, 'readVerifiedBrowserWorkflowEvidence'>
  browserWorkflowRoute: { browserTaskId: string } | null
}): void {
  const { state } = input
  const terminalReminderTexts = drainBackgroundTaskTerminalReminders(input.sessionId)
  if (state.sessionRestoreNotice) {
    terminalReminderTexts.unshift(state.sessionRestoreNotice)
    state.sessionRestoreNotice = null
  }
  const registry = createSystemReminderRegistry()
  if (terminalReminderTexts.length > 0) {
    registerBackgroundTaskTerminalReminder(registry, terminalReminderTexts)
  }
  // D2 — 结果型任务的验收标准（事中自检），与终态裁决同一模板源。
  // 每 run 只注入一次（首个模型调用）：criteria 是 run 级静态清单，
  // 重复注入既费 token 也会改变后续迭代（如 text-bridge 回喂）的
  // 输入形状。非结果型任务在 builder 内跳过。
  if (!state.criteriaSelfCheckInjected) {
    state.criteriaSelfCheckInjected = registerCriteriaSelfCheckReminder(
      registry,
      state.liveTaskBudgetRuntime?.taskType || input.turnTaskType
    )
  }
  registerResearchProgressLedgerIfDue(registry, input)
  const reminderText = registry.compose()
  if (reminderText) {
    state.nextInput = prependSystemReminderInput(state.nextInput, reminderText)
  }
}

function registerResearchProgressLedgerIfDue(
  registry: ReturnType<typeof createSystemReminderRegistry>,
  input: {
    runScopeKey: object
    host: Pick<TurnOrchestratorHost, 'readVerifiedBrowserWorkflowEvidence'>
    browserWorkflowRoute: { browserTaskId: string } | null
  },
): void {
  if (!input.browserWorkflowRoute) return
  try {
    const evidence = input.host.readVerifiedBrowserWorkflowEvidence(
      input.browserWorkflowRoute.browserTaskId,
    )
    const assessment = evidence?.researchAssessment
    if (!assessment || assessment.workItems.length === 0) return
    const tracking = researchReminderTrackingByRun.get(input.runScopeKey)
      ?? { digest: null, cooldown: 0 }
    const digest = browserResearchProgressDigest(assessment)
    tracking.cooldown -= 1
    if (digest !== tracking.digest || tracking.cooldown <= 0) {
      registerBrowserResearchProgressReminder(registry, assessment)
      tracking.digest = digest
      tracking.cooldown = RESEARCH_PROGRESS_REINJECT_EVERY_CALLS
    }
    researchReminderTrackingByRun.set(input.runScopeKey, tracking)
  } catch {
    // silent-catch: 进度账本提醒是辅助注入；证据暂不可读时跳过本轮，绝不阻断模型调用。
  }
}
