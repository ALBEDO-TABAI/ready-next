import { useAgent } from '../../stores/useAgent'
import { codexHeadActionAdmissionRef } from '../agent/productTurnReceipt'
import { mapBackendErrorToFriendly } from '../agent/error-message-mapping'
import { normalizeSessionSlice, sessionKeyForScopeId } from '../agent/runtime-driver-session-state'
import { requestBrowserTaskReread, setBrowserTaskAction, useBrowserTaskWork } from './browser-task-work'

// The one button after an interruption (W7 §4.7, T7): "我处理好了，继续" / "让助手接着做" / "重新尝试". It passes ids
// only; Main writes the fixed sentence as a new message from the person and admits it like any message, so the run
// that follows is a new, fully admitted turn, never a continuation of the old one.

const HELP_REFUSALS: Array<[code: string, message: string]> = [
  ['browser_attention_already_sent', '已经交给助手了。'],
  ['browser_attention_stale', '这条提示已经过时了，以最新的状态为准。'],
  ['browser_attention_scope_changed', '这段对话已经变了，不能从这里继续。'],
  ['browser_attention_target_changed', '这个页面已经变了，请让助手重新打开它。'],
  ['browser_attention_admission_ref_required', '对话还没准备好，请稍后再试。'],
  ['browser_attention_database_unavailable', '暂时读不到对话记录，请稍后再试。'],
]

/** A refusal in the person's words: Main's attention checks first, then everything an ordinary send can be told. */
export function browserTaskHelpRefusal(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const known = HELP_REFUSALS.find(([code]) => text.includes(code))
  return known ? known[1] : mapBackendErrorToFriendly({ error: text, errorKind: null }).friendlyMessage
}

// The send gate's blockers that read differently here than under the composer (there is no draft to keep).
const GATE_REFUSALS: Record<string, string> = {
  head_unavailable: '暂时读不到这段对话的状态，请稍后再试。',
  thread_busy: '助手还在忙，等这一轮结束再继续。',
  closed: '这段对话已经关闭，不能从这里继续。',
}
export function browserTaskGateRefusal(blocker: string): string {
  return GATE_REFUSALS[blocker] ?? mapBackendErrorToFriendly({ error: blocker, errorKind: blocker }).friendlyMessage
}

export const browserTaskHelpMessageId = (browserTaskId: string, attentionId: string) => `browser-help:${browserTaskId}:${attentionId}`

/**
 * Sends the help input for a task's current need. The admission reference is read from the conversation's current
 * action surface, as an ordinary send uses it; a refusal (no model, the conversation moved on) stays on the card and
 * the band in plain words.
 */
export async function sendBrowserTaskHelp(browserTaskId: string): Promise<void> {
  const task = useBrowserTaskWork.getState().tasks[browserTaskId]
  const attention = task?.attention
  if (!task || !attention) return
  const pending = useBrowserTaskWork.getState().actions[browserTaskId]
  if (pending && pending.attentionId === attention.id && pending.phase !== 'refused') return
  const refuse = (message: string) => setBrowserTaskAction(browserTaskId, { attentionId: attention.id, phase: 'refused', message })
  const scopeId = task.scopeId ?? useAgent.getState().currentScopeId
  const agent = typeof window === 'undefined' ? null : window.electronAPI?.agent
  if (!scopeId || !agent?.readCodexActionSurface || !agent.actOnBrowserTaskAttention) {
    refuse('先打开这段对话，再继续。')
    return
  }
  setBrowserTaskAction(browserTaskId, { attentionId: attention.id, phase: 'sending' })

  // The task's conversation is the one the assistant shows, so the input and the run that follows are visible.
  if (useAgent.getState().currentScopeId !== scopeId) await useAgent.getState().setCurrentScope(scopeId)
  const state = useAgent.getState()
  const slice = normalizeSessionSlice(state.sessions[sessionKeyForScopeId(state, scopeId)])
  const aliasGeneration = typeof slice.aliasGeneration === 'number'
    ? slice.aliasGeneration
    : state.scopes.find(scope => scope.id === scopeId)?.aliasGeneration
  if (typeof aliasGeneration !== 'number') {
    refuse('对话还没准备好，请稍后再试。')
    return
  }

  let surface: Awaited<ReturnType<typeof agent.readCodexActionSurface>>
  try {
    // Main sends the help input as a browser-mode message, so the head is read for the browser.
    surface = await agent.readCodexActionSurface({ aliasId: scopeId, aliasGeneration, workbenchMode: 'browser' })
  } catch (error) {
    /* silent-catch: the refusal is shown on the band and the card in plain words. */
    refuse(browserTaskHelpRefusal(error))
    return
  }
  if (!surface.success || !surface.data) {
    refuse(browserTaskGateRefusal('head_unavailable'))
    return
  }
  if (surface.data.state !== 'active_head') {
    refuse(browserTaskGateRefusal('conversation_reset_required'))
    return
  }
  const head = surface.data.head
  const gate = head.actions.send_new_message
  const actionAdmissionRef = codexHeadActionAdmissionRef(head)
  if (gate.availability !== 'ready' || !actionAdmissionRef) {
    refuse(browserTaskGateRefusal(gate.blockers[0] || 'head_unavailable'))
    return
  }

  // Main admits the input before the run starts and answers only when the run ends: the admission is when the
  // conversation shows the new message and the need clears.
  const messageId = browserTaskHelpMessageId(browserTaskId, attention.id)
  let admitted = false
  const stopWatching = agent.onIngressAdmitted?.(event => {
    if (event.originUserMessageId !== messageId) return
    admitted = true
    setBrowserTaskAction(browserTaskId, { attentionId: attention.id, phase: 'sent' })
    // The need clears through Main's attention push; the conversation re-reads to show the new message.
    void useAgent.getState().loadScope(scopeId)
  })
  try {
    const result = await agent.actOnBrowserTaskAttention({
      browserTaskId,
      attentionId: attention.id,
      expectedMessageVisibilityEpoch: surface.data.scopeEpoch,
      expectedAliasGeneration: head.actionHeadIdentity?.aliasGeneration ?? aliasGeneration,
      actionAdmissionRef,
    })
    if (!result.success && result.disposition === 'rejected_before_persistence') {
      refuse(mapBackendErrorToFriendly({ error: result.error, errorKind: result.errorKind }).friendlyMessage)
    } else {
      setBrowserTaskAction(browserTaskId, null)
      if (admitted || result.success) void useAgent.getState().loadScope(scopeId)
    }
  } catch (error) {
    /* silent-catch: Main's refusal is shown on the band and the card in plain words. */
    refuse(browserTaskHelpRefusal(error))
  } finally {
    stopWatching?.()
    void requestBrowserTaskReread('acted', [browserTaskId])
  }
}
