import type {
  AgentPanelDiagnostic,
  AgentPanelDiagnosticLayer,
  AgentPanelSnapshot,
} from './agent-panel-test-harness-types'

export function diagnoseAgentPanelSnapshot(snapshot: AgentPanelSnapshot): AgentPanelDiagnostic[] {
  const diagnostics: AgentPanelDiagnostic[] = []
  const activeRun = snapshot.runtime.activeRun
  const lastMessage = snapshot.messages[snapshot.messages.length - 1] || null
  const lastUserIndex = [...snapshot.messages].reverse().findIndex((message) => message.type === 'user')
  const hasUserWithoutReply =
    lastMessage?.type === 'user' &&
    !snapshot.runtime.foregroundBusy &&
    !snapshot.composer.pendingSendCount

  if (!snapshot.currentScopeId) {
    diagnostics.push({
      id: 'scope_missing',
      severity: 'warning',
      layer: 'input',
      message: '当前没有会话 Scope，输入层需要先创建本地会话。',
      evidence: { currentAgent: snapshot.currentAgent },
    })
  }

  if (snapshot.composer.pendingSendCount > 0) {
    diagnostics.push({
      id: 'send_coalescing_pending',
      severity: 'info',
      layer: 'input',
      message: '输入已进入连续消息合并窗口，运行尚未真正开始。',
      evidence: { pendingSendCount: snapshot.composer.pendingSendCount, pendingSendFlushAt: snapshot.composer.pendingSendFlushAt },
    })
  }

  if (lastMessage?.type === 'system' && /发送失败|发送出错|send failed|API Key|模型额度不足|模型服务限流|模型服务暂时不可用|上下文太长|模型响应超时/i.test(lastMessage.content)) {
    diagnostics.push({
      id: 'send_failed_message',
      severity: 'error',
      layer: 'send',
      message: '面板出现发送失败或供应商失败消息，优先检查 sendScoped 返回值、会话持久化或供应商请求错误。',
      evidence: { messageId: lastMessage.id, content: lastMessage.content.slice(0, 240) },
    })
  }

  const leakedToolCallMessage = snapshot.messages.find((message) =>
    message.type === 'agent' && /<tool_call>|<function=|<parameter=|:::tool_call/i.test(message.content),
  )
  if (leakedToolCallMessage) {
    diagnostics.push({
      id: 'raw_tool_call_visible',
      severity: 'error',
      layer: 'renderer',
      message: 'Agent 回复中出现原始工具调用文本，说明文本工具桥没有正确隐藏工具协议。',
      evidence: {
        messageId: leakedToolCallMessage.id,
        content: leakedToolCallMessage.content.slice(0, 240),
      },
    })
  }

  if (activeRun?.softError) {
    diagnostics.push({
      id: 'soft_error_capsule',
      severity: 'warning',
      layer: 'tool',
      message: '当前运行有软失败胶囊，说明工具或外部依赖失败但运行未终止。',
      evidence: { ...activeRun.softError },
    })
  }

  const mapAmbiguityWasClarified = snapshot.toolTrace.some((item) =>
    item.kind === 'result'
    && /^map_plan_route:/i.test(item.text)
    && /"errorKind"\s*:\s*"place_ambiguous"|errorKind.?place_ambiguous/i.test(item.text),
  ) && snapshot.toolTrace.some((item) =>
    item.kind === 'call'
    && /^ask_user_questions\s*(?:\(|:)/i.test(item.text),
  )
  const failedToolResult = snapshot.toolTrace.find((item) => {
    if (item.kind !== 'result') return false
    const text = item.text
    if (
      mapAmbiguityWasClarified
      && /^map_plan_route:/i.test(text)
      && /"errorKind"\s*:\s*"place_ambiguous"|errorKind.?place_ambiguous/i.test(text)
    ) {
      return false
    }
    return /(?:工具 .{0,60}失败|失败：|保存失败|Document action failed|failed|errorKind|escapes sandbox root|path_outside_outputs)/i.test(text)
  })
  if (failedToolResult) {
    diagnostics.push({
      id: 'tool_result_failure',
      severity: 'error',
      layer: 'tool',
      message: '工具结果里出现失败信息，不能只看最终回复判断为通过。',
      evidence: {
        traceId: failedToolResult.id,
        text: failedToolResult.text.slice(0, 300),
      },
    })
  }

  if (activeRun?.phase === 'error' || activeRun?.error) {
    const lastTrace = [...snapshot.toolTrace].reverse().find((item) => item.text)
    const layer: AgentPanelDiagnosticLayer =
      lastTrace && /工具执行失败|tool|file_|browser_|document_|skill_/i.test(lastTrace.text)
        ? 'tool'
        : 'runtime'
    diagnostics.push({
      id: 'active_run_error',
      severity: 'error',
      layer,
      message: activeRun.error || activeRun.blockedReason || '当前运行进入错误态。',
      evidence: {
        phase: activeRun.phase,
        terminalReason: activeRun.terminalReason,
        lastTrace: lastTrace?.text || null,
      },
    })
  }

  if (activeRun?.terminalReason && activeRun.terminalReason !== 'done') {
    const recoverableCheckpoint = activeRun.terminalReason === 'checkpoint_background'
      || activeRun.terminalReason === 'checkpoint_budget'
      || activeRun.terminalReason === 'checkpoint_incomplete'
      || activeRun.terminalReason === 'checkpoint_user_input'
      || activeRun.phase === 'checkpoint'
      || (Boolean(activeRun.waitingFor) && activeRun.waitingFor !== 'none')
    diagnostics.push({
      id: 'non_done_terminal_reason',
      severity: recoverableCheckpoint ? 'info' : activeRun.phase === 'done' ? 'warning' : 'error',
      layer: activeRun.terminalReason.startsWith('blocked_') ? 'tool' : 'runtime',
      message: recoverableCheckpoint
        ? `运行以 ${activeRun.terminalReason} 暂停，已保留可继续状态。`
        : `运行以 ${activeRun.terminalReason} 结束，需要按终态原因继续定位。`,
      evidence: { phase: activeRun.phase, terminalReason: activeRun.terminalReason },
    })
  }

  const callCount = snapshot.toolTrace.filter((item) => item.kind === 'call').length
  const resultCount = snapshot.toolTrace.filter((item) => item.kind === 'result').length
  if (callCount > resultCount && !snapshot.runtime.foregroundBusy) {
    diagnostics.push({
      id: 'tool_call_without_result',
      severity: 'error',
      layer: 'tool',
      message: '存在没有结果的工具调用，工具回执或 renderer-mediated tool ack 可能断了。',
      evidence: { callCount, resultCount },
    })
  }

  if (hasUserWithoutReply) {
    diagnostics.push({
      id: 'user_message_without_reply',
      severity: 'error',
      layer: 'renderer',
      message: '最后一条用户消息后没有运行中状态，也没有 Agent 回复。',
      evidence: { lastUserFromEnd: lastUserIndex },
    })
  }

  if (snapshot.taskCards.length === 0 && activeRun && activeRun.phase !== 'idle') {
    diagnostics.push({
      id: 'task_card_missing',
      severity: 'warning',
      layer: 'projection',
      message: '运行态存在，但没有可读任务卡快照，投影或消息快照可能缺失。',
      evidence: { phase: activeRun.phase, taskTitle: activeRun.taskTitle },
    })
  }

  return diagnostics
}
