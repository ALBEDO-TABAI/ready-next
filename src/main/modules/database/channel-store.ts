import { RemoteChannelEventRepository } from '../agent-control/runtime-core/remote-channel-event-repository'
import type { DatabaseConnection } from './connection'
import type { AgentChannelType, AgentChannelRecord, AgentChannelThreadRecord, AgentChannelEventRecord } from './records'

export class ChannelStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}

  private get db(): DatabaseConnection | null {
    return this.getConnection()
  }


  // ===================== Agent Runtime (channels/schedules) =====================

  listAgentChannels(): AgentChannelRecord[] {
    if (!this.db) return []
    return this.db
      .prepare('SELECT * FROM agent_channels ORDER BY updated_at DESC')
      .all<AgentChannelRecord>()
  }

  getAgentChannel(id: string): AgentChannelRecord | null {
    if (!this.db) return null
    const row = this.db
      .prepare('SELECT * FROM agent_channels WHERE id = ? LIMIT 1')
      .get<AgentChannelRecord>(id)
    return row ?? null
  }

  upsertAgentChannel(payload: {
    id: string
    type: AgentChannelType
    name: string
    enabled: boolean
    configJson: string
    lastError?: string | null
    lastSeenAt?: string | null
  }): AgentChannelRecord {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    const existing = this.getAgentChannel(payload.id)
    this.db.prepare(
      `INSERT INTO agent_channels (id, type, name, enabled, config_json, last_error, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         name = excluded.name,
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         last_error = excluded.last_error,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`
    ).run(
      payload.id,
      payload.type,
      payload.name,
      payload.enabled ? 1 : 0,
      payload.configJson,
      payload.lastError ?? null,
      payload.lastSeenAt ?? null,
      existing?.created_at ?? now,
      now,
    )
    return this.getAgentChannel(payload.id)!
  }

  deleteAgentChannel(id: string): boolean {
    if (!this.db) return false
    const result = this.db.prepare('DELETE FROM agent_channels WHERE id = ?').run(id) as {
      changes?: number
    }
    return (result.changes ?? 0) > 0
  }

  setAgentChannelEnabled(id: string, enabled: boolean): AgentChannelRecord | null {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('UPDATE agent_channels SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id)
    return this.getAgentChannel(id)
  }

  markAgentChannelSeen(id: string, at?: string): AgentChannelRecord | null {
    if (!this.db) throw new Error('Database not available')
    const seenAt = at || new Date().toISOString()
    this.db.prepare('UPDATE agent_channels SET last_seen_at = ?, updated_at = ? WHERE id = ?')
      .run(seenAt, seenAt, id)
    return this.getAgentChannel(id)
  }

  setAgentChannelError(id: string, error: string | null): AgentChannelRecord | null {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('UPDATE agent_channels SET last_error = ?, updated_at = ? WHERE id = ?')
      .run(error, new Date().toISOString(), id)
    return this.getAgentChannel(id)
  }

  getAgentChannelThread(channelId: string, remoteThread: string): AgentChannelThreadRecord | null {
    if (!this.db) return null
    const row = this.db.prepare(
      'SELECT * FROM agent_channel_threads WHERE channel_id = ? AND remote_thread = ? LIMIT 1'
    ).get<AgentChannelThreadRecord>(channelId, remoteThread)
    return row ?? null
  }

  /**
   * Phase I P0 — scope → 渠道线程反查：远程 run 中产生的 ask/confirm 卡带
   * scopeId，转投微信需要还原 (channelId, remoteThread)。取最近更新的一条
   * （同 scope 理论上唯一，upsert 以 channel+thread 为键）。
   */
  getAgentChannelThreadBySession(sessionId: string): AgentChannelThreadRecord | null {
    if (!this.db || !sessionId) return null
    const row = this.db.prepare(
      'SELECT * FROM agent_channel_threads WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1'
    ).get<AgentChannelThreadRecord>(sessionId)
    return row ?? null
  }

  upsertAgentChannelThread(payload: {
    channelId: string
    remoteThread: string
    sessionId: string
    conversationId?: string | null
  }): AgentChannelThreadRecord {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO agent_channel_threads (channel_id, remote_thread, session_id, conversation_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, remote_thread) DO UPDATE SET
         session_id = excluded.session_id,
         conversation_id = excluded.conversation_id,
         updated_at = excluded.updated_at`
    ).run(payload.channelId, payload.remoteThread, payload.sessionId, payload.conversationId ?? null, now)
    return this.getAgentChannelThread(payload.channelId, payload.remoteThread)!
  }

  getAgentChannelEvent(eventId: string): AgentChannelEventRecord | null {
    return this.db ? new RemoteChannelEventRepository(this.db).get(eventId) : null
  }

  upsertAgentChannelEvent(payload: Parameters<RemoteChannelEventRepository['upsert']>[0]): AgentChannelEventRecord {
    if (!this.db) throw new Error('Database not available')
    return new RemoteChannelEventRepository(this.db).upsert(payload)
  }

  failRunningAgentChannelEventsOnBoot(reason?: string): number {
    return this.db ? new RemoteChannelEventRepository(this.db).failRunningOnBoot(reason) : 0
  }

  listPendingAgentChannelEvents(): AgentChannelEventRecord[] {
    return this.db ? new RemoteChannelEventRepository(this.db).listPending() : []
  }
}
