export function normalizeChannelDeliveryResult(
  response: unknown,
  fallbackError: string,
): { success: boolean; error?: string } {
  const record = response && typeof response === 'object'
    ? response as Record<string, unknown>
    : null
  if (!record) return { success: true }
  if (record.success === false || (record.success !== true && typeof record.error === 'string' && record.error.trim())) {
    return {
      success: false,
      error: normalizeChannelDeliveryError(
        typeof record.error === 'string' && record.error.trim()
          ? record.error.trim()
          : fallbackError,
      ),
    }
  }
  return { success: true }
}

function normalizeChannelDeliveryError(error: string): string {
  const sendMessageRet = error.match(/ret\s*=\s*(-[23])\b/i)?.[1] || ''
  if (sendMessageRet && /sendmessage/i.test(error)) {
    return [
      `微信出站发送会话已失效：ret=${sendMessageRet} (sendmessage)。`,
      '这不是文件大小或文件类型问题；请先从微信给 Ready 发一条新消息后重试，仍失败就重新绑定微信。',
    ].join('')
  }
  return error
}
