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

  if (errorKind === 'scope_missing' || /Conversation scope not found:/i.test(error)) {
    return {
      friendlyMessage: '会话信息异常，正在尝试恢复',
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

  if (/scope_id is required/i.test(error)) {
    return {
      friendlyMessage: '操作失败，请刷新会话',
      technicalDetails: error || undefined,
      recoverable: false,
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

  return {
    friendlyMessage: '发送失败',
    technicalDetails: error || undefined,
    recoverable: false,
    retryStrategy: 'none',
  }
}
