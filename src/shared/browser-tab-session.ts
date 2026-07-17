export interface PersistedBrowserTabSession {
  id: string
  url: string
  title: string
  domain?: string
  favicon?: string | null
  profile?: string | null
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  lastAuditedAt?: number | null
}

export interface RegisterDormantBrowserTabsRequest {
  tabs: PersistedBrowserTabSession[]
  activeTabId: string | null
  splitTabId: string | null
}

export interface RegisterDormantBrowserTabsResult {
  success: boolean
  activeTabId?: string | null
  splitTabId?: string | null
  materializedTabIds?: string[]
  dormantTabIds?: string[]
  error?: string
}
