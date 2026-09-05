import { createHash } from 'node:crypto'
import { logAgentMetric } from '../metrics'
import type { SendScopedRequest, SendScopedResponse } from '../../../../shared/ipc-contracts/agent-runtime'
import type { ChannelAttachment, ConversationScope } from '../contracts/types'

export async function runRemoteCodexTurn(input: {
  scope: ConversationScope
  eventIds: string[]
  text: string
  attachments: ChannelAttachment[]
  channelId: string
  thread: string
  sender: string
}, send: (request: SendScopedRequest) => Promise<SendScopedResponse>): Promise<string> {
  const identity = createHash('sha256').update(JSON.stringify([
    input.channelId, input.scope.id, input.scope.messageVisibilityEpoch, input.eventIds,
  ])).digest('hex').slice(0, 32)
  const resources = input.attachments.map((item, index) => ({
    kind: 'local_file' as const,
    id: `remote-${identity}-${index}`,
    name: item.name,
    path: item.path || '',
    size: item.size || 0,
    ext: item.ext || '',
    rendererType: item.type === 'video' ? 'other' as const : item.type || 'other' as const,
  }))
  const result = await send({
    scopeId: input.scope.id,
    requestId: `remote-${identity}`,
    expectedAliasGeneration: input.scope.aliasGeneration ?? undefined,
    expectedMessageVisibilityEpoch: input.scope.messageVisibilityEpoch,
    message: input.text,
    resources,
    userMessage: {
      id: `msg-remote-${identity}`,
      content: input.text,
      timestamp: new Date().toISOString(),
      meta: { source: 'channel', workbenchMode: 'browser', channelId: input.channelId, threadKey: input.thread, sender: input.sender,
        direction: 'inbound', eventIds: input.eventIds, attachments: input.attachments },
      attachmentConfirmation: { selectedCount: resources.length, metadataCount: resources.length,
        inputIncludedCount: resources.length, inputFailedCount: 0 },
    },
  })
  if (result.success && result.canonicalMessage?.content) return result.canonicalMessage.content
  if (!result.success) {
    logAgentMetric('remote_codex_ingress_failed', { scopeId: input.scope.id, disposition: result.disposition, errorKind: result.errorKind,
      errorCode: /^[A-Za-z0-9_.:-]{1,200}$/.test(result.error) ? result.error : 'see_local_run_details' })
    return result.canonicalMessage?.content
      ? `这次任务没有完成。\n\n${result.canonicalMessage.content}`
      : '这次任务没有完成。请在 Ready 中查看这条会话的处理状态，再重新发送任务。'
  }
  return '任务已处理完成，请在 Ready 中查看结果。'
}
