import type { Reminder } from '../../../shared/calendar-types'
export type { EventInstance, EventOverride } from '../calendar-engine/rrule-engine'
export type { ImportedEvent } from '../calendar-engine/ics-importer'


// --- Exported Type Interfaces ---

export interface RSSSource {
  id: string
  name: string
  url: string
  group_name: string
  icon: string | null
  last_fetched: number | null
  fetch_interval: number
  enabled: number
  created_at: number
  platform?: string
  draft_seeded?: number
}


export interface RSSItem {
  id: string
  source_id: string
  guid: string
  title: string
  link: string
  summary: string | null
  cover_image: string | null
  author: string | null
  published_at: number | null
  fetched_at: number
  inbox_visible?: number
  read: number
  starred: number
  ai_score: number | null
  ai_tags: string | null
}


export interface RSSDraftStoreSourceSummary {
  source_id: string
  source_name: string
  source_url: string
  platform: string
  stored_count: number
  inbox_count: number
  starred_count: number
  draft_seeded: number
  last_fetched: number | null
}


export interface RSSStats {
  totalSources: number
  totalItems: number
  unreadItems: number
  platformDistribution: Record<string, number>
  categoryDistribution: Record<string, number>
}


export type RSSAnalysisAction = 'copy' | 'visual'


export type RSSAnalysisJobStatus =
  | 'queued'
  | 'paused'
  | 'running_script'
  | 'running_subagent'
  | 'success'
  | 'failed'
  | 'skipped'


export interface RSSAnalysisJob {
  id: string
  item_id: string
  action: RSSAnalysisAction
  source_url: string
  title: string
  target_dir: string
  output_dir: string
  report_path: string | null
  status: RSSAnalysisJobStatus
  progress: number
  message: string | null
  error: string | null
  meta_json: string | null
  created_at: string
  started_at: string | null
  updated_at: string
  finished_at: string | null
}


export interface CalendarSource {
  id: string
  name: string
  color: string
  type: string
  sync_url: string | null
  sync_interval: number
  enabled: number
  created_at: number
}


/**
 * Decoded view of a calendar event row used by repository / IPC / scheduler.
 * `reminders` is the parsed `Reminder[]` (or null when absent / malformed).
 * This is the type the rest of the codebase consumes.
 */
export interface CalendarEvent {
  id: string
  calendar_id: string
  title: string
  description: string | null
  location: string | null
  start_time: number
  end_time: number
  all_day: number
  recurrence_rule: string | null
  reminders: Reminder[] | null
  /** L4-A — IANA tz (e.g. 'Asia/Shanghai'); null = local timezone. */
  start_tz: string | null
  /** L4-A — IANA tz; null = local timezone. */
  end_tz: string | null
  /** L4-B — VEVENT UID for rows imported from external feeds; null for local rows. */
  ics_uid: string | null
  /** L4-B — `calendar_sources.id` that produced this row; null for local rows. */
  source_id: string | null
  created_at: number
  updated_at: number
}


export interface BrowserBookmark {
  id: string
  url: string
  title: string
  favicon: string | null
  type: string
  parent_id: string | null
  position: number
  tags: string | null
  notes: string | null
  source: string | null
  created_at: number
}


export interface BrowserHistoryEntry {
  id: string
  url: string
  title: string
  favicon: string | null
  visit_count: number
  last_visit_time: number
  transition: string | null
  session_id: string | null
  domain: string
  visited_at: number
}


export interface BrowserDownload {
  id: string
  url: string
  filename: string
  save_path: string
  total_bytes: number
  received_bytes: number
  state: string
  mime_type: string | null
  error: string | null
  end_time: number | null
  can_resume: number
  updated_at?: number
  created_at: number
}


export interface BrowserTaskRecord {
  id: string
  kind: string
  status: string
  payload_json: string
  checkpoint_json: string | null
  result_json: string | null
  progress_total: number
  progress_completed: number
  progress_failed: number
  current_label: string | null
  error: string | null
  created_at: string
  started_at: string | null
  updated_at: string
  finished_at: string | null
}


export type AgentChannelType =
  | 'local-debug'
  | 'generic-webhook'
  | 'feishu-bot'
  | 'feishu-app'
  | 'telegram-bot'
  | 'wechat-openclaw'


export interface AgentChannelRecord {
  id: string
  type: AgentChannelType
  name: string
  enabled: number
  config_json: string
  last_error: string | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}


export interface AgentChannelThreadRecord {
  channel_id: string
  remote_thread: string
  session_id: string
  conversation_id: string | null
  updated_at: string
}


export interface AgentChannelEventRecord {
  event_id: string
  channel_id: string
  status: string
  error: string | null
  created_at: string
  updated_at: string
}


export type ConversationSourceKind = 'local' | 'channel'


export interface ChatConversationRecord {
  id: string
  agent: string
  active_agent_id?: string | null
  handoff_generation?: number | null
  user_id?: string | null
  title: string
  parent_conversation_id?: string | null
  lineage_root_id?: string | null
  resume_title?: string | null
  source_kind: ConversationSourceKind
  source_id: string
  thread_key: string
  meta_json: string | null
  created_at: string
  updated_at: string
}


export type UpsertConversationScopeMode = 'inserted' | 'reused'


export interface UpsertConversationScopeResult {
  row: ChatConversationRecord
  mode: UpsertConversationScopeMode
}


export interface ChatMessageRecord {
  id: string
  conversation_id: string
  role: string
  content: string
  timestamp: string
  meta_json: string | null
}


export interface ConversationAttachmentRecord {
  attachment_id: string
  conversation_id: string
  source_message_id: string
  name: string
  path: string
  type: string
  size: number
  ext: string
  url: string | null
  mime_type: string | null
  remote_id: string | null
  channel_id: string | null
  thread_key: string | null
  created_at: string
}
