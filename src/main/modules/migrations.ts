import { migrateObjectLinks } from './search-engine/object-link-schema'
import { migrateObjects, OBJECT_MIGRATION } from './object-service/schema'
import { migrateSearchReadyRefs } from './search-engine/ready-ref-migration'
import { migrateCalendarUnion, CALENDAR_UNION_MIGRATION } from './calendar-engine/calendar-schema'
import { migrateRSSDigests, RSS_DIGEST_MIGRATION } from './rss-engine/digest-schema'
import { migrateRSSCatalog, RSS_CATALOG_MIGRATION } from './rss-engine/catalog-schema'
import { migrateRSSMethodValidity, RSS_METHOD_VALIDITY_MIGRATION } from './rss-engine/method-validity-schema'
import { migrateRSSTranslations, RSS_TRANSLATION_MIGRATION } from './rss-engine/translation-schema'
import { migrateRSSResults, RSS_RESULT_MIGRATION } from './rss-engine/result-schema'
import { migrateRSSOrganization, RSS_ORGANIZATION_MIGRATION } from './rss-engine/organization-schema'
import { migrateRSSProcessing, RSS_PROCESSING_MIGRATION } from './rss-engine/processing-schema'
import { migrateRSSEvents, RSS_EVENT_MIGRATION } from './rss-engine/event-schema'
import { migrateRSSContent, RSS_CONTENT_MIGRATION } from './rss-engine/content-schema'
/**
 * Database migration system for Ready V5.
 *
 * Migrations are applied in order and tracked in the `migrations` table.
 * Each migration is wrapped in a transaction so a failure rolls back cleanly.
 * All schema DDL uses CREATE TABLE/INDEX IF NOT EXISTS for safety against
 * partially-migrated databases.
 */

import { DEFAULT_AGENT_PERSONAS } from './claude-bridge/default-personas'
import {
  applyCodexBeginNewContextArchiveSourceMigration,
} from './agent-control/codex-runtime/codex-thread-archive-schema'
import {
  BUILTIN_AGENT_IDS,
  BUILTIN_AGENT_META,
  type BuiltinAgentId,
  defaultAgentDisplayName,
  isReservedAgentSlug,
  normalizeAgentLifecycleStatus,
  normalizeAgentSlug,
} from '../../shared/agent-identity'
import type { ScheduleSpecV1 } from '../../shared/scheduled-tasks'
import { BROWSER_CHECKPOINT_WAKE_KINDS } from '../../shared/browser-workflow-control'
import { migrateCanonicalRSSItemIdentities } from './rss-engine/item-identity-migration'
import { migrateFalseFailedDirectAnswers } from './agent-control/task-projection/direct-answer-history-migration'
import {
  applyCodexE5BudgetAdmissionMigration,
  applyCodexBrowserVerifierReceiptMigration,
  applyCodexGatewayTurnClaimMigration,
  applyCodexGatewayCompletionEvidenceMigration,
  applyCodexFenceOwnerTransferMigration,
  applyCodexHostFailureCloseoutMigration,
  applyCodexLifecycleRecoveryEvidenceMigration,
  applyCodexManualCompactionRecoveryEvidenceMigration,
  applyCodexManualCompactionItemIdentityMigration,
  applyCodexProductRecoveryFailureMigration,
  applyCodexPristineContractRefreshMigration,
  applyCodexStartupOwnerHandoffMigration,
  applyCodexThreadResumeEvidenceMigration,
  applyCodexThreadResumeActiveLeaseMigration,
  applyCodexToolBridgeMigration,
  applyCodexToolResponseDeliveryAttemptMigration,
  applyCodexToolRequestRpcBindingMigration,
  applyCodexToolResponseEvidenceMigration,
  applyCodexTurnLifecycleActionMigration,
  applyCodexConversationContextBoundaryMigration,
  CODEX_BINDING_EVIDENCE_GUARDS_SQL,
  CODEX_BINDING_SCHEMA_SQL,
  CODEX_GATEWAY_EXCHANGE_GUARDS_SQL,
  CODEX_NATIVE_CONTINUITY_GUARDS_SQL,
  CODEX_PRISTINE_CONTRACT_REFRESH_GUARDS_SQL,
  CODEX_NATIVE_COVERAGE_SCHEMA_SQL,
  CODEX_PRODUCT_EFFECT_BINDING_SCHEMA_SQL,
} from './agent-control/codex-runtime/codex-binding-schema'
import {
  applyCodexConversationClosedDeleteGuards,
  applyCodexThreadRetirementCleanupMigration,
  dropCodexConversationClosedDeleteGuards,
  enqueueEligibleRetiredCodexThreadArchiveIntents,
  retireAllCodexThreadBindingsForConversationReset,
} from './agent-control/codex-runtime/codex-thread-retirement-cleanup-migration'
import { applyBrowserTargetClaimUserTakeoverMigration } from './browser-engine/browser-target-claim-user-takeover-migration'
import { applyReadyMemoryMigration } from './agent-control/ready-memory/ready-memory-migration'

const BROWSER_CHECKPOINT_WAKE_KIND_SQL = BROWSER_CHECKPOINT_WAKE_KINDS
  .map((kind) => `'${kind}'`)
  .join(', ')

// Minimal interface compatible with DatabaseConnection from database.ts.
// Defined locally to avoid circular imports.
export interface MigrationDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get<T = unknown>(...params: unknown[]): T | undefined
    all<T = unknown>(...params: unknown[]): T[]
  }
  readonly inTransaction?: boolean
}

interface Migration {
  name: string
  up: (db: MigrationDatabase) => void
}

interface LegacyAgentScheduleRow {
  id: string
  name: string
  cron_expr: string
  prompt: string
  enabled: number
  payload_json: string | null
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  updated_at: string
}

function parseLegacySchedulePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function readLegacyText(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function parseCronInteger(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

function parseCronList(value: string, min: number, max: number): number[] | null {
  const values = value.split(',').map((part) => parseCronInteger(part, min, max))
  if (values.some((part) => part === null)) return null
  return [...new Set(values as number[])]
}

/** Convert only cron shapes whose UTC behavior is exactly representable by ScheduleSpecV1. */
function convertLegacyCron(cron: string): ScheduleSpecV1 | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = parts
  const minute = parseCronInteger(minuteRaw, 0, 59)
  const hour = parseCronInteger(hourRaw, 0, 23)
  const localTime = minute !== null && hour !== null
    ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    : null

  const minuteInterval = /^\*\/(\d+)$/.exec(minuteRaw)
  if (minuteInterval && hourRaw === '*' && dayRaw === '*' && monthRaw === '*' && weekdayRaw === '*') {
    const every = Number(minuteInterval[1])
    if (every >= 5 && every <= 60 && 60 % every === 0) {
      return { kind: 'interval', every, unit: 'minute', anchorAt: '1970-01-01T00:00:00Z' }
    }
    return null
  }

  const hourInterval = /^\*\/(\d+)$/.exec(hourRaw)
  if (minute === 0 && hourInterval && dayRaw === '*' && monthRaw === '*' && weekdayRaw === '*') {
    const every = Number(hourInterval[1])
    if (every >= 1 && every <= 24 && 24 % every === 0) {
      return { kind: 'interval', every, unit: 'hour', anchorAt: '1970-01-01T00:00:00Z' }
    }
    return null
  }

  if (!localTime) return null
  if (dayRaw === '*' && monthRaw === '*' && weekdayRaw === '*') {
    return { kind: 'calendar', frequency: 'daily', localTime }
  }
  if (dayRaw === '*' && monthRaw === '*' && weekdayRaw !== '*') {
    const cronWeekdays = parseCronList(weekdayRaw, 0, 7)
    if (!cronWeekdays?.length) return null
    const weekdays = [...new Set(cronWeekdays.map((day) => day === 0 || day === 7 ? 7 : day))]
      .sort((a, b) => a - b)
    return { kind: 'calendar', frequency: 'weekly', localTime, weekdays }
  }
  const dayOfMonth = parseCronInteger(dayRaw, 1, 31)
  if (dayOfMonth !== null && monthRaw === '*' && weekdayRaw === '*') {
    return { kind: 'calendar', frequency: 'monthly', localTime, dayOfMonth }
  }
  if (dayOfMonth !== null && monthRaw !== '*' && weekdayRaw === '*') {
    const months = parseCronList(monthRaw, 1, 12)
    if (!months?.length) return null
    return { kind: 'calendar', frequency: 'yearly', localTime, dayOfMonth, months }
  }
  return null
}

const DEFAULT_AGENT_PERSONA_SEEDS = [
  { agentName: 'butler', displayName: '管家', emoji: '🤖' },
  { agentName: 'copywriter', displayName: '文案', emoji: '✍️' },
  { agentName: 'video-editor', displayName: '剪辑', emoji: '🎬' },
  { agentName: 'analyst', displayName: '分析', emoji: '📊' },
] as const

// 064 迁移期内置 agent 的种子 soul。已冻结：builtin-agent-presets 的 seed 守卫用它判断
// "用户没改过"（现值 == 此值才覆盖为新预设 soul）。不要修改这些字面量。
export const AGENT_IDENTITY_PERSONAS: Record<BuiltinAgentId, string> = {
  butler: DEFAULT_AGENT_PERSONAS.butler,
  copywriter: DEFAULT_AGENT_PERSONAS.copywriter,
  'video-editor': [
    '# 美术 Agent (Visual Art)',
    '',
    '## 角色定位',
    '你是 Ready 工作台里的视觉与美术顾问，负责画面分析、风格判断、构图色彩建议和视觉方案整理。',
    '',
    '## 核心能力',
    '- **画面分析**: 判断构图、色彩、光线、层次、主体关系和视觉重心',
    '- **风格建议**: 把参考图、品牌方向和场景需求转成可执行的视觉语言',
    '- **素材判断**: 对图片、视频帧、视觉参考做筛选、归纳和改进建议',
    '- **美术执行提示**: 输出适合设计、拍摄或 AI 生成的画面描述与注意事项',
    '',
    '## 行为准则',
    '- 优先说清楚画面问题、判断依据和下一步可执行调整',
    '- 不把审美判断说成绝对事实；必要时给出多个方向供用户选择',
    '- 涉及真实图片、品牌资产或用户素材时，尊重原始限制和用户目标',
  ].join('\n'),
  analyst: [
    '# 智识 Agent (Knowledge)',
    '',
    '## 角色定位',
    '你是 Ready 工作台里的学习、研究与知识积累助手，负责把材料读透、归纳结构、抽取洞察并沉淀可复用知识。',
    '',
    '## 核心能力',
    '- **学习整理**: 将书籍、文章、视频、网页和笔记整理成清晰结构',
    '- **研究分析**: 对概念、论点、证据和背景做可追溯的分析判断',
    '- **知识沉淀**: 区分事实、观点、推测和待验证问题，方便后续复用',
    '- **问题拆解**: 把复杂问题拆成可查证、可推进、可复盘的子问题',
    '',
    '## 行为准则',
    '- 先复述任务目标和资料边界，再给出结论',
    '- 重要判断尽量说明依据；不确定时明确标注不确定',
    '- 输出以结构清楚、便于后续继续研究为优先',
  ].join('\n'),
  operator: [
    '# 运营 Agent (Operations)',
    '',
    '## 角色定位',
    '你是 Ready 工作台里的社媒运营教练，负责内容账号的诊断、定位、选题、内容策略、数据复盘与增长变现指导。',
    '',
    '## 核心能力',
    '- **账号诊断**: 基于实证采集与基线对比，定位账号在定位/内容/流量/关系/变现上的问题',
    '- **选题与策略**: 用需求探测与验证型对标，产出可直接执行的选题与内容规划',
    '- **数据复盘**: 用漏斗归因与实验思维解读数据，规避幸存者偏差等统计陷阱',
    '- **增长变现**: 按账号阶段诊断增长瓶颈，给出合规的变现路径建议',
    '',
    '## 行为准则',
    '- 先证据后判断；结论落到可执行颗粒度，不给"多发优质内容"式空话',
    '- 区分事实、推断与行业流言；时效性数字先核查再引用',
    '- 不协助刷量、买粉、伪造数据等违规操作',
  ].join('\n'),
}

interface MigrationAgentRow {
  id: string
  name: string
  charter: string | null
  persona_ref: string | null
  status: string
  parent_agent_id?: string | null
  derivation_reason?: string | null
  merged_into_agent_id?: string | null
  created_at: string
}

interface MigrationPersonalityRow {
  agent_name: string
  display_name: string | null
  personality_text: string
  meta_json: string | null
}

function migrationNowIso(): string {
  return new Date().toISOString()
}

function migrationNowMs(): number {
  return Date.now()
}

function generatedPersonalityText(agentId: string, displayName: string, charter: string | null): string {
  return [
    `# ${displayName}`,
    '',
    '你是 Ready 工作台中的一个完整 Agent。',
    charter ? `职责范围：${charter}` : '请围绕自己的职责范围稳定协助用户完成任务。',
    '请用清晰、稳定、可复盘的方式工作；遇到边界不清时先向用户确认。',
  ].join('\n')
}

function nextAvailableAgentSlug(existingIds: Set<string>, preferred: string, fallbackBase: string): string {
  const normalizedPreferred = normalizeAgentSlug(preferred)
  const normalizedFallback = normalizeAgentSlug(fallbackBase)
  const base = normalizedPreferred && !isReservedAgentSlug(normalizedPreferred)
    ? normalizedPreferred
    : `${normalizedFallback || 'agent'}-custom`
  if (!existingIds.has(base) && !isReservedAgentSlug(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!existingIds.has(candidate) && !isReservedAgentSlug(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

function reassignPersonalityForReservedSlug(
  db: MigrationDatabase,
  oldAgentId: string,
  newAgentId: string,
): boolean {
  const personality = db.prepare(`
    SELECT id
    FROM agent_personalities
    WHERE agent_name = ?
  `).all<{ id: string }>(oldAgentId)[0]
  if (!personality) return false

  const existingIds = new Set(
    db.prepare('SELECT id FROM agent_personalities')
      .all<{ id: string }>()
      .map((row) => row.id),
  )
  const baseId = `personality-${newAgentId}`
  let nextId = baseId
  for (let index = 2; existingIds.has(nextId); index += 1) {
    nextId = `${baseId}-${index}`
  }
  db.prepare(`
    UPDATE agent_personalities
    SET id = ?, agent_name = ?
    WHERE agent_name = ?
  `).run(nextId, newAgentId, oldAgentId)
  return true
}

function nextAvailablePersonalityId(db: MigrationDatabase, baseId: string): string {
  const existingIds = new Set(
    db.prepare('SELECT id FROM agent_personalities')
      .all<{ id: string }>()
      .map((row) => row.id),
  )
  if (!existingIds.has(baseId)) return baseId
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseId}-${index}`
    if (!existingIds.has(candidate)) return candidate
  }
  return `${baseId}-${Date.now()}`
}

const migrations: Migration[] = [
  // ------------------------------------------------------------------ 001
  {
    name: '001_create_rss_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rss_sources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          url TEXT NOT NULL UNIQUE,
          group_name TEXT DEFAULT 'default',
          icon TEXT,
          last_fetched INTEGER,
          fetch_interval INTEGER DEFAULT 30,
          enabled INTEGER DEFAULT 1,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS rss_items (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          guid TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          link TEXT NOT NULL,
          summary TEXT,
          cover_image TEXT,
          author TEXT,
          published_at INTEGER,
          fetched_at INTEGER DEFAULT (unixepoch()),
          read INTEGER DEFAULT 0,
          starred INTEGER DEFAULT 0,
          ai_score INTEGER,
          ai_tags TEXT,
          FOREIGN KEY (source_id) REFERENCES rss_sources(id) ON DELETE CASCADE
        )
      `)
    }
  },

  // ------------------------------------------------------------------ 002
  {
    name: '002_create_calendar_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_sources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#5B8DEF',
          type TEXT DEFAULT 'local',
          sync_url TEXT,
          sync_interval INTEGER DEFAULT 60,
          enabled INTEGER DEFAULT 1,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id TEXT PRIMARY KEY,
          calendar_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          location TEXT,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          all_day INTEGER DEFAULT 0,
          recurrence_rule TEXT,
          reminders TEXT,
          agent_action TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          FOREIGN KEY (calendar_id) REFERENCES calendar_sources(id) ON DELETE CASCADE
        )
      `)
    }
  },

  // ------------------------------------------------------------------ 003
  {
    name: '003_create_agent_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_knowledge (
          id TEXT PRIMARY KEY,
          agent_name TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          UNIQUE(agent_name, key)
        )
      `)
    }
  },

  // ------------------------------------------------------------------ 004
  {
    name: '004_add_indexes',
    up: (db) => {
      // RSS item indexes for common query patterns
      db.exec('CREATE INDEX IF NOT EXISTS idx_articles_feed_id ON rss_items(source_id)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_articles_published_at ON rss_items(published_at)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_articles_read ON rss_items(read)')

      // Calendar event indexes for date-range and calendar filtering
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_start_date ON calendar_events(start_time)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_end_date ON calendar_events(end_time)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_calendar ON calendar_events(calendar_id)')
    }
  },

  // ------------------------------------------------------------------ 005
  {
    name: '005_create_settings_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
    }
  },

  // ------------------------------------------------------------------ 006
  {
    name: '006_create_browser_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_bookmarks (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          title TEXT NOT NULL,
          favicon TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON browser_bookmarks(url)')

      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_history (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          title TEXT NOT NULL,
          visited_at INTEGER DEFAULT (unixepoch())
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_history_visited_at ON browser_history(visited_at DESC)'
      )
      db.exec('CREATE INDEX IF NOT EXISTS idx_history_url ON browser_history(url)')

      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_downloads (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          filename TEXT NOT NULL,
          save_path TEXT NOT NULL,
          total_bytes INTEGER DEFAULT 0,
          received_bytes INTEGER DEFAULT 0,
          state TEXT DEFAULT 'progressing',
          created_at INTEGER DEFAULT (unixepoch())
        )
      `)
    }
  },

  // ------------------------------------------------------------------ 007
  {
    name: '007_create_chat_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_conversations (
          id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          title TEXT DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TEXT NOT NULL
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id)')
    }
  },

  // ------------------------------------------------------------------ 008
  {
    name: '008_add_platform_column',
    up: (db) => {
      // Add platform column to rss_sources if it doesn't exist
      // SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we check first
      const cols = db.prepare('PRAGMA table_info(rss_sources)').all<{ name: string }>()
      const hasColumn = cols.some((c) => c.name === 'platform')
      if (!hasColumn) {
        db.exec("ALTER TABLE rss_sources ADD COLUMN platform TEXT DEFAULT 'rss'")
      }
    }
  },

  // ------------------------------------------------------------------ 009
  {
    name: '009_create_skills_runtime_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skills_jobs (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          action TEXT NOT NULL,
          params_json TEXT,
          status TEXT NOT NULL,
          trigger_type TEXT NOT NULL DEFAULT 'manual',
          schedule_id TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          duration_ms INTEGER,
          stdout TEXT,
          stderr TEXT,
          output_dir TEXT,
          error TEXT,
          command_json TEXT
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_skills_jobs_created_at ON skills_jobs(created_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_skills_jobs_skill ON skills_jobs(skill_id, created_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_skills_jobs_status ON skills_jobs(status, created_at DESC)'
      )

      db.exec(`
        CREATE TABLE IF NOT EXISTS skills_schedules (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          action TEXT NOT NULL,
          params_json TEXT,
          interval_minutes INTEGER NOT NULL,
          next_run_at TEXT NOT NULL,
          last_run_at TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_skills_schedules_next_run ON skills_schedules(enabled, next_run_at)'
      )
    }
  },

  // ------------------------------------------------------------------ 010
  {
    name: '010_create_rss_analysis_jobs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rss_analysis_jobs (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          action TEXT NOT NULL,
          source_url TEXT NOT NULL,
          title TEXT NOT NULL,
          target_dir TEXT NOT NULL,
          output_dir TEXT NOT NULL,
          report_path TEXT,
          status TEXT NOT NULL,
          progress INTEGER NOT NULL DEFAULT 0,
          message TEXT,
          error TEXT,
          meta_json TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          updated_at TEXT NOT NULL,
          finished_at TEXT
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_rss_analysis_item_updated ON rss_analysis_jobs(item_id, updated_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_rss_analysis_status_updated ON rss_analysis_jobs(status, updated_at DESC)'
      )
    }
  },

  // ------------------------------------------------------------------ 011
  {
    name: '011_create_agent_runtime_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_channels (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          config_json TEXT NOT NULL DEFAULT '{}',
          last_error TEXT,
          last_seen_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_agent_channels_type_updated ON agent_channels(type, updated_at DESC)'
      )

      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_schedules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          cron_expr TEXT NOT NULL,
          prompt TEXT NOT NULL,
          channel_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          payload_json TEXT,
          last_run_at TEXT,
          next_run_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (channel_id) REFERENCES agent_channels(id) ON DELETE SET NULL
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_agent_schedules_enabled_next ON agent_schedules(enabled, next_run_at)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_agent_schedules_updated ON agent_schedules(updated_at DESC)'
      )
    }
  },

  // ------------------------------------------------------------------ 012
  {
    name: '012_create_agent_channel_runtime_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_channel_threads (
          channel_id TEXT NOT NULL,
          remote_thread TEXT NOT NULL,
          session_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (channel_id, remote_thread),
          FOREIGN KEY (channel_id) REFERENCES agent_channels(id) ON DELETE CASCADE
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_agent_channel_threads_updated ON agent_channel_threads(updated_at DESC)'
      )

      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_channel_events (
          event_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (channel_id) REFERENCES agent_channels(id) ON DELETE CASCADE
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_agent_channel_events_status_updated ON agent_channel_events(status, updated_at DESC)'
      )
    }
  },

  // ------------------------------------------------------------------ 013
  {
    name: '013_expand_chat_scopes_for_remote_channels',
    up: (db) => {
      const conversationColumns = db
        .prepare('PRAGMA table_info(chat_conversations)')
        .all<{ name: string }>()
      const hasConversationColumn = (name: string) =>
        conversationColumns.some((column) => column.name === name)
      if (!hasConversationColumn('source_kind')) {
        db.exec("ALTER TABLE chat_conversations ADD COLUMN source_kind TEXT DEFAULT 'local'")
      }
      if (!hasConversationColumn('source_id')) {
        db.exec("ALTER TABLE chat_conversations ADD COLUMN source_id TEXT DEFAULT 'app'")
      }
      if (!hasConversationColumn('thread_key')) {
        db.exec("ALTER TABLE chat_conversations ADD COLUMN thread_key TEXT DEFAULT ''")
      }
      if (!hasConversationColumn('meta_json')) {
        db.exec("ALTER TABLE chat_conversations ADD COLUMN meta_json TEXT DEFAULT '{}'")
      }
      db.exec(`
        UPDATE chat_conversations
        SET source_kind = COALESCE(NULLIF(source_kind, ''), 'local'),
            source_id = COALESCE(NULLIF(source_id, ''), 'app'),
            thread_key = COALESCE(NULLIF(thread_key, ''), id),
            meta_json = COALESCE(NULLIF(meta_json, ''), '{}')
      `)
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversations_scope ON chat_conversations(source_kind, source_id, thread_key, agent)'
      )

      const messageColumns = db.prepare('PRAGMA table_info(chat_messages)').all<{ name: string }>()
      const hasMessageColumn = (name: string) =>
        messageColumns.some((column) => column.name === name)
      if (!hasMessageColumn('meta_json')) {
        db.exec("ALTER TABLE chat_messages ADD COLUMN meta_json TEXT DEFAULT '{}'")
      }
      db.exec("UPDATE chat_messages SET meta_json = COALESCE(NULLIF(meta_json, ''), '{}')")

      const threadColumns = db
        .prepare('PRAGMA table_info(agent_channel_threads)')
        .all<{ name: string }>()
      const hasThreadColumn = (name: string) => threadColumns.some((column) => column.name === name)
      if (!hasThreadColumn('conversation_id')) {
        db.exec('ALTER TABLE agent_channel_threads ADD COLUMN conversation_id TEXT')
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_agent_channel_threads_conversation_id ON agent_channel_threads(conversation_id)'
      )
    }
  },

  // ------------------------------------------------------------------ 014
  {
    name: '014_expand_browser_entities_and_adblock_state',
    up: (db) => {
      const bookmarkColumns = db
        .prepare('PRAGMA table_info(browser_bookmarks)')
        .all<{ name: string }>()
      const hasBookmarkColumn = (name: string) =>
        bookmarkColumns.some((column) => column.name === name)
      if (!hasBookmarkColumn('type')) {
        db.exec("ALTER TABLE browser_bookmarks ADD COLUMN type TEXT DEFAULT 'url'")
      }
      if (!hasBookmarkColumn('parent_id')) {
        db.exec('ALTER TABLE browser_bookmarks ADD COLUMN parent_id TEXT')
      }
      if (!hasBookmarkColumn('position')) {
        db.exec('ALTER TABLE browser_bookmarks ADD COLUMN position INTEGER DEFAULT 0')
      }
      if (!hasBookmarkColumn('tags')) {
        db.exec('ALTER TABLE browser_bookmarks ADD COLUMN tags TEXT')
      }
      if (!hasBookmarkColumn('notes')) {
        db.exec('ALTER TABLE browser_bookmarks ADD COLUMN notes TEXT')
      }
      if (!hasBookmarkColumn('source')) {
        db.exec("ALTER TABLE browser_bookmarks ADD COLUMN source TEXT DEFAULT 'manual'")
      }

      const historyColumns = db
        .prepare('PRAGMA table_info(browser_history)')
        .all<{ name: string }>()
      const hasHistoryColumn = (name: string) =>
        historyColumns.some((column) => column.name === name)
      if (!hasHistoryColumn('favicon')) {
        db.exec('ALTER TABLE browser_history ADD COLUMN favicon TEXT')
      }
      if (!hasHistoryColumn('visit_count')) {
        db.exec('ALTER TABLE browser_history ADD COLUMN visit_count INTEGER DEFAULT 1')
      }
      if (!hasHistoryColumn('last_visit_time')) {
        db.exec('ALTER TABLE browser_history ADD COLUMN last_visit_time INTEGER')
      }
      if (!hasHistoryColumn('transition')) {
        db.exec("ALTER TABLE browser_history ADD COLUMN transition TEXT DEFAULT 'typed'")
      }
      if (!hasHistoryColumn('session_id')) {
        db.exec('ALTER TABLE browser_history ADD COLUMN session_id TEXT')
      }
      if (!hasHistoryColumn('domain')) {
        db.exec("ALTER TABLE browser_history ADD COLUMN domain TEXT DEFAULT ''")
      }
      db.exec(`
        UPDATE browser_history
        SET visit_count = COALESCE(visit_count, 1),
            last_visit_time = COALESCE(last_visit_time, visited_at),
            transition = COALESCE(NULLIF(transition, ''), 'typed'),
            domain = COALESCE(domain, '')
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_history_domain ON browser_history(domain)')
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_history_last_visit_time ON browser_history(last_visit_time DESC)'
      )

      const downloadColumns = db
        .prepare('PRAGMA table_info(browser_downloads)')
        .all<{ name: string }>()
      const hasDownloadColumn = (name: string) =>
        downloadColumns.some((column) => column.name === name)
      if (!hasDownloadColumn('mime_type')) {
        db.exec('ALTER TABLE browser_downloads ADD COLUMN mime_type TEXT')
      }
      if (!hasDownloadColumn('error')) {
        db.exec('ALTER TABLE browser_downloads ADD COLUMN error TEXT')
      }
      if (!hasDownloadColumn('end_time')) {
        db.exec('ALTER TABLE browser_downloads ADD COLUMN end_time INTEGER')
      }
      if (!hasDownloadColumn('can_resume')) {
        db.exec('ALTER TABLE browser_downloads ADD COLUMN can_resume INTEGER DEFAULT 0')
      }
      if (!hasDownloadColumn('updated_at')) {
        db.exec('ALTER TABLE browser_downloads ADD COLUMN updated_at INTEGER DEFAULT (unixepoch())')
      }
      db.exec(`
        UPDATE browser_downloads
        SET can_resume = COALESCE(can_resume, 0),
            updated_at = COALESCE(updated_at, created_at)
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_downloads_end_time ON browser_downloads(end_time DESC)'
      )

      db.exec(`
        INSERT INTO settings (key, value, updated_at)
        VALUES
          ('browser_adblock_enabled', 'true', CURRENT_TIMESTAMP),
          ('browser_adblock_preview_enabled', 'true', CURRENT_TIMESTAMP),
          ('browser_adblock_whitelist_domains', '[]', CURRENT_TIMESTAMP),
          ('browser_adblock_rules_version', 'ready-basic-ads-v1', CURRENT_TIMESTAMP),
          ('browser_adblock_last_updated_at', strftime('%s','now'), CURRENT_TIMESTAMP),
          ('browser_adblock_network_blocked_count', '0', CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO NOTHING
      `)
    }
  },

  // ------------------------------------------------------------------ 015
  {
    name: '015_create_memory_system_tables',
    up: (db) => {
      // Memory metadata and lifecycle tracking
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_memory_metadata (
          id TEXT PRIMARY KEY,
          layer TEXT NOT NULL CHECK(layer IN ('l0', 'l1', 'l2')),
          scope_id TEXT,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT,
          content_key TEXT NOT NULL,
          priority INTEGER DEFAULT 0,
          access_count INTEGER DEFAULT 0,
          last_accessed_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          expires_at INTEGER,
          archived_at INTEGER,
          tags TEXT,
          meta_json TEXT DEFAULT '{}'
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memory_layer_scope ON agent_memory_metadata(layer, scope_id, archived_at)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memory_category_priority ON agent_memory_metadata(category, priority DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memory_expires ON agent_memory_metadata(expires_at) WHERE expires_at IS NOT NULL'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memory_access ON agent_memory_metadata(last_accessed_at DESC)'
      )

      // Dynamic trigger definitions
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_triggers (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          module TEXT,
          pattern TEXT NOT NULL,
          pattern_flags TEXT DEFAULT 'i',
          blocking INTEGER DEFAULT 0,
          priority INTEGER DEFAULT 0,
          enabled INTEGER DEFAULT 1,
          hit_count INTEGER DEFAULT 0,
          last_hit_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          meta_json TEXT DEFAULT '{}'
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_triggers_enabled_priority ON agent_triggers(enabled, priority DESC)'
      )
      db.exec('CREATE INDEX IF NOT EXISTS idx_triggers_module ON agent_triggers(module)')

      // Trigger-to-memory associations
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_trigger_refs (
          trigger_id TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          priority INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (trigger_id, memory_id),
          FOREIGN KEY (trigger_id) REFERENCES agent_triggers(id) ON DELETE CASCADE,
          FOREIGN KEY (memory_id) REFERENCES agent_memory_metadata(id) ON DELETE CASCADE
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_trigger_refs_priority ON agent_trigger_refs(trigger_id, priority DESC)'
      )

      // Memory access log for analytics
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_memory_access_log (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL,
          scope_id TEXT,
          accessed_at INTEGER DEFAULT (unixepoch()),
          context_chars INTEGER,
          was_useful INTEGER,
          FOREIGN KEY (memory_id) REFERENCES agent_memory_metadata(id) ON DELETE CASCADE
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memory_access_log_time ON agent_memory_access_log(accessed_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memory_access_log_memory ON agent_memory_access_log(memory_id, accessed_at DESC)'
      )

      // Seed with existing hardcoded triggers
      db.exec(`
        INSERT INTO agent_triggers (id, label, module, pattern, blocking, priority) VALUES
          ('feishu-doc', '飞书文档操作', 'feishu', '(飞书).*(文档|doc)|创建飞书文档|改写飞书文档|写入飞书', 1, 0),
          ('feishu-image', '飞书插图操作', 'feishu', '(飞书).*(图片|插图|上传)', 1, 0),
          ('browser-upload', '浏览器上传流程', 'browser', '(上传|发送|提交|浏览器|网页)', 0, 0),
          ('document-write', '文档改写操作', 'document', '(文档|文件).*(写|改|保存|格式)', 0, 0),
          ('video-render', '视频渲染操作', 'video', '(视频|剪辑|渲染|导出)', 0, 0),
          ('rss-analysis', 'RSS 分析操作', 'rss', '(?:\\b(?:rss|feed|rsshub)\\b|订阅源|订阅|源站|信息源|推送|skill_rss_|lets-go-rss).*(?:抓取|拉取|分析|汇总|输出.*报告|生成.*报告|添加|更新|查看|列出|状态|统计)|(?:抓取|拉取|分析|汇总|输出.*报告|生成.*报告|添加|更新|查看|列出|状态|统计).*(?:\\b(?:rss|feed|rsshub)\\b|订阅源|订阅|源站|信息源|推送|skill_rss_|lets-go-rss)|(?:skill_rss_|lets-go-rss)', 0, 0),
          ('calendar-write', '日程写入操作', 'calendar', '(日程|日历|会议|提醒).*(创建|修改|删除|改期)|创建日程|修改日程', 1, 0)
        ON CONFLICT(id) DO NOTHING
      `)
    }
  },

  // ------------------------------------------------------------------ 016
  {
    name: '016_create_user_identity_tables',
    up: (db) => {
      // User profiles table for per-user customization
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_profiles (
          id TEXT PRIMARY KEY,
          name TEXT,
          avatar_url TEXT,
          preferred_language TEXT DEFAULT 'zh',
          communication_style TEXT,
          preferences_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)

      // Agent personalities table for SOUL.md management
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_personalities (
          id TEXT PRIMARY KEY,
          agent_name TEXT NOT NULL UNIQUE,
          display_name TEXT,
          personality_text TEXT NOT NULL,
          tone TEXT,
          meta_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)

      // Extend agent_memory_metadata with user_id for per-user memories
      const memoryColumns = db
        .prepare('PRAGMA table_info(agent_memory_metadata)')
        .all<{ name: string }>()
      const hasMemoryUserColumn = memoryColumns.some((column) => column.name === 'user_id')
      if (!hasMemoryUserColumn) {
        db.exec(`ALTER TABLE agent_memory_metadata ADD COLUMN user_id TEXT`)
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_memory_user ON agent_memory_metadata(user_id, category)`
        )
      }

      // Extend chat_conversations with user_id for per-user conversations
      const conversationColumns = db
        .prepare('PRAGMA table_info(chat_conversations)')
        .all<{ name: string }>()
      const hasConversationUserColumn = conversationColumns.some(
        (column) => column.name === 'user_id'
      )
      if (!hasConversationUserColumn) {
        db.exec(`ALTER TABLE chat_conversations ADD COLUMN user_id TEXT`)
        db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON chat_conversations(user_id)`)
      }

      // Create default user profile
      const now = Date.now()
      db.prepare(
        `
        INSERT INTO user_profiles (id, name, preferred_language, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `
      ).run('default-user', 'Default User', 'zh', now, now)
    }
  },
  {
    name: '017_remove_design_video_data',
    up: (db) => {
      // Delete video-render trigger
      db.exec(`DELETE FROM agent_triggers WHERE id = 'video-render'`)

      // Clean up design/video related memories
      db.exec(`
        DELETE FROM agent_memory_metadata
        WHERE category IN ('design', 'video')
           OR title LIKE '%设计%'
           OR title LIKE '%剪辑%'
           OR title LIKE '%视频%'
      `)

      // Clean up design/video related agent knowledge
      db.exec(`
        DELETE FROM agent_knowledge
        WHERE key LIKE '%design%'
           OR key LIKE '%video%'
      `)
    }
  },
  {
    name: '018_create_skill_execution_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_executions (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          entry_action TEXT NOT NULL,
          session_id TEXT,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          current_step_id TEXT,
          compiled_skill_json TEXT NOT NULL,
          current_blocker_json TEXT,
          last_frame_json TEXT,
          errors_json TEXT,
          step_outputs_json TEXT,
          confirmations_json TEXT,
          inputs_json TEXT
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_skill_executions_updated_at ON skill_executions(updated_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_skill_executions_session_status ON skill_executions(session_id, status, updated_at DESC)'
      )

      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_execution_steps (
          id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          result_json TEXT,
          message TEXT,
          FOREIGN KEY (execution_id) REFERENCES skill_executions(id) ON DELETE CASCADE
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_skill_execution_steps_execution_step ON skill_execution_steps(execution_id, step_id, attempt)'
      )

      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_execution_artifacts (
          id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          label TEXT,
          kind TEXT,
          path TEXT,
          mime_type TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (execution_id) REFERENCES skill_executions(id) ON DELETE CASCADE
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_skill_execution_artifacts_execution_step ON skill_execution_artifacts(execution_id, step_id, created_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_skill_execution_artifacts_artifact_id ON skill_execution_artifacts(artifact_id)'
      )
    }
  },

  // ------------------------------------------------------------------ 019
  {
    name: '019_add_rss_draft_store_fields',
    up: (db) => {
      const rssItemColumns = db.prepare('PRAGMA table_info(rss_items)').all<{ name: string }>()
      const hasInboxVisible = rssItemColumns.some((column) => column.name === 'inbox_visible')
      if (!hasInboxVisible) {
        db.exec('ALTER TABLE rss_items ADD COLUMN inbox_visible INTEGER DEFAULT 1')
      }

      const rssSourceColumns = db.prepare('PRAGMA table_info(rss_sources)').all<{ name: string }>()
      const hasDraftSeeded = rssSourceColumns.some((column) => column.name === 'draft_seeded')
      if (!hasDraftSeeded) {
        db.exec('ALTER TABLE rss_sources ADD COLUMN draft_seeded INTEGER DEFAULT 0')
      }

      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_rss_items_inbox_visible ON rss_items(inbox_visible, starred, published_at DESC)'
      )
      db.exec('UPDATE rss_items SET inbox_visible = 1 WHERE inbox_visible IS NULL')
      db.exec('UPDATE rss_sources SET draft_seeded = 0 WHERE draft_seeded IS NULL')
    }
  },

  // ------------------------------------------------------------------ 020
  {
    name: '020_create_browser_task_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_tasks (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          checkpoint_json TEXT,
          result_json TEXT,
          progress_total INTEGER DEFAULT 0,
          progress_completed INTEGER DEFAULT 0,
          progress_failed INTEGER DEFAULT 0,
          current_label TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          updated_at TEXT NOT NULL,
          finished_at TEXT
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_browser_tasks_status_updated ON browser_tasks(status, updated_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_browser_tasks_kind_created ON browser_tasks(kind, created_at DESC)'
      )
    }
  },

  // ------------------------------------------------------------------ 021
  {
    name: '021_create_session_recall_tables',
    up: (db) => {
      const conversationColumns = db
        .prepare('PRAGMA table_info(chat_conversations)')
        .all<{ name: string }>()
      const hasParentConversationId = conversationColumns.some(
        (column) => column.name === 'parent_conversation_id'
      )
      const hasLineageRootId = conversationColumns.some(
        (column) => column.name === 'lineage_root_id'
      )
      const hasResumeTitle = conversationColumns.some((column) => column.name === 'resume_title')

      if (!hasParentConversationId) {
        db.exec(`ALTER TABLE chat_conversations ADD COLUMN parent_conversation_id TEXT`)
      }
      if (!hasLineageRootId) {
        db.exec(`ALTER TABLE chat_conversations ADD COLUMN lineage_root_id TEXT`)
      }
      if (!hasResumeTitle) {
        db.exec(`ALTER TABLE chat_conversations ADD COLUMN resume_title TEXT`)
      }

      db.exec(`UPDATE chat_conversations SET lineage_root_id = COALESCE(lineage_root_id, id)`)
      db.exec(`UPDATE chat_conversations SET resume_title = COALESCE(resume_title, title)`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_chat_conversations_lineage_root ON chat_conversations(lineage_root_id, updated_at DESC)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_chat_conversations_resume_title ON chat_conversations(resume_title, updated_at DESC)`
      )

      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
          message_id UNINDEXED,
          conversation_id UNINDEXED,
          content
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS session_recall_metadata (
          conversation_id TEXT PRIMARY KEY,
          lineage_root_id TEXT NOT NULL,
          resume_title TEXT NOT NULL,
          title TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          thread_key TEXT NOT NULL,
          user_id TEXT,
          channel_key TEXT NOT NULL,
          preview_text TEXT,
          latest_task_title TEXT,
          latest_task_summary TEXT,
          attachment_names_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_session_recall_updated ON session_recall_metadata(updated_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_session_recall_channel ON session_recall_metadata(channel_key, updated_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_session_recall_resume_title ON session_recall_metadata(resume_title, updated_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_session_recall_lineage_root ON session_recall_metadata(lineage_root_id, updated_at DESC)'
      )

      db.exec(`
        CREATE TABLE IF NOT EXISTS session_recall_attachment_index (
          attachment_key TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          attachment_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT,
          ext TEXT,
          path TEXT,
          created_at TEXT NOT NULL
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_session_recall_attachment_conversation ON session_recall_attachment_index(conversation_id, created_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_session_recall_attachment_name ON session_recall_attachment_index(name)'
      )

      db.exec(`
        CREATE TABLE IF NOT EXISTS session_recall_vectors (
          conversation_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          vector_version TEXT NOT NULL,
          vector_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_session_recall_vectors_updated ON session_recall_vectors(updated_at DESC)'
      )

      const existingFtsRows =
        db.prepare('SELECT COUNT(1) as count FROM chat_messages_fts').all<{ count: number }>()?.[0]
          ?.count || 0
      if (existingFtsRows === 0) {
        const messages = db
          .prepare(
            `
          SELECT id, conversation_id, content
          FROM chat_messages
          ORDER BY timestamp ASC
        `
          )
          .all<{ id: string; conversation_id: string; content: string }>()
        const insertFts = db.prepare(
          'INSERT INTO chat_messages_fts (message_id, conversation_id, content) VALUES (?, ?, ?)'
        )
        for (const message of messages) {
          insertFts.run(message.id, message.conversation_id, message.content || '')
        }
      }

      db.exec('DELETE FROM session_recall_attachment_index')
      db.exec('DELETE FROM session_recall_metadata')

      const conversations = db
        .prepare(
          `
        SELECT id, title, parent_conversation_id, lineage_root_id, resume_title, source_kind, source_id, thread_key, user_id, updated_at
        FROM chat_conversations
      `
        )
        .all<{
          id: string
          title: string
          parent_conversation_id: string | null
          lineage_root_id: string | null
          resume_title: string | null
          source_kind: string
          source_id: string
          thread_key: string
          user_id: string | null
          updated_at: string
        }>()
      const messages = db
        .prepare(
          `
        SELECT id, conversation_id, content, timestamp, meta_json
        FROM chat_messages
        ORDER BY timestamp ASC
      `
        )
        .all<{
          id: string
          conversation_id: string
          content: string
          timestamp: string
          meta_json: string | null
        }>()

      const messagesByConversation = new Map<
        string,
        Array<{
          id: string
          content: string
          timestamp: string
          meta_json: string | null
        }>
      >()
      for (const message of messages) {
        const list = messagesByConversation.get(message.conversation_id) || []
        list.push(message)
        messagesByConversation.set(message.conversation_id, list)
      }

      const insertAttachment = db.prepare(`
        INSERT OR REPLACE INTO session_recall_attachment_index (
          attachment_key, conversation_id, attachment_id, source_message_id, name, type, ext, path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertMetadata = db.prepare(`
        INSERT INTO session_recall_metadata (
          conversation_id, lineage_root_id, resume_title, title, source_kind, source_id, thread_key,
          user_id, channel_key, preview_text, latest_task_title, latest_task_summary, attachment_names_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      for (const conversation of conversations) {
        const conversationMessages = messagesByConversation.get(conversation.id) || []
        let previewText: string | null = null
        const attachmentNames: string[] = []
        const seenAttachmentKeys = new Set<string>()

        for (const message of conversationMessages) {
          if (!previewText && String(message.content || '').trim()) {
            previewText = String(message.content || '')
              .trim()
              .slice(0, 280)
          }
          let meta: Record<string, unknown> = {}
          try {
            meta = message.meta_json
              ? (JSON.parse(message.meta_json) as Record<string, unknown>)
              : {}
          } catch {
            meta = {}
          }
          const rawAttachments = meta.attachments
          if (!Array.isArray(rawAttachments)) continue
          for (let index = 0; index < rawAttachments.length; index += 1) {
            const item = rawAttachments[index]
            if (!item || typeof item !== 'object') continue
            const record = item as Record<string, unknown>
            const attachmentId = String(record.id || `${message.id}-${index}`).trim()
            const path = String(record.path || '').trim()
            const name = String(record.name || '').trim()
            if (!attachmentId || !name) continue
            const attachmentKey = `${conversation.id}::${attachmentId}::${path || name}`
            if (seenAttachmentKeys.has(attachmentKey)) continue
            seenAttachmentKeys.add(attachmentKey)
            attachmentNames.push(name)
            insertAttachment.run(
              attachmentKey,
              conversation.id,
              attachmentId,
              message.id,
              name,
              String(record.type || '').trim() || null,
              String(record.ext || '').trim() || null,
              path || null,
              message.timestamp
            )
          }
        }

        const channelKey = `${conversation.source_kind}:${conversation.source_kind === 'local' ? 'app' : conversation.source_id}`
        insertMetadata.run(
          conversation.id,
          conversation.lineage_root_id || conversation.id,
          conversation.resume_title || conversation.title,
          conversation.title,
          conversation.source_kind,
          conversation.source_id,
          conversation.thread_key,
          conversation.user_id || null,
          channelKey,
          previewText,
          null,
          null,
          JSON.stringify(Array.from(new Set(attachmentNames)).slice(0, 12)),
          conversation.updated_at
        )
      }
    }
  },
  {
    name: '022_add_memory_source_types',
    up: (db) => {
      const memoryColumns = db
        .prepare('PRAGMA table_info(agent_memory_metadata)')
        .all<{ name: string }>()
      const hasSourceTypeColumn = memoryColumns.some((column) => column.name === 'source_type')
      if (!hasSourceTypeColumn) {
        db.exec(
          `ALTER TABLE agent_memory_metadata ADD COLUMN source_type TEXT DEFAULT 'scope_memory'`
        )
      }

      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memory_source_type ON agent_memory_metadata(source_type, archived_at)'
      )

      db.exec(`
        UPDATE agent_memory_metadata
        SET source_type = CASE
          WHEN category = 'user_preference' THEN 'resident_user'
          WHEN category IN ('trigger', 'rule') THEN 'trigger_rule'
          WHEN id IN (SELECT memory_id FROM agent_trigger_refs) THEN 'trigger_rule'
          WHEN category = 'summary' OR scope_id IS NOT NULL THEN 'scope_memory'
          ELSE 'resident_agent'
        END
        WHERE source_type IS NULL
           OR TRIM(source_type) = ''
           OR source_type NOT IN ('resident_agent', 'resident_user', 'scope_memory', 'trigger_rule')
      `)
    }
  },
  {
    name: '023_create_task_projection_store',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_projections (
          task_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          parent_task_id TEXT,
          parent_step_id TEXT,
          task_type TEXT NOT NULL,
          module TEXT NOT NULL,
          task_title TEXT,
          task_summary TEXT,
          status TEXT NOT NULL,
          interaction_state TEXT NOT NULL,
          waiting_for TEXT,
          steps_json TEXT NOT NULL,
          current_step_id TEXT,
          budget_json TEXT,
          budget_usage_percent INTEGER,
          recovery_history_json TEXT,
          blocked_reason TEXT,
          resumable_actions_json TEXT,
          continuation_ref_json TEXT,
          progress_json TEXT,
          recent_artifacts_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_task_projections_scope_updated ON task_projections(scope_id, updated_at DESC)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_task_projections_status_updated ON task_projections(status, updated_at DESC)'
      )
    }
  },
  {
    name: '024_extend_task_projection_store_for_budget_warning',
    up: (db) => {
      try {
        db.exec('ALTER TABLE task_projections ADD COLUMN budget_warning_level TEXT')
      } catch {
        // column already exists
      }
      try {
        db.exec('ALTER TABLE task_projections ADD COLUMN degradation_reason TEXT')
      } catch {
        // column already exists
      }
    }
  },
  {
    name: '025_extend_task_projection_store_for_parent_link_and_runtime_truth',
    up: (db) => {
      const alterStatements = [
        'ALTER TABLE task_projections ADD COLUMN parent_task_id TEXT',
        'ALTER TABLE task_projections ADD COLUMN parent_step_id TEXT',
        'ALTER TABLE task_projections ADD COLUMN task_title TEXT',
        'ALTER TABLE task_projections ADD COLUMN task_summary TEXT',
        'ALTER TABLE task_projections ADD COLUMN recent_artifacts_json TEXT',
      ]
      for (const statement of alterStatements) {
        try {
          db.exec(statement)
        } catch {
          // column already exists
        }
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_task_projections_parent_updated ON task_projections(parent_task_id, updated_at DESC)'
      )
    }
  },
  // ------------------------------------------------------------------ 026
  // Global search index: workspaces, documents, documents_fts (FTS5),
  // tags, doc_links, doc_attachments. Foundation for the SQLite-backed
  // GlobalSearchPanel upgrade + future Obsidian-style graph view.
  {
    name: '026_create_search_index_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id INTEGER PRIMARY KEY,
          root TEXT NOT NULL UNIQUE,
          last_indexed_at INTEGER
        )
      `)

      db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY,
          workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          ext TEXT,
          size INTEGER,
          mtime INTEGER,
          content_hash TEXT,
          frontmatter_json TEXT,
          indexed_at INTEGER,
          UNIQUE(workspace_id, path)
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id)')

      // FTS5 virtual table is optional — some better-sqlite3 builds omit it.
      // Use a regular (non-external-content) FTS5 table so snippet()/bm25() can
      // read text directly from the index; indexer manages rows explicitly.
      // A single DELETE trigger keeps the index in sync when documents rows are
      // pruned (CASCADE from workspaces or explicit delete of a missing file).
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
            name, body,
            tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
          )
        `)
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
            DELETE FROM documents_fts WHERE rowid = old.id;
          END
        `)
      } catch (error) {
        console.warn('[migrations] 026: FTS5 unavailable, skipping documents_fts', error)
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS tags (
          doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          tag TEXT NOT NULL COLLATE NOCASE,
          PRIMARY KEY(doc_id, tag)
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)')

      db.exec(`
        CREATE TABLE IF NOT EXISTS doc_links (
          src_doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('wikilink','mdlink')),
          target_text TEXT NOT NULL,
          target_doc_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
          resolved INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(src_doc_id, kind, target_text)
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_doc_links_target ON doc_links(target_text)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_doc_links_target_doc ON doc_links(target_doc_id)')

      db.exec(`
        CREATE TABLE IF NOT EXISTS doc_attachments (
          doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          ref TEXT NOT NULL,
          PRIMARY KEY(doc_id, kind, ref)
        )
      `)
    }
  },
  // ------------------------------------------------------------------ 027
  // Multi-source indexing: widen `documents` to carry bookmarks / RSS items /
  // calendar events / agent messages alongside filesystem files. source_type
  // defaults to 'document' so existing rows are untouched. A `@shared` workspace
  // hosts non-filesystem sources (they have no per-workspace root).
  {
    name: '027_documents_multi_source',
    up: (db) => {
      const cols = db
        .prepare('PRAGMA table_info(documents)')
        .all<{ name: string }>()
        .map((c) => c.name)
      if (!cols.includes('source_type')) {
        db.exec("ALTER TABLE documents ADD COLUMN source_type TEXT NOT NULL DEFAULT 'document'")
      }
      if (!cols.includes('source_meta_json')) {
        db.exec('ALTER TABLE documents ADD COLUMN source_meta_json TEXT')
      }
      if (!cols.includes('source_id')) {
        db.exec('ALTER TABLE documents ADD COLUMN source_id TEXT')
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_type, source_id)'
      )
      db.prepare(
        'INSERT INTO workspaces (root) VALUES (?) ON CONFLICT(root) DO NOTHING'
      ).run('@shared')
    }
  },

  // ------------------------------------------------------------------ 028
  // Phase 4 — TTL sweep index. The `purgeExpiredExecutions` method filters by
  // `status IN ('completed','failed','cancelled') AND finished_at < ?`; this
  // composite index keeps the scan linear in the size of the expired set
  // instead of linear in total rows.
  {
    name: '028_add_skill_executions_ttl_index',
    up: (db) => {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_skill_executions_status_finished_at ON skill_executions(status, finished_at DESC)'
      )
    }
  },

  // Phase 4 — retire the skill_executions state machine. The 3 tables +
  // their indexes are dropped together. Order matters: child tables first,
  // then parent, because PRAGMA foreign_keys is NOT enabled on this DB
  // (see CLAUDE.md §6.11) so CASCADE does not fire. All DROPs are IF EXISTS
  // so the migration is idempotent on fresh DBs that never built the tables.
  //
  // Release note: legacy rows (historical workflow state) are permanently
  // lost on migration. Phase 3 finished migrating every embedded skill to
  // reference/direct modes, so the surviving rows have no runtime meaning.
  {
    name: '029_drop_skill_execution_tables',
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_skill_execution_artifacts_artifact_id;
        DROP INDEX IF EXISTS idx_skill_execution_artifacts_execution_step;
        DROP INDEX IF EXISTS idx_skill_execution_steps_execution_step;
        DROP INDEX IF EXISTS idx_skill_executions_status_finished_at;
        DROP INDEX IF EXISTS idx_skill_executions_session_status;
        DROP INDEX IF EXISTS idx_skill_executions_updated_at;
        DROP TABLE IF EXISTS skill_execution_artifacts;
        DROP TABLE IF EXISTS skill_execution_steps;
        DROP TABLE IF EXISTS skill_executions;
      `)
    }
  },

  // ------------------------------------------------------------------ 030
  // The original RSS trigger matched the generic action word "分析", which
  // mislabeled explicit non-RSS skill requests (for example Video Expert
  // analysis) as RSS tasks. Keep RSS routing object-bound on upgrade.
  {
    name: '030_tighten_rss_analysis_trigger',
    up: (db) => {
      db.prepare(`
        UPDATE agent_triggers
        SET pattern = ?,
            pattern_flags = 'i',
            updated_at = unixepoch()
        WHERE id = 'rss-analysis'
          AND pattern = '(rss|订阅|抓取|分析)'
      `).run(
        '(?:\\b(?:rss|feed|rsshub)\\b|订阅源|订阅|源站|信息源|推送|skill_rss_|lets-go-rss).*(?:抓取|拉取|分析|汇总|输出.*报告|生成.*报告|添加|更新|查看|列出|状态|统计)|(?:抓取|拉取|分析|汇总|输出.*报告|生成.*报告|添加|更新|查看|列出|状态|统计).*(?:\\b(?:rss|feed|rsshub)\\b|订阅源|订阅|源站|信息源|推送|skill_rss_|lets-go-rss)|(?:skill_rss_|lets-go-rss)'
      )
    }
  },

  // ------------------------------------------------------------------ 031
  // Lightweight skill task archive. This intentionally does not restore the
  // retired skill_executions state machine; it only stores enough durable task
  // memory for resume/retry/restart and UI projection recovery.
  {
    name: '031_create_skill_task_runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_task_runs (
          id TEXT PRIMARY KEY,
          scope_id TEXT,
          session_id TEXT,
          agent TEXT,
          run_id TEXT,
          skill_id TEXT NOT NULL,
          skill_name TEXT,
          action TEXT NOT NULL,
          tool_name TEXT,
          run_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          interaction_state TEXT NOT NULL,
          goal_text TEXT,
          resource_refs_json TEXT,
          params_json TEXT,
          steps_json TEXT NOT NULL DEFAULT '[]',
          current_step_id TEXT,
          artifacts_json TEXT NOT NULL DEFAULT '[]',
          output_dir TEXT,
          run_state_path TEXT,
          scene_scores_path TEXT,
          delivery_report_path TEXT,
          failure_kind TEXT,
          failure_detail TEXT,
          job_id TEXT,
          detached_task_id TEXT,
          resume_payload_json TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          updated_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_skill_task_runs_scope_updated
          ON skill_task_runs(scope_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_skill_task_runs_session_status_updated
          ON skill_task_runs(session_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_skill_task_runs_skill_updated
          ON skill_task_runs(skill_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_skill_task_runs_job_id
          ON skill_task_runs(job_id);
        CREATE INDEX IF NOT EXISTS idx_skill_task_runs_detached_task_id
          ON skill_task_runs(detached_task_id);
      `)
    }
  },
  {
    name: '032_extend_task_projection_store_for_waiting_for',
    up: (db) => {
      try {
        db.exec('ALTER TABLE task_projections ADD COLUMN waiting_for TEXT')
      } catch {
        // column already exists
      }
    }
  },
  // ------------------------------------------------------------------ 033
  // Stage Q (Stage 11) — schema CHECK invariant for skill_task_runs.
  //
  // PR-3 (Q.3a) shipped the runtime invariant: primitive events do not
  // reuse typed_action/lifecycle rows and vice versa. PR-5 (Q.3b) lands
  // the matching schema constraint:
  //   `CHECK (NOT (run_kind = 'primitive' AND tool_name = 'skill_lifecycle'))`
  //
  // This is the first migration to use the CREATE-INSERT-DROP-RENAME
  // pattern (existing migrations all use ALTER TABLE). Each migration
  // is already wrapped in a transaction by `runMigrations()`, so atomicity
  // across the 4 statements is guaranteed.
  //
  // Backfill rules for violator rows (run_kind='primitive' AND
  // tool_name='skill_lifecycle' — the bug shape Stage Q audit identified):
  //   - tool_name → CASE: `action` if it looks like a primitive name
  //     (`skill_*` prefix and not 'skill_lifecycle'); else
  //     'skill_unknown_primitive_cleanup'
  //   - status → 'cancelled' (so listActiveBySession / findLatestRecoverable
  //     don't surface them)
  //   - failure_kind → 'stage_q_invariant_cleanup' (audit trail)
  //
  // Companion task_projections cleanup (same migration):
  //   - Only one branch: status='blocked' AND no durable handle in
  //     continuationRef → resumable_actions=['none'],
  //     degradation_reason='stage_q_invariant_cleanup'.
  //
  //   The earlier draft also had a "legacy 2-colon key" branch that
  //   marked rows with `stage_q_runkind_key_legacy`. Codex review round 1
  //   ❌#6 dropped it: production writer `buildLongSkillRunningProjection`
  //   (`skill-running-projection.ts:322`) still emits 2-colon keys for
  //   legitimate live tasks, so blanket-marking them would misfire.
  //   Stale projections (regardless of key form) are caught by the
  //   no-handle branch above.
  {
    name: '033_skill_task_runs_invariant_check',
    up: (db) => {
      // 1. Create new table with CHECK.
      db.exec(`
        CREATE TABLE skill_task_runs_q (
          id TEXT PRIMARY KEY,
          scope_id TEXT,
          session_id TEXT,
          agent TEXT,
          run_id TEXT,
          skill_id TEXT NOT NULL,
          skill_name TEXT,
          action TEXT NOT NULL,
          tool_name TEXT,
          run_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          interaction_state TEXT NOT NULL,
          goal_text TEXT,
          resource_refs_json TEXT,
          params_json TEXT,
          steps_json TEXT NOT NULL DEFAULT '[]',
          current_step_id TEXT,
          artifacts_json TEXT NOT NULL DEFAULT '[]',
          output_dir TEXT,
          run_state_path TEXT,
          scene_scores_path TEXT,
          delivery_report_path TEXT,
          failure_kind TEXT,
          failure_detail TEXT,
          job_id TEXT,
          detached_task_id TEXT,
          resume_payload_json TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          updated_at TEXT NOT NULL,
          finished_at TEXT,
          CHECK (NOT (run_kind = 'primitive' AND tool_name = 'skill_lifecycle'))
        )
      `)
      // 2. Copy rows with violator backfill.
      db.exec(`
        INSERT INTO skill_task_runs_q
        SELECT
          id, scope_id, session_id, agent, run_id, skill_id, skill_name, action,
          CASE
            WHEN run_kind = 'primitive' AND tool_name = 'skill_lifecycle' THEN
              CASE
                WHEN action IS NULL OR trim(action) = '' THEN 'skill_unknown_primitive_cleanup'
                WHEN action = 'skill_lifecycle' THEN 'skill_unknown_primitive_cleanup'
                WHEN action NOT LIKE 'skill\\_%' ESCAPE '\\' THEN 'skill_unknown_primitive_cleanup'
                ELSE action
              END
            ELSE tool_name
          END AS tool_name,
          run_kind,
          CASE
            WHEN run_kind = 'primitive' AND tool_name = 'skill_lifecycle' THEN 'cancelled'
            ELSE status
          END AS status,
          interaction_state, goal_text, resource_refs_json, params_json, steps_json,
          current_step_id, artifacts_json, output_dir, run_state_path, scene_scores_path,
          delivery_report_path,
          CASE
            WHEN run_kind = 'primitive' AND tool_name = 'skill_lifecycle' THEN 'stage_q_invariant_cleanup'
            ELSE failure_kind
          END AS failure_kind,
          failure_detail, job_id, detached_task_id, resume_payload_json,
          created_at, started_at, updated_at, finished_at
        FROM skill_task_runs
      `)
      // 3. Clean stale task_projections — companion to schema fix.
      //    Stale projection cleanup: status='blocked' AND no durable
      //    handle. The "legacy 2-colon key" branch from earlier drafts
      //    was DROPPED (Codex review round 1 ❌#6): the production writer
      //    `buildLongSkillRunningProjection` (`skill-running-projection.ts:322`)
      //    still emits 2-colon keys for legitimate live tasks, so blanket-
      //    marking 2-colon-keyed rows as "legacy" would falsely retire
      //    live tasks. The single-pass below catches genuinely stale
      //    projections (no handle) regardless of key form.
      db.exec(`
        UPDATE task_projections
        SET
          resumable_actions_json = '["none"]',
          degradation_reason = 'stage_q_invariant_cleanup',
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE
          status = 'blocked'
          AND (
            continuation_ref_json IS NULL
            OR (
              json_extract(continuation_ref_json, '$.outputDir') IS NULL
              AND json_extract(continuation_ref_json, '$.runStatePath') IS NULL
              AND json_extract(continuation_ref_json, '$.childRunId') IS NULL
              AND json_extract(continuation_ref_json, '$.detachedTaskId') IS NULL
            )
          )
          AND (degradation_reason IS NULL OR degradation_reason != 'stage_q_invariant_cleanup')
      `)
      // 4. Swap tables.
      db.exec('DROP TABLE skill_task_runs')
      db.exec('ALTER TABLE skill_task_runs_q RENAME TO skill_task_runs')
      // 5. Recreate indexes (identical to migration 031).
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_task_runs_scope_updated
          ON skill_task_runs(scope_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_skill_task_runs_session_status_updated
          ON skill_task_runs(session_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_skill_task_runs_skill_updated
          ON skill_task_runs(skill_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_skill_task_runs_job_id
          ON skill_task_runs(job_id);
        CREATE INDEX IF NOT EXISTS idx_skill_task_runs_detached_task_id
          ON skill_task_runs(detached_task_id);
      `)
    }
  },

  // ------------------------------------------------------------------ 034
  // Stage S (PR-S11) — `run_meta` table.
  //
  // Per-run metadata aggregator owned by main process: token-usage rollup,
  // first/last/follow-up message text snapshots, and run-level status.
  // Indexed by task_id and scope_id for projection joins.
  {
    name: '034_add_run_meta_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_meta (
          run_id TEXT PRIMARY KEY,
          task_id TEXT,
          scope_id TEXT,
          agent_id TEXT,
          status TEXT NOT NULL,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          first_message_text TEXT,
          last_message_text TEXT,
          follow_up_text TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_run_meta_task_id ON run_meta(task_id);
        CREATE INDEX IF NOT EXISTS idx_run_meta_scope_id ON run_meta(scope_id);
      `)
    }
  },

  // ------------------------------------------------------------------ 035
  // Stage S (PR-S11) — `thread_meta` table.
  //
  // Thread-level metadata (display title, pinned/archived flags) keyed by
  // `thread_id`. Owner identity (`owner_kind` + `owner_id`) is set at create
  // time and is immutable thereafter; the strict-mutate contract is enforced
  // by `thread-meta-repository.ts` (see check-thread-meta-strict-mutate.cjs).
  {
    name: '035_add_thread_meta_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS thread_meta (
          thread_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user','agent','system')),
          owner_id TEXT NOT NULL,
          display_title TEXT,
          pinned INTEGER DEFAULT 0,
          archived INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_thread_meta_scope_id ON thread_meta(scope_id);
      `)
    }
  },

  // ------------------------------------------------------------------ 036
  // Stage S (PR-S11) — `run_feedback` table.
  //
  // Per-run user feedback (rating 1-5, optional signal label, optional
  // free-text comment). Foreign-keyed to `run_meta(run_id)` for join-based
  // queries. Note: SQLite foreign-key enforcement is OFF by default and is
  // not enabled by the migration framework; the FK is declarative for the
  // schema reader, but PRAGMA enforcement is a separate runtime concern.
  // TODO(stage-s-followup): wire `PRAGMA foreign_keys = ON` at connection
  // open time if/when joining workflows depend on cascade semantics.
  // Repository upsert shape: INSERT ... ON CONFLICT(feedback_id) DO UPDATE.
  {
    name: '036_add_run_feedback_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_feedback (
          feedback_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          task_id TEXT,
          rating INTEGER CHECK (rating BETWEEN 1 AND 5),
          signal TEXT,
          comment TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES run_meta(run_id)
        );
        CREATE INDEX IF NOT EXISTS idx_run_feedback_run_id ON run_feedback(run_id);
      `)
    }
  },

  // ------------------------------------------------------------------ 037
  // Calendar L0-Schema-Lock: agent_action 列从声明以来零消费者，按 §0.5.3
  // 拒绝 legacy 痕迹与 §6.13 CREATE-INSERT-DROP-RENAME 模式删除。其余 4 个
  // 保留字段（recurrence_rule / reminders / sync_url / sync_interval）由
  // 下游 L2-L4 团队落实，由 `scripts/check-calendar-schema-no-dead-fields.cjs`
  // 守门防止回退。
  {
    name: '037_drop_calendar_events_agent_action',
    up: (db) => {
      db.exec(`
        CREATE TABLE calendar_events_new (
          id TEXT PRIMARY KEY,
          calendar_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          location TEXT,
          start_time INTEGER NOT NULL,
          end_time INTEGER NOT NULL,
          all_day INTEGER DEFAULT 0,
          recurrence_rule TEXT,
          reminders TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          FOREIGN KEY (calendar_id) REFERENCES calendar_sources(id) ON DELETE CASCADE
        );

        INSERT INTO calendar_events_new (
          id, calendar_id, title, description, location,
          start_time, end_time, all_day, recurrence_rule, reminders,
          created_at, updated_at
        )
        SELECT
          id, calendar_id, title, description, location,
          start_time, end_time, all_day, recurrence_rule, reminders,
          created_at, updated_at
        FROM calendar_events;

        DROP TABLE calendar_events;

        ALTER TABLE calendar_events_new RENAME TO calendar_events;

        CREATE INDEX IF NOT EXISTS idx_events_start_date ON calendar_events(start_time);
        CREATE INDEX IF NOT EXISTS idx_events_end_date ON calendar_events(end_time);
        CREATE INDEX IF NOT EXISTS idx_events_calendar ON calendar_events(calendar_id);
      `)
    }
  },

  // ------------------------------------------------------------------ 038
  // Calendar L3-A RRULE-Engine — `calendar_event_overrides` table for
  // per-occurrence overrides of recurring events. Two kinds:
  //   - 'single': patch one occurrence's fields (title / time / location /
  //     reminders) WITHOUT touching the parent's RRULE.
  //   - 'cancelled': hide one occurrence entirely.
  // `occurrence_start` is the ORIGINAL Unix-seconds timestamp of the
  // occurrence as RRULE produces it (pre-patch). A "move Tuesday to
  // Wednesday" creates an override keyed by the Tuesday timestamp.
  // `patch_json` is the JSON-encoded partial fields; null when
  // kind='cancelled'. CHECK constraint enforces the patch_json/kind
  // discipline at the schema layer per §0.5.5 (CI > docs > human review).
  //
  // L3-A creates the schema only; L3-B (UI) wires the CRUD operations.
  // Per §6.13 — fresh tables use simple CREATE; the table is new so no
  // CREATE-INSERT-DROP-RENAME pattern is needed.
  {
    name: '038_create_calendar_event_overrides',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_event_overrides (
          id TEXT PRIMARY KEY,
          parent_event_id TEXT NOT NULL,
          occurrence_start INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('single', 'cancelled')),
          patch_json TEXT,
          created_at INTEGER DEFAULT (unixepoch()),
          updated_at INTEGER DEFAULT (unixepoch()),
          UNIQUE (parent_event_id, occurrence_start),
          FOREIGN KEY (parent_event_id) REFERENCES calendar_events(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_event_overrides_parent
          ON calendar_event_overrides(parent_event_id);
        CREATE INDEX IF NOT EXISTS idx_event_overrides_occurrence
          ON calendar_event_overrides(occurrence_start);
      `)
    }
  },

  // ------------------------------------------------------------------ 039
  // Calendar L4-A-Timezone — add `start_tz / end_tz TEXT` columns to
  // `calendar_events`. SQLite `ALTER TABLE ADD COLUMN` is non-destructive
  // and preserves existing rows, so we use it directly instead of the
  // CREATE-INSERT-DROP-RENAME pattern (§6.13 reserves that pattern for
  // schema changes that ADD/CHANGE CHECK constraints or REORDER columns,
  // neither of which applies here).
  //
  // Column semantics:
  //   - NULL  ⇒ local timezone (back-compat for events created before
  //     migration 039 lands; their behavior is unchanged).
  //   - non-NULL ⇒ IANA timezone identifier (e.g. 'Asia/Shanghai' /
  //     'America/New_York' / 'UTC') for the start and end wall-clocks.
  // Validation of IANA strings happens at the application layer; the DB
  // stores whatever the IPC layer wrote. Bad identifiers surface as
  // runtime errors when `timezone-utils.formatInTimezone` is called.
  //
  // L4-A only adds the schema + helpers; downstream call sites (rrule
  // engine, schedule-x renderer, reminder scheduler) consume the columns
  // as further teams wire them through.
  {
    name: '039_add_calendar_events_timezone',
    up: (db) => {
      db.exec(`
        ALTER TABLE calendar_events ADD COLUMN start_tz TEXT;
        ALTER TABLE calendar_events ADD COLUMN end_tz TEXT;
      `)
    }
  },

  // ------------------------------------------------------------------ 040
  // Calendar L4-B-External-Sync — add `ics_uid / source_id TEXT` columns
  // to `calendar_events` so externally-synced VEVENTs can be tracked by
  // their iCal UID and back-linked to the originating `calendar_sources`
  // row.
  //
  //   - `ics_uid`: the VEVENT UID from the upstream feed. Null for
  //     locally-authored rows. The sync scheduler matches by
  //     `(source_id, ics_uid)` so re-syncing the same feed lands on the
  //     same row and dedups correctly.
  //   - `source_id`: redundant with `calendar_id` for purely-local rows
  //     but explicit for externally-synced events so a sync diff can
  //     answer "give me every row this subscription owns" without
  //     needing a separate join through `calendar_sources`. The two
  //     columns are different concepts: `calendar_id` is "which user-
  //     visible calendar bucket the event appears in", `source_id` is
  //     "which sync feed produced this row". They happen to be the same
  //     id when an ICS subscription writes events into its own
  //     auto-created source; they diverge if a user moves an externally-
  //     synced event into a different local calendar (future feature).
  //
  // SQLite ALTER TABLE ADD COLUMN is non-destructive, so per §6.13 we
  // use ALTER directly rather than the CREATE-INSERT-DROP-RENAME pattern
  // (reserved for changes that add CHECK constraints or reorder columns).
  // Indexes on both columns speed up the sync-scheduler diff query.
  {
    name: '040_add_calendar_event_ics_uid',
    up: (db) => {
      db.exec(`
        ALTER TABLE calendar_events ADD COLUMN ics_uid TEXT;
        ALTER TABLE calendar_events ADD COLUMN source_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_events_ics_uid ON calendar_events(ics_uid);
        CREATE INDEX IF NOT EXISTS idx_events_source_id ON calendar_events(source_id);
      `)
    }
  },

  // ------------------------------------------------------------------ 041
  // RSS analysis jobs can now be launched from browser tabs as well as true
  // RSS items. Keep `item_id` as the UI correlation key, but do not require it
  // to exist in `rss_items`, otherwise browser-tab analysis fails at job create.
  {
    name: '041_relax_rss_analysis_item_fk',
    up: (db) => {
      db.exec(`
        CREATE TABLE rss_analysis_jobs_new (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          action TEXT NOT NULL,
          source_url TEXT NOT NULL,
          title TEXT NOT NULL,
          target_dir TEXT NOT NULL,
          output_dir TEXT NOT NULL,
          report_path TEXT,
          status TEXT NOT NULL,
          progress INTEGER NOT NULL DEFAULT 0,
          message TEXT,
          error TEXT,
          meta_json TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          updated_at TEXT NOT NULL,
          finished_at TEXT
        );

        INSERT INTO rss_analysis_jobs_new (
          id, item_id, action, source_url, title, target_dir, output_dir,
          report_path, status, progress, message, error, meta_json,
          created_at, started_at, updated_at, finished_at
        )
        SELECT
          id, item_id, action, source_url, title, target_dir, output_dir,
          report_path, status, progress, message, error, meta_json,
          created_at, started_at, updated_at, finished_at
        FROM rss_analysis_jobs;

        DROP TABLE rss_analysis_jobs;
        ALTER TABLE rss_analysis_jobs_new RENAME TO rss_analysis_jobs;

        CREATE INDEX IF NOT EXISTS idx_rss_analysis_item_updated
          ON rss_analysis_jobs(item_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_rss_analysis_status_updated
          ON rss_analysis_jobs(status, updated_at DESC);
      `)
    }
  },

  // ------------------------------------------------------------------ 042
  {
    name: '042_create_document_marks',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS document_marks (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('bookmark', 'note')),
          document_path TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          group_name TEXT NOT NULL DEFAULT '默认',
          note_text TEXT,
          excerpt TEXT,
          line_start INTEGER,
          line_end INTEGER,
          anchor_title TEXT,
          anchor_ordinal INTEGER,
          anchor_progress REAL,
          anchor_status TEXT NOT NULL DEFAULT 'linked',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_document_marks_path_kind
          ON document_marks(document_path, kind, sort_order, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_document_marks_path_group
          ON document_marks(document_path, group_name, kind);
      `)
    }
  },

  // ------------------------------------------------------------------ 043
  // Stage 6 deferred closeout — task_projections.status now shares the
  // SkillChildRunStatus vocabulary. Existing rows keep their meaning, but
  // their terminal text values move from projection-local names to child-run
  // names:
  //   - done      -> completed
  //   - cancelled -> killed
  {
    name: '043_migrate_task_projection_status_to_child_status',
    up: (db) => {
      db.exec(`
        UPDATE task_projections
        SET status = CASE status
          WHEN 'done' THEN 'completed'
          WHEN 'cancelled' THEN 'killed'
          ELSE status
        END
        WHERE status IN ('done', 'cancelled')
      `)
    }
  },

  // ------------------------------------------------------------------ 044
  {
    name: '044_add_task_projection_progress_json',
    up: (db) => {
      try {
        db.exec('ALTER TABLE task_projections ADD COLUMN progress_json TEXT')
      } catch {
        // column already exists
      }
    }
  },

  // ------------------------------------------------------------------ 045
  {
    name: '045_seed_default_agent_personas',
    up: (db) => {
      const now = Date.now()
      const insert = db.prepare(`
        INSERT INTO agent_personalities (
          id, agent_name, display_name, personality_text, tone, meta_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_name) DO NOTHING
      `)

      for (const seed of DEFAULT_AGENT_PERSONA_SEEDS) {
        insert.run(
          `default-persona-${seed.agentName}`,
          seed.agentName,
          seed.displayName,
          DEFAULT_AGENT_PERSONAS[seed.agentName],
          null,
          JSON.stringify({ emoji: seed.emoji }),
          now,
          now,
        )
      }
    }
  },

  // ------------------------------------------------------------------ 046
  {
    name: '046_file_activity_events',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_activity_events (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          workspace_root TEXT,
          event_type TEXT NOT NULL,
          source TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1,
          meta_json TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_file_activity_path_time
          ON file_activity_events(path, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_file_activity_workspace_time
          ON file_activity_events(workspace_root, created_at DESC);
      `)
    }
  },

  // ------------------------------------------------------------------ 047
  {
    name: '047_document_reading_sessions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS document_reading_sessions (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          workspace_root TEXT,
          source TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER NOT NULL,
          active_ms INTEGER NOT NULL,
          progress_start REAL,
          progress_end REAL,
          progress_kind TEXT,
          meta_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_document_reading_sessions_path_time
          ON document_reading_sessions(path, ended_at DESC);

        CREATE INDEX IF NOT EXISTS idx_document_reading_sessions_workspace_time
          ON document_reading_sessions(workspace_root, ended_at DESC);
      `)
    }
  },

  // ------------------------------------------------------------------ 048
  {
    name: '048_browser_site_experience',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_site_experience (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          path_pattern TEXT,
          applies_to_task_kinds_json TEXT NOT NULL,
          aliases_json TEXT NOT NULL,
          reliable_entry_patterns_json TEXT NOT NULL,
          generated_link_patterns_json TEXT NOT NULL,
          known_traps_json TEXT NOT NULL,
          selectors_or_target_hints_json TEXT NOT NULL,
          frame_hints_json TEXT NOT NULL,
          risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
          confidence REAL NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('manual','successful-task','test-fixture')),
          last_verified_at TEXT NOT NULL,
          expires_at TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_browser_site_experience_domain
          ON browser_site_experience(domain, updated_at DESC);
      `)
    }
  },

  // ------------------------------------------------------------------ 049
  {
    name: '049_extend_run_meta_long_task_diagnostics',
    up: (db) => {
      const addColumn = (sql: string): void => {
        try {
          db.exec(sql)
        } catch {
          // column already exists
        }
      }
      addColumn('ALTER TABLE run_meta ADD COLUMN task_type TEXT')
      addColumn('ALTER TABLE run_meta ADD COLUMN terminal_reason TEXT')
      addColumn('ALTER TABLE run_meta ADD COLUMN provider_protocol TEXT')
      addColumn('ALTER TABLE run_meta ADD COLUMN wire_api TEXT')
      addColumn('ALTER TABLE run_meta ADD COLUMN context_window INTEGER')
      addColumn('ALTER TABLE run_meta ADD COLUMN provider_diagnostics_json TEXT')
      addColumn('ALTER TABLE run_meta ADD COLUMN budget_json TEXT')
      addColumn('ALTER TABLE run_meta ADD COLUMN continuation_ref_json TEXT')
      addColumn('ALTER TABLE run_meta ADD COLUMN recovery_history_json TEXT')
    }
  },

  // ------------------------------------------------------------------ 050
  {
    name: '050_add_run_meta_initiator_duration',
    up: (db) => {
      const addColumn = (sql: string): void => {
        try {
          db.exec(sql)
        } catch {
          // column already exists
        }
      }
      addColumn('ALTER TABLE run_meta ADD COLUMN initiator TEXT')
      addColumn('ALTER TABLE run_meta ADD COLUMN duration_ms INTEGER')
    }
  },

  // ------------------------------------------------------------------ 051
  {
    name: '051_create_pending_task_events',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_task_events (
          id INTEGER PRIMARY KEY,
          event_payload TEXT NOT NULL,
          task_run_id TEXT,
          created_at INTEGER NOT NULL,
          consumed INTEGER NOT NULL DEFAULT 0
        )
      `)
    }
  },
  // ------------------------------------------------------------------ 052
  {
    // EP1-K2 — belief card DB mirror columns. The cards are file-truth
    // (belief-card-store.ts); these nullable columns let a row in
    // agent_memory_metadata index a card (slug/confidence/file_path/status +
    // content_hash for file→DB drift detection). Existing rows keep NULL.
    name: '052_belief_card_mirror_columns',
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(agent_memory_metadata)').all<{ name: string }>()
      const has = (name: string) => cols.some((c) => c.name === name)
      // SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS; check first.
      if (!has('slug')) db.exec('ALTER TABLE agent_memory_metadata ADD COLUMN slug TEXT')
      if (!has('confidence')) db.exec('ALTER TABLE agent_memory_metadata ADD COLUMN confidence TEXT')
      if (!has('file_path')) db.exec('ALTER TABLE agent_memory_metadata ADD COLUMN file_path TEXT')
      if (!has('status')) db.exec('ALTER TABLE agent_memory_metadata ADD COLUMN status TEXT')
      if (!has('content_hash')) db.exec('ALTER TABLE agent_memory_metadata ADD COLUMN content_hash TEXT')
    }
  },
  {
    // EP1-I3-2 — frozen-call ledger for the M2/M3 action-confirmation gate.
    // Rows are the durable audit trail; the one-shot release token is
    // memory-only by design (execution waits inside the original run's
    // context — after a restart there is nothing to resume, so the boot
    // sweep in frozen-call-store.ts expires orphaned pending rows).
    name: '053_pending_confirmations',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_confirmations (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          task_id TEXT,
          scope_id TEXT,
          tool_name TEXT NOT NULL,
          params_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          released_at TEXT
        )
      `)
      db.exec('CREATE INDEX IF NOT EXISTS idx_pending_confirmations_status ON pending_confirmations(status, expires_at)')
    }
  },
  {
    // EP2-Q1 — task quality columns (criteria / checkins / proof refs /
    // learning refs). Columns only; write-side governance limits and
    // archiving land with the Q3/Q4 writers.
    name: '054_task_projection_quality_columns',
    up: (db) => {
      db.exec('ALTER TABLE task_projections ADD COLUMN criteria_json TEXT')
      db.exec('ALTER TABLE task_projections ADD COLUMN checkins_json TEXT')
      db.exec('ALTER TABLE task_projections ADD COLUMN proof_refs_json TEXT')
      db.exec('ALTER TABLE task_projections ADD COLUMN learning_refs_json TEXT')
    }
  },
  {
    // EP3-A1 — agents registry. 08/04 迁移口径：仅建主 agent 一行；表只有
    // 主 agent 行时系统行为 = 现状（存量零感知）。
    name: '055_agents_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          charter TEXT,
          persona_ref TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL
        )
      `)
      db.prepare(
        'INSERT OR IGNORE INTO agents (id, name, charter, persona_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('butler', '管家', '主 agent：协调全部产品域任务', null, 'active', new Date().toISOString())
    }
  },
  {
    // EP3-A1 — task owner column (write value comes ONLY from EP3-A4).
    name: '056_task_projection_owner_agent',
    up: (db) => {
      db.exec('ALTER TABLE task_projections ADD COLUMN owner_agent_id TEXT')
    }
  },
  {
    // EP3-PK1 — task packets are a usage convention on task_projections
    // (09 §2): packet_role 'parent'|'child'|NULL is the ONLY packet marker;
    // context_refs_json carries references, never retellings.
    name: '057_task_projection_packet_columns',
    up: (db) => {
      db.exec('ALTER TABLE task_projections ADD COLUMN packet_role TEXT')
      db.exec('ALTER TABLE task_projections ADD COLUMN context_refs_json TEXT')
    }
  },
  {
    // EP4-A6a — specialist agent derivation lineage. Name-isolated and
    // idempotent: phase-4 derivation can record where a specialist came from
    // without changing the main-agent-only baseline.
    name: '058_agent_derivation_columns',
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(agents)').all<{ name: string }>()
      const has = (name: string) => cols.some((c) => c.name === name)
      if (!has('parent_agent_id')) db.exec('ALTER TABLE agents ADD COLUMN parent_agent_id TEXT')
      if (!has('derivation_reason')) db.exec('ALTER TABLE agents ADD COLUMN derivation_reason TEXT')
    }
  },
  {
    // EP4-A7 — lifecycle merge target. Assets stay on disk; this column only
    // records where a merged agent's future work should be attributed.
    name: '059_agent_lifecycle_merged_target',
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(agents)').all<{ name: string }>()
      const has = (name: string) => cols.some((c) => c.name === name)
      if (!has('merged_into_agent_id')) db.exec('ALTER TABLE agents ADD COLUMN merged_into_agent_id TEXT')
    }
  },
  {
    // P8g-2 — specialist blueprint review state and one-shot confirmation
    // tokens must survive app restarts before the factory creates real assets.
    name: '060_specialist_blueprint_persistence',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS specialist_blueprints (
          blueprint_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          specialist_id TEXT,
          source TEXT,
          content_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_specialist_blueprints_status
        ON specialist_blueprints(status)
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS specialist_blueprint_confirmations (
          token_id TEXT PRIMARY KEY,
          blueprint_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          run_id TEXT,
          blueprint_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          used_at TEXT
        )
      `)
    }
  },
  {
    // P1b-C06 — terminal projection sync failures must survive process
    // restarts so the runtime can retry them without blocking event ack.
    name: '061_pending_projection_syncs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending_projection_syncs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK(status IN ('pending', 'exhausted')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pending_projection_syncs_due
        ON pending_projection_syncs(status, next_attempt_at)
      `)
    }
  },
  {
    // P8g-8b — Studio content edits are durable staged proposals. The
    // active RULES/FOUNDATION/card files are only mutated after confirm.
    name: '062_specialist_content_edit_proposals',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS specialist_content_edit_proposals (
          proposal_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_rel_path TEXT NOT NULL,
          base_hash TEXT NOT NULL,
          base_content TEXT NOT NULL,
          proposed_content TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('staged', 'applied', 'rejected', 'conflict')),
          provenance_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          applied_at TEXT
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_specialist_content_edit_agent_status
        ON specialist_content_edit_proposals(agent_id, status, updated_at)
      `)
    }
  },
  {
    // P4-D/C27 — session recall metadata must carry the owning scope agent
    // so automatic recall cannot leak another specialist's history into the
    // current agent prompt. Legacy rows are backfilled from chat_conversations;
    // rows without a surviving conversation remain NULL and are excluded by
    // agent-filtered reads.
    name: '063_session_recall_agent_column',
    up: (db) => {
      const columns = db
        .prepare('PRAGMA table_info(session_recall_metadata)')
        .all<{ name: string }>()
      const hasAgent = columns.some((column) => column.name === 'agent')
      if (!hasAgent) {
        db.exec('ALTER TABLE session_recall_metadata ADD COLUMN agent TEXT')
      }
      db.exec(`
        UPDATE session_recall_metadata
        SET agent = (
          SELECT chat_conversations.agent
          FROM chat_conversations
          WHERE chat_conversations.id = session_recall_metadata.conversation_id
        )
        WHERE agent IS NULL
          AND EXISTS (
            SELECT 1
            FROM chat_conversations
            WHERE chat_conversations.id = session_recall_metadata.conversation_id
          )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_recall_agent
        ON session_recall_metadata(agent, channel_key, updated_at DESC)
      `)
    }
  },
  {
    // 2026-06-22 — Agent identity unification. Registry id, personality
    // agent_name, scope.agent, and ownerAgentId all share one slug namespace.
    // Legacy "retired" rows normalize to "disabled"; chat_conversations.agent
    // is intentionally never rewritten.
    name: '064_agent_identity_unification',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_identity_migration (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          old_agent_id TEXT,
          new_agent_id TEXT,
          details_json TEXT NOT NULL,
          asset_reconciled_at TEXT,
          created_at TEXT NOT NULL
        )
      `)

      const now = migrationNowIso()
      const nowMs = migrationNowMs()

      const selectAgents = () => db.prepare(`
        SELECT id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at
        FROM agents
      `).all<MigrationAgentRow>()
      const selectPersonalities = () => db.prepare(`
        SELECT agent_name, display_name, personality_text, meta_json
        FROM agent_personalities
      `).all<MigrationPersonalityRow>()

      db.exec("UPDATE agents SET status = 'disabled' WHERE status = 'retired'")

      let agentRows = selectAgents()
      let existingIds = new Set(agentRows.map((row) => row.id))
      const personalitiesByName = new Map(selectPersonalities().map((row) => [row.agent_name, row]))

      for (const builtinId of BUILTIN_AGENT_IDS) {
        const builtin = BUILTIN_AGENT_META[builtinId]
        const current = agentRows.find((row) => row.id === builtinId)
        let currentPersonality = personalitiesByName.get(builtinId)
        const isDerivedConflict = Boolean(
          current
          && builtinId !== 'butler'
          && (
            current.parent_agent_id
            || current.derivation_reason
            || (current.status !== 'active' && current.name !== builtin.displayName)
          )
        )

        if (current && isDerivedConflict) {
          const reassignedId = nextAvailableAgentSlug(existingIds, current.name, builtinId)
          existingIds.add(reassignedId)
          db.prepare(`
            UPDATE agents
            SET id = ?, status = ?, persona_ref = ?
            WHERE id = ?
          `).run(
            reassignedId,
            normalizeAgentLifecycleStatus(current.status),
            reassignedId,
            builtinId,
          )
          if (reassignPersonalityForReservedSlug(db, builtinId, reassignedId)) {
            currentPersonality = undefined
          }
          db.prepare('UPDATE task_projections SET owner_agent_id = ? WHERE owner_agent_id = ?')
            .run(reassignedId, builtinId)
          db.prepare('UPDATE specialist_content_edit_proposals SET agent_id = ? WHERE agent_id = ?')
            .run(reassignedId, builtinId)
          db.prepare('UPDATE specialist_blueprints SET specialist_id = ? WHERE specialist_id = ?')
            .run(reassignedId, builtinId)
          db.prepare(`
            UPDATE specialist_blueprints
            SET content_json = replace(
              replace(
                replace(content_json, ?, ?),
                ?, ?
              ),
              ?, ?
            )
          `).run(
            `"specialistId":"${builtinId}"`,
            `"specialistId":"${reassignedId}"`,
            `"createdAgentId":"${builtinId}"`,
            `"createdAgentId":"${reassignedId}"`,
            `"targetAgentId":"${builtinId}"`,
            `"targetAgentId":"${reassignedId}"`,
          )
          db.prepare(`
            INSERT OR IGNORE INTO agent_identity_migration (
              id, kind, old_agent_id, new_agent_id, details_json, asset_reconciled_at, created_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?)
          `).run(
            `reassign-${builtinId}-${reassignedId}`,
            'reserved_slug_reassigned',
            builtinId,
            reassignedId,
            JSON.stringify({
              oldName: current.name,
              oldStatus: current.status,
              parentAgentId: current.parent_agent_id ?? null,
              derivationReason: current.derivation_reason ?? null,
            }),
            now,
          )
        }

        if (!currentPersonality) {
          db.prepare(`
            INSERT INTO agent_personalities (
              id, agent_name, display_name, personality_text, tone, meta_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            `default-persona-${builtinId}`,
            builtinId,
            builtin.displayName,
            AGENT_IDENTITY_PERSONAS[builtinId],
            null,
            JSON.stringify({ emoji: builtin.emoji }),
            nowMs,
            nowMs,
          )
        } else {
          const previousDefault = DEFAULT_AGENT_PERSONAS[builtinId]
          const shouldRefreshText = currentPersonality.personality_text === previousDefault
          db.prepare(`
            UPDATE agent_personalities
            SET display_name = ?,
                personality_text = CASE WHEN ? THEN ? ELSE personality_text END,
                meta_json = ?,
                updated_at = ?
            WHERE agent_name = ?
          `).run(
            builtin.displayName,
            shouldRefreshText ? 1 : 0,
            AGENT_IDENTITY_PERSONAS[builtinId],
            JSON.stringify({ emoji: builtin.emoji }),
            nowMs,
            builtinId,
          )
        }

        db.prepare(`
          INSERT INTO agents (id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at)
          VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            charter = COALESCE(agents.charter, excluded.charter),
            persona_ref = excluded.persona_ref,
            status = 'active'
        `).run(
          builtinId,
          builtin.displayName,
          builtin.charter,
          builtinId,
          now,
        )

        agentRows = selectAgents()
        existingIds = new Set(agentRows.map((row) => row.id))
      }

      const agentsById = new Map(selectAgents().map((row) => [row.id, row]))
      const personalities = selectPersonalities()

      for (const personality of personalities) {
        if (agentsById.has(personality.agent_name)) continue
        const displayName = personality.display_name || defaultAgentDisplayName(personality.agent_name)
        db.prepare(`
          INSERT INTO agents (id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at)
          VALUES (?, ?, ?, ?, 'active', NULL, ?, NULL, ?)
        `).run(
          personality.agent_name,
          displayName,
          `用户创建的 ${displayName} agent`,
          personality.agent_name,
          'personality-backfill',
          now,
        )
      }

      const personalityNames = new Set(selectPersonalities().map((row) => row.agent_name))
      for (const agent of selectAgents()) {
        if (personalityNames.has(agent.id)) continue
        db.prepare(`
          INSERT INTO agent_personalities (
            id, agent_name, display_name, personality_text, tone, meta_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `personality-${agent.id}`,
          agent.id,
          agent.name,
          generatedPersonalityText(agent.id, agent.name, agent.charter),
          null,
          JSON.stringify({ emoji: defaultAgentDisplayName(agent.id) === agent.name ? BUILTIN_AGENT_META[agent.id as BuiltinAgentId]?.emoji ?? '🤖' : '🤖' }),
          nowMs,
          nowMs,
        )
      }

      db.exec(`
        UPDATE agents
        SET persona_ref = id
        WHERE persona_ref IS NULL OR persona_ref = '' OR persona_ref NOT IN (
          SELECT agent_name FROM agent_personalities
        )
      `)
      db.exec("UPDATE agents SET status = 'disabled' WHERE status = 'retired'")
    }
  },
  {
    // R-CRIT-P — task-level model declarations must survive restart so the
    // terminal finalizer can enforce the same criteria and delivery targets.
    name: '065_task_projection_completion_declarations',
    up: (db) => {
      db.exec('ALTER TABLE task_projections ADD COLUMN model_criteria_json TEXT')
      db.exec('ALTER TABLE task_projections ADD COLUMN expected_outputs_json TEXT')
    }
  },
  {
    name: '066_agent_foundation_identity_binding',
    up: (db) => {
      db.exec('ALTER TABLE chat_conversations ADD COLUMN active_agent_id TEXT')
      db.exec('ALTER TABLE chat_conversations ADD COLUMN handoff_generation INTEGER NOT NULL DEFAULT 0')
      db.exec('ALTER TABLE task_projections ADD COLUMN task_origin TEXT')
      db.exec('ALTER TABLE task_projections ADD COLUMN execution_binding_json TEXT')
      db.exec('ALTER TABLE run_meta ADD COLUMN execution_binding_json TEXT')

      type AgentRow = { id: string; status: string; merged_into_agent_id: string | null }
      const agents = new Map(
        db.prepare('SELECT id, status, merged_into_agent_id FROM agents')
          .all<AgentRow>()
          .map((row) => [row.id, row]),
      )
      const resolveActive = (requested: string | null | undefined): string => {
        let current = String(requested || '').trim()
        const seen = new Set<string>()
        while (current && !seen.has(current)) {
          seen.add(current)
          const agent = agents.get(current)
          if (!agent) break
          if (agent.status === 'active') return agent.id
          if (agent.status !== 'merged' || !agent.merged_into_agent_id) break
          current = agent.merged_into_agent_id
        }
        return 'butler'
      }

      type ConversationRow = { id: string; agent: string }
      const conversations = db.prepare('SELECT id, agent FROM chat_conversations').all<ConversationRow>()
      const latestOwner = db.prepare(`
        SELECT owner_agent_id
        FROM task_projections
        WHERE scope_id = ? AND owner_agent_id IS NOT NULL
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `)
      const updateConversation = db.prepare(
        'UPDATE chat_conversations SET active_agent_id = ? WHERE id = ?',
      )
      for (const conversation of conversations) {
        const owner = latestOwner.all<{ owner_agent_id: string | null }>(conversation.id)[0]?.owner_agent_id
        const ownerAgent = owner ? agents.get(owner) : null
        const requested = ownerAgent?.status === 'active' ? owner : conversation.agent
        updateConversation.run(resolveActive(requested), conversation.id)
      }

      db.exec("UPDATE task_projections SET task_origin = 'legacy' WHERE task_origin IS NULL")
      db.exec(`
        UPDATE task_projections
        SET owner_agent_id = (
          SELECT COALESCE(chat_conversations.active_agent_id, chat_conversations.agent)
          FROM chat_conversations
          WHERE chat_conversations.id = task_projections.scope_id
        )
        WHERE owner_agent_id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM task_projections AS handed_off
            WHERE handed_off.scope_id = task_projections.scope_id
              AND handed_off.owner_agent_id IS NOT NULL
          )
          AND EXISTS (
            SELECT 1 FROM chat_conversations
            WHERE chat_conversations.id = task_projections.scope_id
          )
      `)
    }
  },
  {
    name: '067_dynamic_delivery_state',
    up: (db) => {
      db.exec('ALTER TABLE task_projections ADD COLUMN delivery_state_json TEXT')
    }
  },
  {
    name: '068_file_project_identity',
    up: (db) => {
      db.exec(`
        CREATE TABLE file_identities (
          file_key TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL,
          current_path TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('present', 'missing', 'deleted')),
          content_hash TEXT,
          observed_since INTEGER NOT NULL,
          last_verified_at INTEGER NOT NULL,
          UNIQUE(workspace_root, current_path)
        );

        CREATE INDEX idx_file_identities_workspace_path
          ON file_identities(workspace_root, current_path);

        CREATE TABLE file_move_receipts (
          receipt_id TEXT PRIMARY KEY,
          file_key TEXT NOT NULL REFERENCES file_identities(file_key) ON DELETE CASCADE,
          workspace_root TEXT NOT NULL,
          old_path TEXT NOT NULL,
          new_path TEXT NOT NULL,
          move_kind TEXT NOT NULL CHECK(move_kind IN ('file', 'directory')),
          moved_at INTEGER NOT NULL,
          UNIQUE(file_key, old_path, new_path)
        );

        CREATE INDEX idx_file_move_receipts_old_path
          ON file_move_receipts(workspace_root, old_path, moved_at DESC);

        CREATE TABLE project_identities (
          project_key TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL,
          display_name TEXT NOT NULL,
          source TEXT NOT NULL,
          confidence REAL NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active', 'snoozed', 'hidden', 'merged')),
          anchor_path TEXT,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX idx_project_identities_workspace_anchor
          ON project_identities(workspace_root, anchor_path, updated_at DESC);

        CREATE TABLE project_identity_members (
          project_key TEXT NOT NULL REFERENCES project_identities(project_key) ON DELETE CASCADE,
          file_key TEXT NOT NULL REFERENCES file_identities(file_key) ON DELETE CASCADE,
          source TEXT NOT NULL,
          confidence REAL NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_key, file_key)
        );

        CREATE UNIQUE INDEX idx_project_identity_member_owner
          ON project_identity_members(file_key);
      `)
    }
  },
  {
    name: '069_file_emergence_long_term_attention',
    up: (db) => {
      db.exec(`
        CREATE TABLE file_attention_rollups (
          file_key TEXT PRIMARY KEY REFERENCES file_identities(file_key) ON DELETE CASCADE,
          observed_since INTEGER NOT NULL,
          history_coverage_start INTEGER NOT NULL,
          history_coverage_end INTEGER NOT NULL,
          first_open_at INTEGER, last_open_at INTEGER,
          first_save_at INTEGER, last_save_at INTEGER,
          first_read_at INTEGER, last_read_at INTEGER,
          open_count INTEGER NOT NULL DEFAULT 0,
          save_count INTEGER NOT NULL DEFAULT 0,
          active_days_json TEXT NOT NULL DEFAULT '[]',
          reading_ms INTEGER NOT NULL DEFAULT 0,
          latest_progress REAL, max_progress REAL, progress_kind TEXT,
          mark_count INTEGER NOT NULL DEFAULT 0,
          link_in_count INTEGER NOT NULL DEFAULT 0,
          link_out_count INTEGER NOT NULL DEFAULT 0,
          last_task_at INTEGER, last_artifact_at INTEGER, last_calendar_at INTEGER, last_attachment_at INTEGER,
          last_surfaced_at INTEGER, last_clicked_at INTEGER, snoozed_until INTEGER, hidden_at INTEGER,
          exists_state TEXT NOT NULL DEFAULT 'present' CHECK(exists_state IN ('present','missing','archived')),
          backfilled_at INTEGER, updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_file_attention_rollups_last_activity
          ON file_attention_rollups(last_open_at, last_save_at, last_read_at);

        CREATE TABLE project_intent_facts (
          intent_id TEXT PRIMARY KEY,
          project_key TEXT NOT NULL REFERENCES project_identities(project_key) ON DELETE CASCADE,
          file_keys_json TEXT NOT NULL DEFAULT '[]',
          kind TEXT NOT NULL CHECK(kind IN ('continue','prepare','deliver','read')),
          source TEXT NOT NULL CHECK(source IN ('calendar','task','user_confirmed')),
          not_before INTEGER, due_at INTEGER, expires_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','completed','cancelled','expired')),
          evidence_code TEXT NOT NULL,
          evidence_ref TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_project_intent_active
          ON project_intent_facts(project_key, status, expires_at);

        CREATE TABLE file_emergence_prediction_snapshots (
          snapshot_id TEXT NOT NULL,
          project_key TEXT NOT NULL,
          bucket TEXT NOT NULL CHECK(bucket IN ('future','today','past','distant')),
          reason_codes_json TEXT NOT NULL,
          generated_at INTEGER NOT NULL,
          PRIMARY KEY(snapshot_id, project_key)
        );
      `)
    }
  },
  {
    name: '070_tag_forge_controlled_tagging',
    up: (db) => {
      db.exec(`
        CREATE TABLE tag_lexicon_overlays (
          tag_id TEXT PRIMARY KEY,
          facet TEXT NOT NULL CHECK(facet IN ('form','domain','entity','use','state')),
          label TEXT NOT NULL,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          definition TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('active','deprecated')),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_tag_overlay_facet_label ON tag_lexicon_overlays(facet,label);

        CREATE TABLE tag_pending_proposals (
          proposal_id TEXT PRIMARY KEY,
          facet TEXT NOT NULL CHECK(facet IN ('form','domain','entity','use','state')),
          label TEXT NOT NULL,
          evidence_code TEXT NOT NULL,
          evidence_excerpt TEXT,
          source_run_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending','approved','merged','rejected')),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(facet,label,status)
        );

        CREATE TABLE file_tag_assignments (
          file_key TEXT NOT NULL REFERENCES file_identities(file_key) ON DELETE CASCADE,
          tag_id TEXT NOT NULL,
          facet TEXT NOT NULL CHECK(facet IN ('form','domain','entity','use','state')),
          label TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('user','tag_forge_auto','tag_forge_explicit','import')),
          ownership TEXT NOT NULL CHECK(ownership IN ('manual','automatic')),
          suppressed INTEGER NOT NULL DEFAULT 0,
          lexicon_version TEXT,
          evidence_code TEXT,
          confidence REAL,
          validated_at INTEGER,
          written_at INTEGER,
          readback_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(file_key,tag_id)
        );
        CREATE INDEX idx_file_tag_assignment_label ON file_tag_assignments(facet,label,suppressed);

        CREATE TABLE artifact_creation_receipts (
          receipt_id TEXT PRIMARY KEY,
          source_run_id TEXT NOT NULL,
          file_key TEXT NOT NULL REFERENCES file_identities(file_key) ON DELETE CASCADE,
          created_in_this_run INTEGER NOT NULL CHECK(created_in_this_run=1),
          created_at INTEGER NOT NULL,
          final_save_hash TEXT,
          final_saved_at INTEGER,
          enrichment_status TEXT NOT NULL CHECK(enrichment_status IN ('awaiting_final_save','pending','completed','completed_sparse','failed_retryable','failed_terminal')),
          retry_error_code TEXT,
          updated_at INTEGER NOT NULL,
          UNIQUE(source_run_id,file_key)
        );
        CREATE INDEX idx_artifact_receipt_enrichment ON artifact_creation_receipts(enrichment_status,updated_at);
      `)
    }
  },
  {
    name: '071_file_emergence_feedback_and_evaluation',
    up: (db) => {
      db.exec(`
        CREATE TABLE file_emergence_feedback (
          feedback_id TEXT PRIMARY KEY,
          project_key TEXT NOT NULL REFERENCES project_identities(project_key) ON DELETE CASCADE,
          action TEXT NOT NULL CHECK(action IN ('rename','not_related','snooze','hide','restore')),
          evidence_cutoff INTEGER,
          snooze_until INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_file_emergence_feedback_project
          ON file_emergence_feedback(project_key, created_at DESC);
        ALTER TABLE file_emergence_prediction_snapshots ADD COLUMN rank INTEGER;
        ALTER TABLE file_emergence_prediction_snapshots ADD COLUMN score REAL;
      `)
    }
  },
  {
    name: '072_file_emergence_snapshot_diagnostics',
    up: (db) => {
      db.exec(`
        ALTER TABLE file_emergence_prediction_snapshots ADD COLUMN machine_name INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE file_emergence_prediction_snapshots ADD COLUMN file_keys_json TEXT NOT NULL DEFAULT '[]';
        CREATE TABLE file_emergence_snapshot_generations (
          snapshot_id TEXT PRIMARY KEY,
          root_scope_hash TEXT NOT NULL,
          generated_at INTEGER NOT NULL,
          visible_count INTEGER NOT NULL,
          machine_name_count INTEGER NOT NULL,
          rejection_reasons_json TEXT NOT NULL
        );
        CREATE INDEX idx_file_emergence_generation_scope_time
          ON file_emergence_snapshot_generations(root_scope_hash, generated_at);
      `)
    }
  },
  {
    name: '073_agent_scheduled_tasks',
    up: (db) => {
      db.exec(`
        CREATE TABLE scheduled_tasks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          instruction TEXT NOT NULL,
          schedule_spec_version INTEGER NOT NULL DEFAULT 1 CHECK(schedule_spec_version = 1),
          schedule_spec_json TEXT NOT NULL,
          timezone TEXT NOT NULL,
          scope_id TEXT,
          scope_mode TEXT NOT NULL DEFAULT 'existing' CHECK(scope_mode IN ('dedicated', 'existing')),
          agent_id TEXT NOT NULL,
          workspace_roots_json TEXT NOT NULL DEFAULT '[]',
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          next_run_at TEXT,
          last_occurrence_at TEXT,
          missed_policy TEXT NOT NULL DEFAULT 'coalesce_latest'
            CHECK(missed_policy IN ('coalesce_latest', 'skip')),
          migration_state TEXT CHECK(migration_state IN ('needs_scope', 'needs_schedule_review')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX idx_scheduled_tasks_enabled_next
          ON scheduled_tasks(enabled, next_run_at)
          WHERE deleted_at IS NULL;
        CREATE INDEX idx_scheduled_tasks_updated
          ON scheduled_tasks(updated_at DESC);

        CREATE TABLE agent_schedule_occurrences (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE RESTRICT,
          scheduled_for TEXT NOT NULL,
          triggered_at TEXT NOT NULL,
          trigger_source TEXT NOT NULL
            CHECK(trigger_source IN ('timer', 'startup', 'resume', 'manual')),
          trigger_source_key TEXT NOT NULL,
          claim_status TEXT NOT NULL
            CHECK(claim_status IN (
              'queued', 'dispatching', 'dispatched', 'dispatch_failed',
              'skipped_missed', 'skipped_coalesced', 'blocked_target'
            )),
          attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
          run_id TEXT,
          task_id TEXT,
          delay_ms INTEGER NOT NULL DEFAULT 0 CHECK(delay_ms >= 0),
          started_at TEXT,
          finished_at TEXT,
          error_kind TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(schedule_id, scheduled_for, trigger_source_key)
        );
        CREATE INDEX idx_agent_schedule_occurrences_recovery
          ON agent_schedule_occurrences(claim_status, scheduled_for);
        CREATE INDEX idx_agent_schedule_occurrences_schedule_history
          ON agent_schedule_occurrences(schedule_id, created_at DESC);
      `)

      const legacyRows = db.prepare('SELECT * FROM agent_schedules').all<LegacyAgentScheduleRow>()
      const insert = db.prepare(`
        INSERT INTO scheduled_tasks (
          id, name, instruction, schedule_spec_version, schedule_spec_json,
          timezone, scope_id, scope_mode, agent_id, workspace_roots_json, enabled,
          next_run_at, last_occurrence_at, missed_policy, migration_state,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, 1, ?, 'UTC', ?, 'existing', ?, ?, ?, ?, ?, 'coalesce_latest', ?, ?, ?, NULL)
      `)
      for (const row of legacyRows) {
        const payload = parseLegacySchedulePayload(row.payload_json)
        const scopeId = readLegacyText(payload, 'scopeId', 'conversationId')
        const agentId = readLegacyText(payload, 'agent', 'agentId') || 'butler'
        const roots = Array.isArray(payload.workspaceRoots)
          ? payload.workspaceRoots.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
          : []
        if (roots.length === 0) {
          const singleRoot = readLegacyText(payload, 'workspaceRoot', 'workspaceId')
          if (singleRoot) roots.push(singleRoot)
        }
        const scheduleSpec = convertLegacyCron(row.cron_expr)
        const migrationState = !scopeId
          ? 'needs_scope'
          : scheduleSpec
            ? null
            : 'needs_schedule_review'
        const enabled = Boolean(row.enabled) && migrationState === null
        insert.run(
          row.id,
          row.name,
          row.prompt,
          JSON.stringify(scheduleSpec || {}),
          scopeId,
          agentId,
          JSON.stringify(roots),
          enabled ? 1 : 0,
          enabled ? row.next_run_at : null,
          row.last_run_at,
          migrationState,
          row.created_at,
          row.updated_at,
        )
      }
      db.exec('DROP TABLE agent_schedules')
    }
  },
  {
    name: '074_tag_forge_scoped_review_proposals',
    up: (db) => {
      db.exec(`
        ALTER TABLE tag_pending_proposals RENAME TO tag_pending_proposals_legacy;

        CREATE TABLE tag_pending_proposals (
          proposal_id TEXT PRIMARY KEY,
          facet TEXT NOT NULL CHECK(facet IN ('form','domain','entity','use','state')),
          label TEXT NOT NULL,
          evidence_code TEXT NOT NULL,
          evidence_excerpt TEXT,
          source_run_id TEXT,
          batch_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          scope_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending','approved','merged','rejected','dismissed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(batch_id,item_id,facet,label,status)
        );

        INSERT INTO tag_pending_proposals (
          proposal_id,facet,label,evidence_code,evidence_excerpt,source_run_id,
          batch_id,item_id,scope_id,status,created_at,updated_at
        )
        SELECT
          proposal_id,facet,label,evidence_code,evidence_excerpt,source_run_id,
          COALESCE(source_run_id,'legacy'),proposal_id,NULL,status,created_at,updated_at
        FROM tag_pending_proposals_legacy;

        DROP TABLE tag_pending_proposals_legacy;
        CREATE INDEX idx_tag_pending_review_scope
          ON tag_pending_proposals(batch_id,item_id,status,created_at);
      `)
    }
  },
  {
    name: '075_tag_forge_durable_creation_validation',
    up: (db) => {
      db.exec(`
        ALTER TABLE artifact_creation_receipts ADD COLUMN validation_json TEXT;
        UPDATE artifact_creation_receipts
        SET enrichment_status='failed_retryable',retry_error_code='legacy_sparse_result',updated_at=strftime('%s','now')*1000
        WHERE enrichment_status='completed_sparse';
      `)
    }
  },
  {
    name: '076_canonicalize_rss_item_identity',
    up: (db) => migrateCanonicalRSSItemIdentities(db)
  },
  {
    name: '077_repair_false_failed_direct_answers',
    up: (db) => {
      migrateFalseFailedDirectAnswers(db)
    }
  },
  {
    name: '078_backfill_local_conversation_default_user',
    up: (db) => {
      db.exec(`
        UPDATE chat_conversations
        SET user_id = 'default-user'
        WHERE source_kind = 'local'
          AND (user_id IS NULL OR trim(user_id) = '');
      `)
    }
  },
  {
    // 2026-07-17 — Seed the built-in operator (运营) agent. Fresh installs get
    // it via 064's BUILTIN_AGENT_IDS loop; this migration is the idempotent
    // catch-up for databases that already ran 064, and mirrors 064's
    // reserved-slug conflict handling for a pre-existing user agent that
    // happens to occupy the "operator" slug.
    name: '079_seed_operator_agent',
    up: (db) => {
      const builtinId = 'operator'
      const builtin = BUILTIN_AGENT_META[builtinId]
      const now = migrationNowIso()
      const nowMs = migrationNowMs()

      const agentRows = db.prepare(`
        SELECT id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at
        FROM agents
      `).all<MigrationAgentRow>()
      const existingIds = new Set(agentRows.map((row) => row.id))
      const current = agentRows.find((row) => row.id === builtinId)
      let currentPersonality: MigrationPersonalityRow | undefined = db.prepare(`
        SELECT agent_name, display_name, personality_text, meta_json
        FROM agent_personalities
        WHERE agent_name = ?
      `).all<MigrationPersonalityRow>(builtinId)[0]

      const isExactBuiltinSeed = Boolean(
        current
        && current.name === builtin.displayName
        && current.charter === builtin.charter
        && current.persona_ref === builtinId
        && current.status === 'active'
        && !current.parent_agent_id
        && !current.derivation_reason
        && !current.merged_into_agent_id
        && currentPersonality
        && currentPersonality.display_name === builtin.displayName
        && currentPersonality.personality_text === AGENT_IDENTITY_PERSONAS[builtinId]
      )
      const isUserConflict = Boolean(current && !isExactBuiltinSeed)

      if (current && isUserConflict) {
        const reassignedId = nextAvailableAgentSlug(existingIds, current.name, builtinId)
        existingIds.add(reassignedId)
        db.prepare(`
          UPDATE agents
          SET id = ?, status = ?, persona_ref = ?
          WHERE id = ?
        `).run(
          reassignedId,
          normalizeAgentLifecycleStatus(current.status),
          reassignedId,
          builtinId,
        )
        if (reassignPersonalityForReservedSlug(db, builtinId, reassignedId)) {
          currentPersonality = undefined
        }
        db.prepare('UPDATE task_projections SET owner_agent_id = ? WHERE owner_agent_id = ?')
          .run(reassignedId, builtinId)
        db.prepare('UPDATE specialist_content_edit_proposals SET agent_id = ? WHERE agent_id = ?')
          .run(reassignedId, builtinId)
        db.prepare('UPDATE specialist_blueprints SET specialist_id = ? WHERE specialist_id = ?')
          .run(reassignedId, builtinId)
        db.prepare(`
          UPDATE specialist_blueprints
          SET content_json = replace(
            replace(
              replace(content_json, ?, ?),
              ?, ?
            ),
            ?, ?
          )
        `).run(
          `"specialistId":"${builtinId}"`,
          `"specialistId":"${reassignedId}"`,
          `"createdAgentId":"${builtinId}"`,
          `"createdAgentId":"${reassignedId}"`,
          `"targetAgentId":"${builtinId}"`,
          `"targetAgentId":"${reassignedId}"`,
        )
        db.prepare(`
          INSERT OR IGNORE INTO agent_identity_migration (
            id, kind, old_agent_id, new_agent_id, details_json, asset_reconciled_at, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?)
        `).run(
          `reassign-${builtinId}-${reassignedId}`,
          'reserved_slug_reassigned',
          builtinId,
          reassignedId,
          JSON.stringify({
            oldName: current.name,
            oldStatus: current.status,
            parentAgentId: current.parent_agent_id ?? null,
            derivationReason: current.derivation_reason ?? null,
          }),
          now,
        )
      }

      if (!currentPersonality) {
        db.prepare(`
          INSERT INTO agent_personalities (
            id, agent_name, display_name, personality_text, tone, meta_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `default-persona-${builtinId}`,
          builtinId,
          builtin.displayName,
          AGENT_IDENTITY_PERSONAS[builtinId],
          null,
          JSON.stringify({ emoji: builtin.emoji }),
          nowMs,
          nowMs,
        )
      } else {
        // Exact built-in seed: refresh display metadata without rewriting the
        // already-canonical personality text.
        db.prepare(`
          UPDATE agent_personalities
          SET display_name = ?, meta_json = ?, updated_at = ?
          WHERE agent_name = ?
        `).run(
          builtin.displayName,
          JSON.stringify({ emoji: builtin.emoji }),
          nowMs,
          builtinId,
        )
      }

      db.prepare(`
        INSERT INTO agents (id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at)
        VALUES (?, ?, ?, ?, 'active', NULL, NULL, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          charter = COALESCE(agents.charter, excluded.charter),
          persona_ref = excluded.persona_ref,
          status = 'active'
      `).run(
        builtinId,
        builtin.displayName,
        builtin.charter,
        builtinId,
        now,
      )
    }
  },
  {
    // 2026-07-17 — Forward repair for databases that applied the historical
    // 064 migration before reserved-slug personality reassignment was fixed.
    // Only the unambiguous old shape is touched: the renamed user agent still
    // has 064's exact generated placeholder while its custom text remains on
    // the built-in slug. Ambiguous/user-edited states are left unchanged.
    name: '080_repair_reserved_slug_personality_binding',
    up: (db) => {
      type LedgerRow = {
        old_agent_id: string | null
        new_agent_id: string | null
      }
      type RepairPersonalityRow = {
        id: string
        agent_name: string
        display_name: string | null
        personality_text: string
        tone: string | null
        meta_json: string | null
      }

      const ledgers = db.prepare(`
        SELECT old_agent_id, new_agent_id
        FROM agent_identity_migration
        WHERE kind = 'reserved_slug_reassigned'
        ORDER BY created_at ASC, id ASC
      `).all<LedgerRow>()
      const nowMs = migrationNowMs()

      for (const ledger of ledgers) {
        const oldAgentId = String(ledger.old_agent_id || '')
        const newAgentId = String(ledger.new_agent_id || '')
        if (!oldAgentId || !newAgentId || oldAgentId === 'butler') continue
        if (!isReservedAgentSlug(oldAgentId)) continue
        const builtin = BUILTIN_AGENT_META[oldAgentId as BuiltinAgentId]
        if (!builtin) continue

        const oldAgent = db.prepare(`
          SELECT id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at
          FROM agents WHERE id = ?
        `).all<MigrationAgentRow>(oldAgentId)[0]
        const newAgent = db.prepare(`
          SELECT id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at
          FROM agents WHERE id = ?
        `).all<MigrationAgentRow>(newAgentId)[0]
        if (!oldAgent || !newAgent) continue

        const oldPersonality = db.prepare(`
          SELECT id, agent_name, display_name, personality_text, tone, meta_json
          FROM agent_personalities WHERE agent_name = ?
        `).all<RepairPersonalityRow>(oldAgentId)[0]
        const newPersonality = db.prepare(`
          SELECT id, agent_name, display_name, personality_text, tone, meta_json
          FROM agent_personalities WHERE agent_name = ?
        `).all<RepairPersonalityRow>(newAgentId)[0]
        if (!oldPersonality || !newPersonality) continue

        const generatedPlaceholder = generatedPersonalityText(
          newAgentId,
          newAgent.name,
          newAgent.charter,
        )
        const newIsExactPlaceholder =
          newPersonality.id === `personality-${newAgentId}`
          && newPersonality.personality_text === generatedPlaceholder
        const oldIsKnownBuiltin =
          oldPersonality.personality_text === AGENT_IDENTITY_PERSONAS[oldAgentId as BuiltinAgentId]
          || oldPersonality.personality_text === DEFAULT_AGENT_PERSONAS[oldAgentId as BuiltinAgentId]
        if (!newIsExactPlaceholder || oldIsKnownBuiltin) continue

        db.prepare('DELETE FROM agent_personalities WHERE id = ?').run(newPersonality.id)
        const recoveredId = nextAvailablePersonalityId(db, `personality-${newAgentId}`)
        db.prepare(`
          UPDATE agent_personalities
          SET id = ?, agent_name = ?, display_name = ?, meta_json = ?, updated_at = ?
          WHERE id = ?
        `).run(
          recoveredId,
          newAgentId,
          newAgent.name,
          JSON.stringify({ emoji: '🤖' }),
          nowMs,
          oldPersonality.id,
        )

        const builtinPersonalityId = nextAvailablePersonalityId(
          db,
          `default-persona-${oldAgentId}`,
        )
        db.prepare(`
          INSERT INTO agent_personalities (
            id, agent_name, display_name, personality_text, tone, meta_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
        `).run(
          builtinPersonalityId,
          oldAgentId,
          builtin.displayName,
          AGENT_IDENTITY_PERSONAS[oldAgentId as BuiltinAgentId],
          JSON.stringify({ emoji: builtin.emoji }),
          nowMs,
          nowMs,
        )
        db.prepare('UPDATE agents SET persona_ref = ? WHERE id = ?').run(newAgentId, newAgentId)
        db.prepare('UPDATE agents SET persona_ref = ? WHERE id = ?').run(oldAgentId, oldAgentId)
      }
    },
  },
  {
    name: '081_browser_power_preflight_audit',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_power_preflight_audit (
          id TEXT PRIMARY KEY,
          tool_name TEXT NOT NULL,
          grant_id TEXT NOT NULL,
          confirmation_source TEXT NOT NULL,
          scope_id TEXT,
          tab_id TEXT,
          document_key_hash TEXT NOT NULL,
          url TEXT,
          object_ref TEXT,
          effects_json TEXT NOT NULL,
          purpose TEXT,
          input_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_browser_power_preflight_scope
          ON browser_power_preflight_audit(scope_id, created_at DESC);
      `)
    },
  },
  {
    name: '082_browser_task_execution_identity',
    up: (db) => {
      db.exec(`
        ALTER TABLE browser_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE browser_tasks ADD COLUMN created_by_run_id TEXT;
        ALTER TABLE browser_tasks ADD COLUMN active_execution_binding_json TEXT;
        ALTER TABLE browser_tasks ADD COLUMN parent_task_id TEXT;
        ALTER TABLE browser_tasks ADD COLUMN projection_revision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE browser_tasks ADD COLUMN projection_sync_json TEXT;
        CREATE INDEX IF NOT EXISTS idx_browser_tasks_projection_revision
          ON browser_tasks(projection_revision, revision, updated_at DESC);
      `)
    },
  },
  {
    name: '083_agent_browser_control_plane',
    up: (db) => {
      const duplicateBrowserWorkflowParents = db.prepare(`
        SELECT parent_task_id, COUNT(*) AS child_count
          FROM browser_tasks
         WHERE kind = 'browser_workflow' AND parent_task_id IS NOT NULL
         GROUP BY parent_task_id
        HAVING COUNT(*) > 1
      `).all<{ parent_task_id: string; child_count: number }>()
      if (duplicateBrowserWorkflowParents.length > 0) {
        throw new Error(
          `083_agent_browser_control_plane: duplicate browser_workflow children require explicit repair (${duplicateBrowserWorkflowParents
            .map((row) => `${row.parent_task_id}:${row.child_count}`)
            .join(',')})`,
        )
      }
      db.exec(`
        ALTER TABLE task_projections ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE task_projections ADD COLUMN dependency_generation INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE task_projections ADD COLUMN request_anchor_json TEXT;
        ALTER TABLE task_projections ADD COLUMN goal_mutations_json TEXT;
        ALTER TABLE task_projections ADD COLUMN steering_receipts_json TEXT;
        ALTER TABLE task_projections ADD COLUMN human_takeover_ref_json TEXT;
        ALTER TABLE task_projections ADD COLUMN checkpoint_refs_json TEXT NOT NULL DEFAULT '{"cleanBaseCheckpointId":null,"suspensionCheckpointId":null}';

        CREATE TABLE IF NOT EXISTS agent_session_checkpoints (
          checkpoint_id TEXT PRIMARY KEY,
          role TEXT NOT NULL CHECK (role IN ('clean_base', 'suspension')),
          parent_task_id TEXT NOT NULL,
          browser_task_id TEXT,
          owner_run_id TEXT NOT NULL,
          ancestor_owner_run_id TEXT,
          ancestor_checkpoint_digest TEXT,
          schema_major INTEGER NOT NULL,
          serializer_major INTEGER NOT NULL,
          registry_major INTEGER NOT NULL,
          safety_major INTEGER NOT NULL,
          final_input_json TEXT NOT NULL,
          final_input_digest TEXT NOT NULL,
          sdk_source_item_count INTEGER NOT NULL,
          sdk_source_prefix_digest TEXT NOT NULL,
          last_effective_browser_action_seq INTEGER NOT NULL DEFAULT 0,
          steering_receipt_ids_json TEXT NOT NULL,
          steering_receipt_digests_json TEXT NOT NULL,
          required_operation_ids_json TEXT NOT NULL,
          resource_refs_json TEXT NOT NULL,
          prepared_skill_json TEXT NOT NULL,
          activated_capability_groups_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_session_checkpoints_parent
          ON agent_session_checkpoints(parent_task_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_session_checkpoints_owner
          ON agent_session_checkpoints(owner_run_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_tasks_one_workflow_per_parent
          ON browser_tasks(parent_task_id) WHERE kind = 'browser_workflow';

        -- run-finalizer-exempt: migration-083 normalizes legacy working owners into the running workflow state
        UPDATE run_meta SET status = 'running' WHERE status = 'working';
      `)
    },
  },
  {
    name: '084_agent_browser_typed_wake_receipts',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_checkpoint_wake_receipts (
          wake_id TEXT PRIMARY KEY,
          parent_task_id TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          basis_revision INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN (${BROWSER_CHECKPOINT_WAKE_KIND_SQL})),
          source_id TEXT NOT NULL,
          source_digest TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          consumed_by_run_id TEXT,
          consumed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_checkpoint_wake_parent
          ON agent_checkpoint_wake_receipts(parent_task_id, issued_at DESC);
      `)
    },
  },
  {
    name: '085_agent_browser_exhaustive_wake_receipts',
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_agent_checkpoint_wake_parent;
        ALTER TABLE agent_checkpoint_wake_receipts
          RENAME TO agent_checkpoint_wake_receipts_legacy_085;
        CREATE TABLE agent_checkpoint_wake_receipts (
          wake_id TEXT PRIMARY KEY,
          parent_task_id TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          basis_revision INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN (${BROWSER_CHECKPOINT_WAKE_KIND_SQL})),
          source_id TEXT NOT NULL,
          source_digest TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          consumed_by_run_id TEXT,
          consumed_at TEXT
        );
        INSERT INTO agent_checkpoint_wake_receipts (
          wake_id, parent_task_id, checkpoint_id, basis_revision, kind,
          source_id, source_digest, issued_at, consumed_by_run_id, consumed_at
        )
        SELECT wake_id, parent_task_id, checkpoint_id, basis_revision, kind,
               source_id, source_digest, issued_at, consumed_by_run_id, consumed_at
          FROM agent_checkpoint_wake_receipts_legacy_085;
        DROP TABLE agent_checkpoint_wake_receipts_legacy_085;
        CREATE INDEX idx_agent_checkpoint_wake_parent
          ON agent_checkpoint_wake_receipts(parent_task_id, issued_at DESC);
      `)
    },
  },
  {
    name: '086_agent_steering_message_resources',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_steering_message_resources (
          resource_id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          block_type TEXT NOT NULL CHECK (block_type IN ('text', 'image', 'video')),
          media_type TEXT,
          content TEXT NOT NULL,
          content_digest TEXT NOT NULL,
          provenance_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(message_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_steering_resources_message
          ON agent_steering_message_resources(message_id, ordinal);
      `)
    },
  },
  {
    name: '087_browser_target_claims',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_target_claims (
          partition TEXT NOT NULL,
          tab_id TEXT NOT NULL,
          physical_target_token TEXT,
          boot_incarnation_id TEXT,
          claim_id TEXT NOT NULL UNIQUE,
          generation INTEGER NOT NULL,
          profile_id TEXT,
          surface TEXT NOT NULL,
          parent_task_id TEXT NOT NULL,
          browser_task_id TEXT NOT NULL,
          owner_run_id TEXT NOT NULL,
          scope_id TEXT,
          session_id TEXT,
          message_visibility_epoch INTEGER,
          state TEXT NOT NULL,
          suspension_checkpoint_id TEXT,
          suspension_reason TEXT,
          acquired_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (partition, tab_id),
          CHECK (generation >= 1),
          CHECK (surface IN ('user-view', 'agent-view')),
          CHECK (state IN ('held', 'user_owned', 'suspended', 'expired', 'released')),
          CHECK ((physical_target_token IS NULL) = (boot_incarnation_id IS NULL)),
          CHECK (state != 'held' OR physical_target_token IS NOT NULL),
          CHECK (
            (state = 'suspended'
              AND suspension_checkpoint_id IS NOT NULL AND suspension_reason IS NOT NULL)
            OR (state = 'user_owned' AND suspension_reason IS NOT NULL)
            OR (state IN ('held', 'expired', 'released')
              AND suspension_checkpoint_id IS NULL AND suspension_reason IS NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS idx_browser_target_claims_owner
          ON browser_target_claims(owner_run_id, state, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_browser_target_claims_parent
          ON browser_target_claims(parent_task_id, browser_task_id, state, updated_at DESC);

        CREATE TABLE IF NOT EXISTS browser_control_receipts (
          receipt_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL,
          parent_task_id TEXT NOT NULL,
          browser_task_id TEXT NOT NULL,
          owner_run_id TEXT NOT NULL,
          partition TEXT,
          tab_id TEXT,
          physical_target_token TEXT,
          boot_incarnation_id TEXT,
          previous_claim_id TEXT,
          previous_generation INTEGER,
          next_claim_id TEXT,
          next_generation INTEGER,
          clean_base_checkpoint_id TEXT,
          suspension_checkpoint_id TEXT,
          wake_id TEXT,
          successor_run_id TEXT,
          continuation_generation INTEGER,
          idempotency_key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          error_code TEXT,
          recoverable INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_control_receipts_child_sequence
          ON browser_control_receipts(browser_task_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_browser_control_receipts_target
          ON browser_control_receipts(partition, tab_id, sequence);

        INSERT OR IGNORE INTO browser_target_claims (
          partition, tab_id, physical_target_token, boot_incarnation_id,
          claim_id, generation, profile_id, surface,
          parent_task_id, browser_task_id, owner_run_id, scope_id, session_id,
          message_visibility_epoch,
          state, suspension_checkpoint_id, suspension_reason,
          acquired_at, heartbeat_at, expires_at, updated_at
        )
        SELECT
          CASE
            WHEN NULLIF(json_extract(human_takeover_ref_json, '$.physicalTarget.profileId'), '') IS NULL
              THEN 'persist:browser'
            ELSE 'persist:browser-profile-' || lower(json_extract(human_takeover_ref_json, '$.physicalTarget.profileId'))
          END,
          json_extract(human_takeover_ref_json, '$.physicalTarget.tabId'),
          NULL,
          NULL,
          'claim-migrated-' || task_id,
          1,
          NULLIF(json_extract(human_takeover_ref_json, '$.physicalTarget.profileId'), ''),
          json_extract(human_takeover_ref_json, '$.physicalTarget.surface'),
          task_id,
          json_extract(human_takeover_ref_json, '$.browserTaskId'),
          json_extract(human_takeover_ref_json, '$.ownerRunId'),
          scope_id,
          NULLIF(json_extract(human_takeover_ref_json, '$.physicalTarget.sessionId'), ''),
          NULL,
          'user_owned',
          json_extract(checkpoint_refs_json, '$.suspensionCheckpointId'),
          'browser_target_user_owned',
          CAST(strftime('%s','now') AS INTEGER) * 1000,
          CAST(strftime('%s','now') AS INTEGER) * 1000,
          CAST(strftime('%s','now') AS INTEGER) * 1000,
          CAST(strftime('%s','now') AS INTEGER) * 1000
        FROM task_projections
        WHERE human_takeover_ref_json IS NOT NULL
          AND json_extract(human_takeover_ref_json, '$.state') = 'pending'
          AND NULLIF(json_extract(human_takeover_ref_json, '$.physicalTarget.tabId'), '') IS NOT NULL
          AND NULLIF(json_extract(human_takeover_ref_json, '$.physicalTarget.surface'), '') IS NOT NULL
          AND NULLIF(json_extract(human_takeover_ref_json, '$.browserTaskId'), '') IS NOT NULL
          AND NULLIF(json_extract(human_takeover_ref_json, '$.ownerRunId'), '') IS NOT NULL
          AND NULLIF(json_extract(checkpoint_refs_json, '$.suspensionCheckpointId'), '') IS NOT NULL;
      `)
    },
  },
  {
    name: '088_codex_runtime_bindings',
    up: (db) => {
      db.exec(CODEX_BINDING_SCHEMA_SQL)
    },
  },
  {
    name: '089_codex_runtime_evidence_guards',
    up: (db) => {
      db.exec(`
        DROP TRIGGER IF EXISTS codex_fence_parent_update;
        DROP TRIGGER IF EXISTS codex_process_lease_identity_immutable_update;
      `)
      db.exec(CODEX_BINDING_EVIDENCE_GUARDS_SQL)
    },
  },
  {
    name: '090_codex_model_gateway_authority',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ready_model_gateway_profile_snapshots (
          snapshot_ref TEXT PRIMARY KEY,
          snapshot_digest TEXT NOT NULL UNIQUE,
          profile_id TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          credential_reference_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ready_model_gateway_request_receipts (
          receipt_id TEXT PRIMARY KEY,
          request_kind TEXT NOT NULL CHECK (request_kind IN (
            'product', 'automatic_compaction', 'manual_compaction'
          )),
          codex_thread_id TEXT NOT NULL,
          codex_turn_id TEXT NOT NULL,
          ready_run_id TEXT,
          manual_compaction_id TEXT,
          upstream_profile_snapshot_ref TEXT NOT NULL,
          upstream_profile_snapshot_digest TEXT NOT NULL,
          request_digest TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          CHECK ((ready_run_id IS NULL) != (manual_compaction_id IS NULL)),
          CHECK (
            (request_kind IN ('product', 'automatic_compaction')
              AND ready_run_id IS NOT NULL AND manual_compaction_id IS NULL)
            OR
            (request_kind = 'manual_compaction'
              AND ready_run_id IS NULL AND manual_compaction_id IS NOT NULL)
          )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ready_model_gateway_request_identity
          ON ready_model_gateway_request_receipts(
            request_kind, codex_thread_id, codex_turn_id, request_digest
          );

        CREATE TRIGGER IF NOT EXISTS ready_model_gateway_snapshot_immutable_update
        BEFORE UPDATE ON ready_model_gateway_profile_snapshots
        BEGIN SELECT RAISE(ABORT, 'ready_model_gateway_snapshot_immutable'); END;

        CREATE TRIGGER IF NOT EXISTS ready_model_gateway_snapshot_immutable_delete
        BEFORE DELETE ON ready_model_gateway_profile_snapshots
        BEGIN SELECT RAISE(ABORT, 'ready_model_gateway_snapshot_immutable'); END;

        CREATE TRIGGER IF NOT EXISTS ready_model_gateway_receipt_immutable_update
        BEFORE UPDATE ON ready_model_gateway_request_receipts
        BEGIN SELECT RAISE(ABORT, 'ready_model_gateway_receipt_immutable'); END;

        CREATE TRIGGER IF NOT EXISTS ready_model_gateway_receipt_immutable_delete
        BEFORE DELETE ON ready_model_gateway_request_receipts
        BEGIN SELECT RAISE(ABORT, 'ready_model_gateway_receipt_immutable'); END;
      `)
    },
  },
  {
    name: '091_codex_model_gateway_turn_claim',
    up: (db) => {
      applyCodexGatewayTurnClaimMigration(db)
    },
  },
  {
    name: '092_codex_tool_bridge',
    up: (db) => {
      applyCodexToolBridgeMigration(db)
    },
  },
  {
    name: '093_codex_e5_budget_admission',
    up: (db) => {
      applyCodexE5BudgetAdmissionMigration(db)
    },
  },
  {
    name: '094_codex_host_failure_closeout_readback',
    up: (db) => {
      applyCodexHostFailureCloseoutMigration(db)
    },
  },
  {
    name: '095_codex_lifecycle_recovery_evidence',
    up: (db) => {
      applyCodexLifecycleRecoveryEvidenceMigration(db)
    },
  },
  {
    name: '096_codex_fence_owner_transfer',
    up: (db) => {
      applyCodexFenceOwnerTransferMigration(db)
    },
  },
  {
    name: '097_codex_gateway_completion_evidence',
    up: (db) => {
      applyCodexGatewayCompletionEvidenceMigration(db)
    },
  },
  {
    name: '098_codex_manual_compaction_recovery_evidence',
    up: (db) => {
      applyCodexManualCompactionRecoveryEvidenceMigration(db)
    },
  },
  {
    name: '099_codex_thread_resume_evidence',
    up: (db) => {
      applyCodexThreadResumeEvidenceMigration(db)
    },
  },
  {
    name: '100_codex_thread_resume_active_lease',
    up: (db) => {
      applyCodexThreadResumeActiveLeaseMigration(db)
    },
  },
  {
    name: '101_codex_manual_compaction_item_identity',
    up: (db) => {
      applyCodexManualCompactionItemIdentityMigration(db)
    },
  },
  {
    name: '102_codex_startup_owner_handoff',
    up: (db) => {
      applyCodexStartupOwnerHandoffMigration(db)
    },
  },
  {
    name: '103_codex_tool_response_evidence',
    up: (db) => {
      applyCodexToolResponseEvidenceMigration(db)
    },
  },
  {
    name: '104_codex_product_recovery_failure',
    up: (db) => {
      applyCodexProductRecoveryFailureMigration(db)
    },
  },
  {
    name: '105_codex_tool_response_delivery_attempts',
    up: (db) => {
      applyCodexToolResponseDeliveryAttemptMigration(db)
    },
  },
  {
    name: '106_codex_browser_verifier_receipts',
    up: (db) => {
      applyCodexBrowserVerifierReceiptMigration(db)
    },
  },
  {
    name: '107_codex_turn_lifecycle_action',
    up: (db) => {
      applyCodexTurnLifecycleActionMigration(db)
    },
  },
  {
    name: '108_codex_thread_retirement_cleanup',
    up: (db) => {
      applyCodexThreadRetirementCleanupMigration(db)
      const retiredAt = new Date().toISOString()
      const hasScheduledTasks = Boolean(db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_tasks'",
      ).get())
      if (hasScheduledTasks) {
        db.prepare(`UPDATE scheduled_tasks
          SET enabled = 0, next_run_at = NULL, updated_at = ?
          WHERE enabled != 0 OR next_run_at IS NOT NULL`).run(retiredAt)
      }
      const hasScheduledOccurrences = Boolean(db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_schedule_occurrences'",
      ).get())
      if (hasScheduledOccurrences) {
        db.prepare(`UPDATE agent_schedule_occurrences
          SET claim_status = 'dispatch_failed',
              finished_at = COALESCE(finished_at, ?),
              error_kind = 'feature_retired',
              error_message = 'Agent scheduled tasks were retired before Codex production release',
              updated_at = ?
          WHERE claim_status IN ('queued', 'dispatching')`).run(retiredAt, retiredAt)
      }
    },
  },
  {
    name: '109_browser_target_claim_user_takeover',
    up: (db) => {
      applyBrowserTargetClaimUserTakeoverMigration(db)
    },
  },
  {
    name: '110_codex_tool_request_rpc_binding',
    up: (db) => {
      applyCodexToolRequestRpcBindingMigration(db)
    },
  },
  {
    name: '111_codex_gateway_budget_lanes',
    up: (db) => {
      db.exec(`
        ALTER TABLE ready_model_gateway_request_receipts
          ADD COLUMN budget_lane TEXT
          CHECK (budget_lane IS NULL OR budget_lane IN ('ordinary', 'delivery', 'final'));
      `)
    },
  },
  {
    name: '112_single_ready_identity_cleanup',
    up: (db) => {
      const retiredAt = new Date().toISOString()
      const retirementEvidenceDigest = '147e8851fb553ff667f00e73843b54e4e49488214a76c7704b64d6a0bf6f1c59'

      retireAllCodexThreadBindingsForConversationReset(db, {
        retiredAt,
        retirementEvidenceDigest,
      })
      enqueueEligibleRetiredCodexThreadArchiveIntents(db)

      dropCodexConversationClosedDeleteGuards(db)
      db.exec(`
        UPDATE agent_channel_threads
        SET conversation_id = NULL;

        DELETE FROM chat_messages_fts;
        DELETE FROM session_recall_attachment_index;
        DELETE FROM session_recall_vectors;
        DELETE FROM session_recall_metadata;
        DELETE FROM chat_messages;
        DELETE FROM chat_conversations;

        DELETE FROM specialist_blueprint_confirmations;
        DELETE FROM specialist_blueprints;
        DELETE FROM specialist_content_edit_proposals;
        DELETE FROM agent_personalities WHERE agent_name <> 'butler';
        DELETE FROM agent_knowledge WHERE agent_name NOT IN ('butler', 'system');
        DELETE FROM agents WHERE id <> 'butler';

        UPDATE agents
        SET name = 'Ready',
            status = 'active',
            parent_agent_id = NULL,
            derivation_reason = NULL,
            merged_into_agent_id = NULL
        WHERE id = 'butler';
      `)
      applyCodexConversationClosedDeleteGuards(db)
    },
  },
  {
    name: '113_ready_memory_truth',
    up: (db) => {
      applyReadyMemoryMigration(db)
    },
  },
  {
    name: '114_drop_retired_memory_truth',
    up: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS agent_trigger_refs;
        DROP TABLE IF EXISTS agent_memory_access_log;
        DROP TABLE IF EXISTS agent_triggers;
        DROP TABLE IF EXISTS agent_memory_metadata;
        DROP TABLE IF EXISTS agent_knowledge;
        DROP TABLE IF EXISTS user_profiles;
        DROP TABLE IF EXISTS agent_personalities;
      `)
    },
  },
  {
    name: '115_interrupt_retired_execution_scopes',
    up: (db) => {
      const hasLegacyExecutionScopes = Boolean(db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_call_scopes'",
      ).get())
      if (!hasLegacyExecutionScopes) return
      db.prepare(`
        UPDATE execution_call_scopes
           SET status = 'interrupted', updated_at = ?
         WHERE status IN ('prepared', 'running', 'checkpointed')
      `).run(Date.now())
    },
  },
  {
    name: '116_pet_activity_read_marker',
    up: (db) => {
      db.exec(`
        ALTER TABLE chat_conversations
          ADD COLUMN pet_last_seen_assistant_message_id TEXT;
        ALTER TABLE chat_conversations
          ADD COLUMN pet_last_seen_at TEXT;
      `)
    },
  },
  {
    name: '117_pet_activity_attention_cutover',
    up: (db) => {
      const cutoverAt = new Date().toISOString()
      db.prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('desktop_pet_activity_cutover_at', ?, ?)
      `).run(cutoverAt, cutoverAt)
    },
  },
  {
    name: '118_codex_native_continuity_terminal_head_v3',
    up: (db) => {
      applyCodexGatewayCompletionEvidenceMigration(db)
      const addColumn = (table: string, name: string, sql: string): void => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
        if (!columns.some((column) => column.name === name)) db.exec(sql)
      }
      addColumn(
        'codex_thread_bindings',
        'action_projection_sequence',
        'ALTER TABLE codex_thread_bindings ADD COLUMN action_projection_sequence INTEGER NOT NULL DEFAULT 0 CHECK (action_projection_sequence >= 0)',
      )
      addColumn(
        'codex_thread_bindings',
        'thread_materialization_kind',
        "ALTER TABLE codex_thread_bindings ADD COLUMN thread_materialization_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (thread_materialization_kind IN ('legacy', 'fresh_start', 'native_fork', 'fresh_root_with_tail'))",
      )
      addColumn('codex_thread_bindings', 'history_source_thread_binding_id', 'ALTER TABLE codex_thread_bindings ADD COLUMN history_source_thread_binding_id TEXT')
      addColumn('codex_thread_bindings', 'history_source_terminal_facts_digest', 'ALTER TABLE codex_thread_bindings ADD COLUMN history_source_terminal_facts_digest TEXT')
      addColumn('codex_thread_bindings', 'fork_accepted_through_codex_turn_id', 'ALTER TABLE codex_thread_bindings ADD COLUMN fork_accepted_through_codex_turn_id TEXT')
      addColumn('codex_thread_bindings', 'fork_expected_prefix_turn_ids_json', 'ALTER TABLE codex_thread_bindings ADD COLUMN fork_expected_prefix_turn_ids_json TEXT')
      addColumn('codex_thread_bindings', 'fork_expected_prefix_turn_ids_digest', 'ALTER TABLE codex_thread_bindings ADD COLUMN fork_expected_prefix_turn_ids_digest TEXT')
      addColumn('codex_thread_bindings', 'materialization_request_digest', 'ALTER TABLE codex_thread_bindings ADD COLUMN materialization_request_digest TEXT')
      addColumn('codex_thread_bindings', 'thread_start_request_digest', 'ALTER TABLE codex_thread_bindings ADD COLUMN thread_start_request_digest TEXT')
      addColumn('codex_thread_bindings', 'accepted_product_boundary_ready_run_id', 'ALTER TABLE codex_thread_bindings ADD COLUMN accepted_product_boundary_ready_run_id TEXT')
      addColumn('codex_thread_bindings', 'native_inherited_contract_digest', 'ALTER TABLE codex_thread_bindings ADD COLUMN native_inherited_contract_digest TEXT')
      addColumn('codex_thread_bindings', 'source_accepted_native_coverage_receipt_id', 'ALTER TABLE codex_thread_bindings ADD COLUMN source_accepted_native_coverage_receipt_id TEXT')
      addColumn('codex_thread_bindings', 'source_accepted_native_coverage_receipt_digest', 'ALTER TABLE codex_thread_bindings ADD COLUMN source_accepted_native_coverage_receipt_digest TEXT')
      addColumn(
        'codex_thread_bindings',
        'materialization_state',
        "ALTER TABLE codex_thread_bindings ADD COLUMN materialization_state TEXT NOT NULL DEFAULT 'confirmed' CHECK (materialization_state IN ('pending', 'confirmed', 'unknown', 'proven_absent', 'abandoned'))",
      )
      addColumn('codex_thread_bindings', 'materialization_effective_receipt_json', 'ALTER TABLE codex_thread_bindings ADD COLUMN materialization_effective_receipt_json TEXT')
      addColumn('codex_thread_bindings', 'materialization_effective_receipt_digest', 'ALTER TABLE codex_thread_bindings ADD COLUMN materialization_effective_receipt_digest TEXT')
      addColumn('codex_thread_bindings', 'materialization_evidence_digest', 'ALTER TABLE codex_thread_bindings ADD COLUMN materialization_evidence_digest TEXT')
      addColumn('codex_thread_bindings', 'history_seed_digest', 'ALTER TABLE codex_thread_bindings ADD COLUMN history_seed_digest TEXT')
      addColumn('codex_thread_bindings', 'uncommitted_user_tail_json', 'ALTER TABLE codex_thread_bindings ADD COLUMN uncommitted_user_tail_json TEXT')
      addColumn('codex_thread_bindings', 'uncommitted_user_tail_digest', 'ALTER TABLE codex_thread_bindings ADD COLUMN uncommitted_user_tail_digest TEXT')
      addColumn(
        'codex_turn_bindings',
        'terminal_native_readback_receipt_json',
        'ALTER TABLE codex_turn_bindings ADD COLUMN terminal_native_readback_receipt_json TEXT',
      )
      addColumn('codex_turn_bindings', 'turn_start_request_digest', 'ALTER TABLE codex_turn_bindings ADD COLUMN turn_start_request_digest TEXT')
      addColumn(
        'codex_turn_bindings',
        'terminal_native_readback_receipt_digest',
        'ALTER TABLE codex_turn_bindings ADD COLUMN terminal_native_readback_receipt_digest TEXT',
      )
      addColumn(
        'codex_turn_bindings',
        'terminal_native_readback_revision',
        'ALTER TABLE codex_turn_bindings ADD COLUMN terminal_native_readback_revision INTEGER',
      )
      addColumn(
        'codex_turn_bindings',
        'terminal_facts_json',
        'ALTER TABLE codex_turn_bindings ADD COLUMN terminal_facts_json TEXT',
      )
      addColumn(
        'codex_turn_bindings',
        'terminal_facts_digest',
        'ALTER TABLE codex_turn_bindings ADD COLUMN terminal_facts_digest TEXT',
      )
      addColumn(
        'codex_turn_bindings',
        'effect_authority_closed_at',
        'ALTER TABLE codex_turn_bindings ADD COLUMN effect_authority_closed_at TEXT',
      )
      addColumn('codex_turn_bindings', 'accepted_native_coverage_receipt_id', 'ALTER TABLE codex_turn_bindings ADD COLUMN accepted_native_coverage_receipt_id TEXT')
      addColumn('codex_turn_bindings', 'accepted_native_coverage_receipt_digest', 'ALTER TABLE codex_turn_bindings ADD COLUMN accepted_native_coverage_receipt_digest TEXT')
      addColumn('codex_manual_compaction_bindings', 'accepted_native_coverage_receipt_id', 'ALTER TABLE codex_manual_compaction_bindings ADD COLUMN accepted_native_coverage_receipt_id TEXT')
      addColumn('codex_manual_compaction_bindings', 'accepted_native_coverage_receipt_digest', 'ALTER TABLE codex_manual_compaction_bindings ADD COLUMN accepted_native_coverage_receipt_digest TEXT')
      db.exec(CODEX_PRODUCT_EFFECT_BINDING_SCHEMA_SQL)
      db.exec(CODEX_NATIVE_COVERAGE_SCHEMA_SQL)
      applyCodexPristineContractRefreshMigration(db)
      db.exec(CODEX_NATIVE_CONTINUITY_GUARDS_SQL)
    },
  },
  {
    name: '119_gateway_exchange_redaction_admission_guard',
    up: (db) => {
      db.exec(CODEX_GATEWAY_EXCHANGE_GUARDS_SQL)
    },
  },
  {
    name: '120_codex_conversation_context_boundaries',
    up: (db) => {
      applyCodexConversationContextBoundaryMigration(db)
    },
  },
  {
    name: '121_codex_begin_new_context_archive_source',
    up: (db) => {
      applyCodexBeginNewContextArchiveSourceMigration(db)
    },
  },
  {
    name: '122_codex_pristine_legacy_root_refresh',
    up: (db) => {
      if (!db.prepare('PRAGMA table_info(codex_conversation_context_boundaries)').all<{ name: string }>()
        .some((column) => column.name === 'preserved_context_json')) {
        db.exec('ALTER TABLE codex_conversation_context_boundaries ADD COLUMN preserved_context_json TEXT')
      }
      db.exec(`DROP TRIGGER IF EXISTS codex_pristine_contract_refresh_update;
        ${CODEX_PRISTINE_CONTRACT_REFRESH_GUARDS_SQL}`)
    },
  },
  {
    name: '123_remote_channel_durable_inbox',
    up: (db) => {
      db.exec('ALTER TABLE agent_channel_events ADD COLUMN payload_json TEXT')
    },
  },
  { name: RSS_CONTENT_MIGRATION, up: migrateRSSContent },
  { name: RSS_ORGANIZATION_MIGRATION, up: migrateRSSOrganization },
  { name: RSS_PROCESSING_MIGRATION, up: migrateRSSProcessing },
  { name: RSS_EVENT_MIGRATION, up: migrateRSSEvents },
  { name: RSS_RESULT_MIGRATION, up: migrateRSSResults },
  { name: RSS_DIGEST_MIGRATION, up: migrateRSSDigests },
  { name: RSS_CATALOG_MIGRATION, up: migrateRSSCatalog },
  { name: RSS_METHOD_VALIDITY_MIGRATION, up: migrateRSSMethodValidity },
  { name: RSS_TRANSLATION_MIGRATION, up: migrateRSSTranslations },
  { name: CALENDAR_UNION_MIGRATION, up: migrateCalendarUnion },
  {
    name: '134_fastcard_items',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fastcard_items (
          id TEXT PRIMARY KEY NOT NULL,
          payload_json TEXT NOT NULL,
          position INTEGER NOT NULL UNIQUE
        );
      `)
    },
  },
  { name: '135_search_ready_refs', up: migrateSearchReadyRefs },
  {
    name: '136_library_reading',
    up: (db) => {
      db.exec(`
        CREATE TABLE library_reading (
          book_id TEXT PRIMARY KEY NOT NULL,
          position_json TEXT,
          bookmarks_json TEXT NOT NULL DEFAULT '[]'
        );
      `)
    },
  },
  {
    name: '137_library_source_jobs',
    up: (db) => {
      db.exec(`CREATE TABLE library_source_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('zlib','treasure','ctfile')),
        ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','downloading','captcha','extracting','done','failed','cancelled')),
        progress REAL NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
        error TEXT, book_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`)
    },
  },
  { name: OBJECT_MIGRATION, up: migrateObjects },
  { name: '139_object_links', up: (db) => {
    migrateObjectLinks(db)
  } },
]

/**
 * Run all pending migrations against the given database connection.
 *
 * Safe to call multiple times -- already-applied migrations are skipped.
 * Each migration is wrapped in its own transaction.
 */
/**
 * Stage Q (Stage 11) — list all migration names. Test-only helper used
 * by `migration-033-invariant.test.ts` to mark migrations 001-032 as
 * applied in a fresh in-memory DB so only 033 runs. Production code
 * MUST NOT call this — schema reasoning belongs in the migration
 * definitions.
 */
export function __getMigrationNamesForTests(): string[] {
  return migrations.map((m) => m.name)
}

export function __runMigrationForTests(name: string, db: MigrationDatabase): void {
  const migration = migrations.find((item) => item.name === name)
  if (!migration) {
    throw new Error(`Migration not found: ${name}`)
  }
  migration.up(db)
}

export function runMigrations(db: MigrationDatabase): void {
  // Ensure the migrations tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `)

  // Determine which migrations have already been applied
  const applied = db.prepare('SELECT name FROM migrations').all<{ name: string }>()
  const appliedNames = new Set(applied.map((row) => row.name))

  for (const migration of migrations) {
    if (appliedNames.has(migration.name)) {
      continue
    }

    const foreignKeysBefore = ['109_browser_target_claim_user_takeover',
      '118_codex_native_continuity_terminal_head_v3', OBJECT_MIGRATION].includes(migration.name)
      ? Number(db.prepare('PRAGMA foreign_keys').get<{ foreign_keys: number }>()?.foreign_keys || 0)
      : 0
    if (foreignKeysBefore) db.exec('PRAGMA foreign_keys = OFF')
    let began = false
    try {
      // Wrap each migration in a transaction for atomicity. BEGIN belongs
      // inside the restoration scope because table-rebuild migrations temporarily
      // disable foreign keys before opening their transaction.
      db.exec('BEGIN')
      began = true
      migration.up(db)

      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
        migration.name,
        new Date().toISOString()
      )

      db.exec('COMMIT')
      began = false
      console.log(`[migrations] applied: ${migration.name}`)
    } catch (error) {
      if (began) {
        try {
          db.exec('ROLLBACK')
        } catch (rollbackError) {
          console.error(`[migrations] rollback failed: ${migration.name}`, rollbackError)
        }
      }
      console.error(`[migrations] failed: ${migration.name}`, error)
      throw error
    } finally {
      if (foreignKeysBefore) db.exec('PRAGMA foreign_keys = ON')
    }
  }
}
