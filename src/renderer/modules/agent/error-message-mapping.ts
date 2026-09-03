export interface FriendlyError {
  friendlyMessage: string
  technicalDetails?: string
  recoverable: boolean
  retryStrategy: 'auto' | 'user_action' | 'none'
}

export function mapBackendErrorToFriendly(input: {
  error?: string | null
  errorKind?: string | null
}): FriendlyError {
  const error = String(input.error || '').trim()
  const errorKind = String(input.errorKind || '').trim()
  const source = `${errorKind}\n${error}`
  const normalized = source.toLowerCase()

  if (errorKind === 'scope_missing' || /Conversation scope not found:/i.test(error)) {
    return {
      friendlyMessage: '对话环境还在准备，请稍后再发送',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'auto',
    }
  }

  if (
    errorKind === 'attachment_unavailable' ||
    errorKind === 'attachment_persist_failed' ||
    /Attachment not found:|ENOENT|file not found/i.test(error)
  ) {
    return {
      friendlyMessage: '附件读取失败，请重新选择文件',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (errorKind === 'message_persist_failed') {
    return {
      friendlyMessage: '消息保存失败，请重试',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (errorKind === 'superseded') {
    return {
      friendlyMessage: '已由新消息接管，可以继续发送',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (errorKind === 'renderer_infrastructure_timeout') {
    return {
      friendlyMessage: '这次请求超时，Ready 已接管收口，可以继续发送',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (errorKind === 'main_no_progress_timeout') {
    return {
      friendlyMessage: '这次请求长时间没有进展，Ready 已接管收口，可以继续发送',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (errorKind === 'delivery_failed' && /delivery_wall_clock_exceeded/i.test(error)) {
    return {
      friendlyMessage: '这次任务持续一段时间没有新进展，Ready 已安全停止；目标尚未完成，可以继续这项任务',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (/scope_id is required/i.test(error)) {
    return {
      friendlyMessage: '操作失败，请刷新会话',
      technicalDetails: error || undefined,
      recoverable: false,
      retryStrategy: 'user_action',
    }
  }

  if (/gateway_reasoning_(capability_unsupported|policy_unsupported|effort_mismatch)/i.test(source)) {
    return {
      friendlyMessage: '当前模型的推理设置不匹配，请重新选择模型或推理强度',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (
    errorKind === 'capability_unavailable'
    || /tool_surface_result_state_unsupported|tool_surface_skill_execution_unsupported|tool_surface_empty/i.test(source)
  ) {
    return {
      friendlyMessage: '当前技能的这项执行能力还不能在这一轮使用；技能方法论和普通搜索、文档、文件夹工具仍可用，请去掉不支持的技能动作后再试',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (/requires_new_(thread|generation)/i.test(source)) {
    return {
      friendlyMessage: '当前对话的能力规则已更新，这一轮无法继续；请新建对话后再试',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (
    errorKind === 'conversation_materializing'
    || /codex_conversation_materializing/i.test(source)
  ) {
    return {
      friendlyMessage: '正在衔接上一段对话，完成后可以继续发送。',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'auto',
    }
  }

  if (
    errorKind === 'conversation_reset_required'
    || /codex_conversation_reset_required|codex_alias_generation_mismatch/i.test(source)
  ) {
    return {
      friendlyMessage: '当前对话无法在这一轮继续，请新建对话后再试',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (/(^|\n)(host_unavailable|circuit_break)(\n|$)|ToolHostUnavailableError|circuit breaker/i.test(source)) {
    return {
      friendlyMessage: '服务暂时不可用，稍后重试',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'auto',
    }
  }

  if (
    errorKind === 'quota_exceeded' ||
    /\bhttp\s*402\b/i.test(source) ||
    /insufficient[\s_-]*(balance|funds|credits|quota)|quota_exceeded|额度不足|余额不足|套餐|billing|payment_required/i.test(source)
  ) {
    return {
      friendlyMessage: '模型额度不足，请检查外部服务配置或账号余额',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (
    errorKind === 'auth_required' ||
    errorKind === 'auth' ||
    errorKind === 'configuration_unavailable' ||
    errorKind === 'blocked_config' ||
    /\bhttp\s*(401|403)\b/i.test(source) ||
    /invalid[\s_-]*(api[\s_-]*)?key|invalid_key|unauthorized|forbidden|permission_denied|api key/i.test(source)
  ) {
    return {
      friendlyMessage: 'API Key 无效或没有权限，请检查设置里的模型配置',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (errorKind === 'external_service_unavailable') {
    return {
      friendlyMessage: '模型服务暂时不可用，请稍后重试',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'auto',
    }
  }

  if (
    errorKind === 'rate_limited' ||
    errorKind === 'rate_limit' ||
    /\bhttp\s*429\b/i.test(source) ||
    /rate[\s_-]*limit|too many requests|retry-after|限流|请求过快/i.test(source)
  ) {
    return {
      friendlyMessage: '模型服务限流，请稍后重试',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'auto',
    }
  }

  if (
    errorKind === 'context_overflow' ||
    /\bhttp\s*413\b/i.test(source) ||
    /context[\s_-]*(length|window)|maximum[\s_-]*context|too[\s_-]*many[\s_-]*tokens|上下文|内容太长/i.test(source)
  ) {
    return {
      friendlyMessage: '上下文太长，请缩短内容或先压缩后重试',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (
    errorKind === 'checkpoint_budget' ||
    /Max turns \(\d+\) exceeded|工具调用次数已用完|任务步骤已用完|budget_exhausted/i.test(source)
  ) {
    return {
      friendlyMessage: '本轮步骤已用完，请继续这项任务',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (errorKind === 'timeout_tool') {
    return {
      friendlyMessage: '工具响应超时，请稍后重试或继续这项任务',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (errorKind === 'timeout_model' || /timeout|timed out|请求超时/i.test(source)) {
    return {
      friendlyMessage: '模型响应超时，请稍后重试',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'auto',
    }
  }

  if (errorKind === 'proof_gap') {
    return {
      friendlyMessage: '这轮还没完整完成，可以继续发送',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (errorKind === 'adjudication_degraded') {
    return {
      friendlyMessage: '已生成结果，但仍有待确认项，可以继续补齐',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (errorKind === 'browser_transaction_unconfirmed') {
    return {
      friendlyMessage: '网页操作还没有成功证据，可以继续这项任务',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (
    errorKind === 'provider_thinking_echo_required' ||
    /thinking[\s_-]*block|extended[\s_-]*thinking|reasoning[\s_-]*replay|prior[\s_-]*thinking/i.test(source)
  ) {
    return {
      friendlyMessage: '模型需要保留推理上下文，请重新发送或切换模型配置',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (/API 返回了网页内容|不是 JSON|provider_protocol_mismatch|供应商协议不匹配/i.test(source)) {
    return {
      friendlyMessage: 'API 地址不是模型接口，请在设置中检查地址（OpenAI 兼容服务通常以 /v1 结尾）',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'user_action',
    }
  }

  if (
    errorKind === 'network' ||
    errorKind === 'transient' ||
    errorKind === 'blocked_external' ||
    /enotfound|econnrefused|econnreset|eai_again|tls|fetch failed|network|socket hang up/i.test(normalized)
  ) {
    return {
      friendlyMessage: '模型服务暂时不可用，稍后重试',
      technicalDetails: error || undefined,
      recoverable: true,
      retryStrategy: 'auto',
    }
  }

  return {
    friendlyMessage: '发送失败',
    technicalDetails: error || undefined,
    recoverable: false,
    retryStrategy: 'none',
  }
}
