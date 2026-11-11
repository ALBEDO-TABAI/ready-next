export type BrowserOpenTargetMode = 'prefer_reuse' | 'new_tab' | 'current_tab'

export type BrowserStructuredTemplate =
  | 'article_list'
  | 'image_gallery'
  | 'link_list'
  | 'card_list'
  | 'custom'

export interface BrowserStructuredFieldMapping {
  name: string
  selector?: string
  attr?: string
  type?: 'text' | 'html' | 'href' | 'src' | 'attr'
}

export interface BrowserWaitForConditionOptions {
  condition: 'page_readable' | 'selector' | 'network_idle' | 'content_stable' | 'custom_js' | 'target_appeared' | 'target_disappeared' | 'text_changed'
  selector?: string
  previousText?: string
  customJs?: string
  timeoutMs?: number
  checkIntervalMs?: number
  stableIterations?: number
}

export interface BrowserExtractStructuredOptions {
  template: BrowserStructuredTemplate
  itemSelector?: string
  fields?: BrowserStructuredFieldMapping[]
  limit?: number
  minWidth?: number
  customScript?: string
  wait?: BrowserWaitForConditionOptions
  openMode?: BrowserOpenTargetMode
  timeoutMs?: number
  settleMs?: number
}

export interface BrowserStructuredItem {
  sourceUrl: string
  title?: string
  link?: string
  summary?: string
  media?: string[]
  rawFields?: Record<string, unknown>
}

export interface BrowserCandidateStructureContext {
  inNavigationRegion?: boolean
  inSidebarRegion?: boolean
  inHeaderRegion?: boolean
  inMainContentRegion?: boolean
  nearestTagName?: string
  nearestRole?: string
  nearestAriaLabel?: string
  containerClass?: string
}

export interface BrowserExtractStructuredResult {
  template: BrowserStructuredTemplate
  items: BrowserStructuredItem[]
  sourceUrl?: string
}

export interface BrowserScrollCollectOptions extends BrowserExtractStructuredOptions {
  maxScrolls?: number
  scrollDelayMs?: number
  stableRounds?: number
  beforeScroll?: () => Promise<void>
}

export interface BrowserScrollCollectResult extends BrowserExtractStructuredResult {
  scrolls: number
  reachedEnd: boolean
}

export interface BrowserAggregateOptions {
  mergeStrategy?: 'concat' | 'dedupe'
  sortBy?: 'title' | 'link' | 'source'
}

export interface BrowserCapabilityTaskProgress {
  total: number
  completed: number
  failed: number
  currentLabel?: string | null
}

export const BROWSER_CAPABILITY_TASK_KINDS = [
  'browser_workflow',
  'download_urls',
  'scroll_collect',
  'research',
  'visible_collect',
  'note_collect',
  'card_loop',
] as const

export type BrowserCapabilityTaskKind = typeof BROWSER_CAPABILITY_TASK_KINDS[number]
export type BrowserCapabilityTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_human'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface BrowserTaskCheckpoint {
  taskId: string
  stage: string
  cursor?: string | null
  lastSeenFingerprint?: string | null
  partialResults?: unknown
  targetList?: Array<{
    id: string
    url: string | null
  }>
  failures?: Array<{
    targetId: string
    classification: 'verification' | 'rate_limit' | 'network' | 'target_missing' | 'unavailable' | 'authorization' | 'unknown'
    retryable: boolean
  }>
  outputHashes?: Array<{
    targetId: string
    sha256: string
  }>
  binding?: {
    tabId: string | null
    documentEpoch: number | null
  }
  nextStep?: {
    action: 'resume' | 'verify' | 'finish' | 'none'
    cursor: string | null
  }
}

export interface BrowserCapabilityTaskHandle {
  taskId: string
  kind: BrowserCapabilityTaskKind
  status: BrowserCapabilityTaskStatus
  progress: BrowserCapabilityTaskProgress
  checkpoint?: BrowserTaskCheckpoint | null
  result?: unknown
  error?: string | null
  createdAt?: string
  startedAt?: string | null
  finishedAt?: string | null
  updatedAt?: string
  revision?: number
  createdByRunId?: string | null
  activeExecutionBinding?: import('../../../shared/agent-execution-profile').TaskExecutionBinding | null
  parentTaskId?: string | null
  projectionRevision?: number
  projectionSync?: Record<string, unknown> | null
}

export interface BrowserStartTaskRequest {
  kind: BrowserCapabilityTaskKind
  payload: Record<string, unknown>
}

export interface BrowserResearchBundle {
  sources: BrowserStructuredItem[]
  dedupedItems: BrowserStructuredItem[]
  artifacts?: string[]
}

export interface BrowserOpenTargetResult {
  success: boolean
  tabId?: string
  reused?: boolean
  url?: string
  error?: string
}
