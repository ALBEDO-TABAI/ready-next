export type PanelType = 'bookmarks' | 'downloads' | 'history' | null

export interface BookmarkItem {
  id: string
  url: string
  title: string
  favicon: string | null
  created_at: number
}

export interface HistoryItem {
  id: string
  url: string
  title: string
  favicon?: string | null
  domain?: string
  visit_count?: number
  last_visit_time?: number
  visited_at: number
}

export interface DownloadItem {
  id: string
  url: string
  filename: string
  save_path: string
  total_bytes: number
  received_bytes: number
  state: string
  mime_type?: string | null
  error?: string | null
  end_time?: number | null
  can_resume?: number
  created_at: number
}

export interface TabUpdateEvent {
  type: 'title' | 'navigate' | 'loading' | 'error' | 'meta'
  tabId: string
  title?: string
  url?: string
  domain?: string
  favicon?: string | null
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  lastAuditedAt?: number | null
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  error?: string
}

export interface AdblockState {
  enabled: boolean
  previewEnabled: boolean
  whitelistDomains: string[]
  rulesVersion: string
  networkBlockedCount: number
  lastUpdatedAt: number | null
}

export interface BrowserPreviewDiagnosticsState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

export interface BrowserDiagnosticsData {
  hostDriver: 'browserView' | 'webContentsView'
  tabCount: number
  activeTabId: string | null
  diagnosticsLogPath: string
  recentLogs: string[]
  preview: BrowserPreviewDiagnosticsState
}
