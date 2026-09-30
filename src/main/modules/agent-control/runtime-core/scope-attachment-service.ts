// B8-D R3 — ScopeAttachmentService: conversation-scope attachment listing
// (filtered to files that still exist on disk) and the remote-attachment
// cache stats/clear walkers over the sidecar channel-attachments directory,
// extracted from AgentControlRuntime (runtime.ts) as a delegated sub-service.
// Method bodies are mechanical moves; the only substitution is `this.db` →
// `this.deps.db`. Path deps (`app.getPath('userData')` + fs walkers) stay
// module imports — same shape as the original runtime methods. The service
// owns no state.
import { app } from 'electron'
import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import type { DatabaseManager } from '../../database'
import type { ConversationAttachment } from '../contracts/types'

export interface ScopeAttachmentServiceDeps {
  db: DatabaseManager
}

export class ScopeAttachmentService {
  constructor(private readonly deps: ScopeAttachmentServiceDeps) {}

  listScopeAttachments(scopeId: string): ConversationAttachment[] {
    return this.deps.db
      .chat.listConversationAttachments(scopeId)
      .filter((item) => item.path && existsSync(item.path))
      .map((item) => ({
        attachmentId: item.attachment_id,
        scopeId: item.conversation_id,
        sourceMessageId: item.source_message_id,
        name: item.name,
        path: item.path,
        type: ['image', 'video', 'text', 'spreadsheet', 'other'].includes(String(item.type))
          ? (item.type as ConversationAttachment['type'])
          : 'other',
        size: item.size,
        ext: item.ext,
        url: item.url,
        mimeType: item.mime_type,
        remoteId: item.remote_id,
        channelId: item.channel_id,
        threadKey: item.thread_key,
        createdAt: item.created_at
      }))
  }

  getScopeAttachment(scopeId: string, attachmentId: string): ConversationAttachment | null {
    return (
      this.listScopeAttachments(scopeId).find((item) => item.attachmentId === attachmentId) || null
    )
  }

  getRemoteAttachmentCacheStats(channelId?: string): {
    totalFiles: number
    totalBytes: number
    targetPath: string
    channels: Array<{ channelId: string; files: number; bytes: number }>
  } {
    const basePath = join(app.getPath('userData'), 'agent-sidecar-runtime', 'channel-attachments')
    const targetPath = channelId ? join(basePath, channelId) : basePath
    let totalFiles = 0
    let totalBytes = 0
    const byChannel = new Map<string, { files: number; bytes: number }>()

    const walk = (currentPath: string, currentChannelId?: string): void => {
      if (!existsSync(currentPath)) return
      const stat = statSync(currentPath)
      if (stat.isFile()) {
        totalFiles += 1
        totalBytes += stat.size
        if (currentChannelId) {
          const current = byChannel.get(currentChannelId) || { files: 0, bytes: 0 }
          current.files += 1
          current.bytes += stat.size
          byChannel.set(currentChannelId, current)
        }
        return
      }
      if (!stat.isDirectory()) return
      for (const entry of readdirSync(currentPath)) {
        const nextPath = join(currentPath, entry)
        const nextChannelId =
          currentChannelId || (!channelId && currentPath === basePath ? entry : currentChannelId)
        walk(nextPath, nextChannelId)
      }
    }

    walk(targetPath, channelId || undefined)

    return {
      totalFiles,
      totalBytes,
      targetPath,
      channels: Array.from(byChannel.entries()).map(([itemChannelId, value]) => ({
        channelId: itemChannelId,
        files: value.files,
        bytes: value.bytes
      }))
    }
  }

  clearRemoteAttachmentCache(channelId?: string): {
    removedFiles: number
    removedBytes: number
    targetPath: string
  } {
    const basePath = join(app.getPath('userData'), 'agent-sidecar-runtime', 'channel-attachments')
    const targetPath = channelId ? join(basePath, channelId) : basePath
    let removedFiles = 0
    let removedBytes = 0

    const walk = (currentPath: string): void => {
      if (!existsSync(currentPath)) return
      const stat = statSync(currentPath)
      if (stat.isFile()) {
        removedFiles += 1
        removedBytes += stat.size
        return
      }
      if (!stat.isDirectory()) return
      for (const entry of readdirSync(currentPath)) {
        walk(join(currentPath, entry))
      }
    }

    walk(targetPath)
    rmSync(targetPath, { recursive: true, force: true })
    return { removedFiles, removedBytes, targetPath }
  }
}
