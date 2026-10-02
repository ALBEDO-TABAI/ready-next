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
  type: 'patch' | 'closed'
  tabId: string
  activeTabId?: string | null
  title?: string
  url?: string
  domain?: string
  favicon?: string | null
  profile?: string | null
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  lastAuditedAt?: number | null
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  error?: string | null
}

export interface AdblockState {
  enabled: boolean
  whitelistDomains: string[]
  rulesVersion: string
  networkBlockedCount: number
  lastUpdatedAt: number | null
}

export interface BrowserDiagnosticsData {
  hostDriver: 'webContentsView'
  tabCount: number
  activeTabId: string | null
  diagnosticsLogPath: string
  recentLogs: string[]
  currentTask: {
    sessionId?: string
    taskTitle: string
    taskSummary: string
    currentStepId: string | null
    blockedReason?: string | null
    recentEvidence: string[]
    resumableActions: string[]
    targetUrl?: string | null
    updatedAt: string
  } | null
  pageState: {
    url: string
    title: string
    domain: string
    targetMatched: boolean
    uploadComplete: boolean
    promptComplete: boolean
    running: boolean
    modeSelection: boolean
    modalVisible: boolean
    canReuseCurrentPage: boolean
    updatedAt: string
  } | null
  continuity: {
    sessionId?: string
    workflowKind: string
    stage: string
    canResume: boolean
    lastFailureReason?: string | null
    lastEvidence: string[]
    targetUrl?: string | null
    updatedAt: string
  } | null
  lastFailure: {
    reason: string
    updatedAt: string
  } | null
  availableActions: string[]
  rendererProcesses: Array<{
    pid: number
    tabIds: string[]
    domains: string[]
    loadStates: Array<'visible' | 'protected-background' | 'throttled' | 'dormant'>
    cpuPercent: number
    memoryKB: number
    processType: string
    creationTime: number
  }>
  tabLoadStates: Array<{
    tabId: string
    state: 'visible' | 'protected-background' | 'throttled' | 'dormant'
  }>
  eventCounts60s: Record<string, number>
}
