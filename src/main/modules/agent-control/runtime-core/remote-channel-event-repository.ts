import type { DatabaseConnection } from '../../database/connection'

export interface AgentChannelEventRecord {
  payload_json: string | null
  event_id: string
  channel_id: string
  status: string
  error: string | null
  created_at: string
  updated_at: string
}

export class RemoteChannelEventRepository {
  constructor(private readonly db: DatabaseConnection) {}

  listPending(): AgentChannelEventRecord[] {
    if (!this.db) return []
    return this.db.prepare("SELECT * FROM agent_channel_events WHERE (status IN ('queued', 'reply_pending') OR (status = 'failed' AND error = 'app_restart_before_inbound_settlement')) AND payload_json IS NOT NULL ORDER BY created_at, rowid").all<AgentChannelEventRecord>()
  }

  get(eventId: string): AgentChannelEventRecord | null {
    if (!this.db) return null
    const row = this.db.prepare(
      'SELECT * FROM agent_channel_events WHERE event_id = ? LIMIT 1'
    ).get<AgentChannelEventRecord>(eventId)
    return row ?? null
  }

  upsert(payload: {
    eventId: string
    channelId: string
    status: string
    error?: string | null
    payloadJson?: string
  }): AgentChannelEventRecord {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    const existing = this.get(payload.eventId)
    this.db.prepare(
      `INSERT INTO agent_channel_events (event_id, channel_id, status, error, created_at, updated_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         status = excluded.status,
         payload_json = COALESCE(excluded.payload_json, agent_channel_events.payload_json),
         error = excluded.error,
         updated_at = excluded.updated_at`
    ).run(
      payload.eventId,
      payload.channelId,
      payload.status,
      payload.error ?? null,
      existing?.created_at ?? now,
      now,
      payload.payloadJson ?? null,
    )
    return this.get(payload.eventId)!
  }

  /** A previously running request must be reported as interrupted, never automatically executed again. */
  failRunningOnBoot(
    reason: string = 'app_restart_before_inbound_settlement',
  ): number {
    if (!this.db) return 0
    const result = this.db.prepare(
      `UPDATE agent_channel_events
          SET status = 'failed', error = ?, updated_at = ?
        WHERE status = 'running'`,
    ).run(reason, new Date().toISOString()) as { changes?: number }
    return Number(result.changes || 0)
  }

}
