/**
 * Database migration system for Ready V5.
 *
 * Migrations are applied in order and tracked in the `migrations` table.
 * Each migration is wrapped in a transaction so a failure rolls back cleanly.
 * All schema DDL uses CREATE TABLE/INDEX IF NOT EXISTS for safety against
 * partially-migrated databases.
 */

// Minimal interface compatible with DatabaseConnection from database.ts.
// Defined locally to avoid circular imports.
interface MigrationDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all<T = unknown>(...params: unknown[]): T[]
  }
}

interface Migration {
  name: string
  up: (db: MigrationDatabase) => void
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
      db.exec('CREATE INDEX IF NOT EXISTS idx_history_visited_at ON browser_history(visited_at DESC)')
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
      const cols = db.prepare("PRAGMA table_info(rss_sources)").all<{ name: string }>()
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
      db.exec('CREATE INDEX IF NOT EXISTS idx_skills_jobs_created_at ON skills_jobs(created_at DESC)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_skills_jobs_skill ON skills_jobs(skill_id, created_at DESC)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_skills_jobs_status ON skills_jobs(status, created_at DESC)')

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
      db.exec('CREATE INDEX IF NOT EXISTS idx_skills_schedules_next_run ON skills_schedules(enabled, next_run_at)')
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
          finished_at TEXT,
          FOREIGN KEY (item_id) REFERENCES rss_items(id) ON DELETE CASCADE
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
      const conversationColumns = db.prepare('PRAGMA table_info(chat_conversations)').all<{ name: string }>()
      const hasConversationColumn = (name: string) => conversationColumns.some((column) => column.name === name)
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
      const hasMessageColumn = (name: string) => messageColumns.some((column) => column.name === name)
      if (!hasMessageColumn('meta_json')) {
        db.exec("ALTER TABLE chat_messages ADD COLUMN meta_json TEXT DEFAULT '{}'")
      }
      db.exec("UPDATE chat_messages SET meta_json = COALESCE(NULLIF(meta_json, ''), '{}')")

      const threadColumns = db.prepare('PRAGMA table_info(agent_channel_threads)').all<{ name: string }>()
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
      const bookmarkColumns = db.prepare('PRAGMA table_info(browser_bookmarks)').all<{ name: string }>()
      const hasBookmarkColumn = (name: string) => bookmarkColumns.some((column) => column.name === name)
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

      const historyColumns = db.prepare('PRAGMA table_info(browser_history)').all<{ name: string }>()
      const hasHistoryColumn = (name: string) => historyColumns.some((column) => column.name === name)
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
      db.exec('CREATE INDEX IF NOT EXISTS idx_history_last_visit_time ON browser_history(last_visit_time DESC)')

      const downloadColumns = db.prepare('PRAGMA table_info(browser_downloads)').all<{ name: string }>()
      const hasDownloadColumn = (name: string) => downloadColumns.some((column) => column.name === name)
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
      db.exec('CREATE INDEX IF NOT EXISTS idx_downloads_end_time ON browser_downloads(end_time DESC)')

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
      db.exec('CREATE INDEX IF NOT EXISTS idx_memory_layer_scope ON agent_memory_metadata(layer, scope_id, archived_at)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_memory_category_priority ON agent_memory_metadata(category, priority DESC)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_memory_expires ON agent_memory_metadata(expires_at) WHERE expires_at IS NOT NULL')
      db.exec('CREATE INDEX IF NOT EXISTS idx_memory_access ON agent_memory_metadata(last_accessed_at DESC)')

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
      db.exec('CREATE INDEX IF NOT EXISTS idx_triggers_enabled_priority ON agent_triggers(enabled, priority DESC)')
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
      db.exec('CREATE INDEX IF NOT EXISTS idx_trigger_refs_priority ON agent_trigger_refs(trigger_id, priority DESC)')

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
      db.exec('CREATE INDEX IF NOT EXISTS idx_memory_access_log_time ON agent_memory_access_log(accessed_at DESC)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_memory_access_log_memory ON agent_memory_access_log(memory_id, accessed_at DESC)')

      // Seed with existing hardcoded triggers
      db.exec(`
        INSERT INTO agent_triggers (id, label, module, pattern, blocking, priority) VALUES
          ('feishu-doc', '飞书文档操作', 'feishu', '(飞书).*(文档|doc)|创建飞书文档|改写飞书文档|写入飞书', 1, 0),
          ('feishu-image', '飞书插图操作', 'feishu', '(飞书).*(图片|插图|上传)', 1, 0),
          ('browser-upload', '浏览器上传流程', 'browser', '(上传|发送|提交|浏览器|网页)', 0, 0),
          ('document-write', '文档改写操作', 'document', '(文档|文件).*(写|改|保存|格式)', 0, 0),
          ('video-render', '视频渲染操作', 'video', '(视频|剪辑|渲染|导出)', 0, 0),
          ('rss-analysis', 'RSS 分析操作', 'rss', '(rss|订阅|抓取|分析)', 0, 0),
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
      const memoryColumns = db.prepare('PRAGMA table_info(agent_memory_metadata)').all<{ name: string }>()
      const hasMemoryUserColumn = memoryColumns.some((column) => column.name === 'user_id')
      if (!hasMemoryUserColumn) {
        db.exec(`ALTER TABLE agent_memory_metadata ADD COLUMN user_id TEXT`)
        db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_user ON agent_memory_metadata(user_id, category)`)
      }

      // Extend chat_conversations with user_id for per-user conversations
      const conversationColumns = db.prepare('PRAGMA table_info(chat_conversations)').all<{ name: string }>()
      const hasConversationUserColumn = conversationColumns.some((column) => column.name === 'user_id')
      if (!hasConversationUserColumn) {
        db.exec(`ALTER TABLE chat_conversations ADD COLUMN user_id TEXT`)
        db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON chat_conversations(user_id)`)
      }

      // Create default user profile
      const now = Date.now()
      db.prepare(`
        INSERT INTO user_profiles (id, name, preferred_language, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('default-user', 'Default User', 'zh', now, now)
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
      db.exec('CREATE INDEX IF NOT EXISTS idx_skill_executions_updated_at ON skill_executions(updated_at DESC)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_skill_executions_session_status ON skill_executions(session_id, status, updated_at DESC)')

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
      db.exec('CREATE INDEX IF NOT EXISTS idx_skill_execution_steps_execution_step ON skill_execution_steps(execution_id, step_id, attempt)')

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
      db.exec('CREATE INDEX IF NOT EXISTS idx_skill_execution_artifacts_execution_step ON skill_execution_artifacts(execution_id, step_id, created_at DESC)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_skill_execution_artifacts_artifact_id ON skill_execution_artifacts(artifact_id)')
    }
  },

  // ------------------------------------------------------------------ 019
  {
    name: '019_add_rss_draft_store_fields',
    up: (db) => {
      const rssItemColumns = db.prepare("PRAGMA table_info(rss_items)").all<{ name: string }>()
      const hasInboxVisible = rssItemColumns.some((column) => column.name === 'inbox_visible')
      if (!hasInboxVisible) {
        db.exec('ALTER TABLE rss_items ADD COLUMN inbox_visible INTEGER DEFAULT 1')
      }

      const rssSourceColumns = db.prepare("PRAGMA table_info(rss_sources)").all<{ name: string }>()
      const hasDraftSeeded = rssSourceColumns.some((column) => column.name === 'draft_seeded')
      if (!hasDraftSeeded) {
        db.exec('ALTER TABLE rss_sources ADD COLUMN draft_seeded INTEGER DEFAULT 0')
      }

      db.exec('CREATE INDEX IF NOT EXISTS idx_rss_items_inbox_visible ON rss_items(inbox_visible, starred, published_at DESC)')
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
      db.exec('CREATE INDEX IF NOT EXISTS idx_browser_tasks_status_updated ON browser_tasks(status, updated_at DESC)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_browser_tasks_kind_created ON browser_tasks(kind, created_at DESC)')
    }
  }
]

/**
 * Run all pending migrations against the given database connection.
 *
 * Safe to call multiple times -- already-applied migrations are skipped.
 * Each migration is wrapped in its own transaction.
 */
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

    // Wrap each migration in a transaction for atomicity
    db.exec('BEGIN')
    try {
      migration.up(db)

      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
        migration.name,
        new Date().toISOString()
      )

      db.exec('COMMIT')
      console.log(`[migrations] applied: ${migration.name}`)
    } catch (error) {
      db.exec('ROLLBACK')
      console.error(`[migrations] failed: ${migration.name}`, error)
      throw error
    }
  }
}
