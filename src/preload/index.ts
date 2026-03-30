import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrowserUtilityMenuRequest } from '../shared/browser-utility-menu'

// Agent API
const agentAPI = {
  send: (
    agent: string,
    message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
    sessionId?: string,
    requestId?: string
  ) => ipcRenderer.invoke('agent:send', { agent, message, sessionId, requestId }),
  newSession: (agent: string, sessionId?: string) => ipcRenderer.invoke('agent:newSession', { agent, sessionId }),
  orchestrate: (task: string, agents: string[]) =>
    ipcRenderer.invoke('agent:orchestrate', { task, agents }),
  getStatus: (agent: string) => ipcRenderer.invoke('agent:getStatus', agent),
  getAll: () => ipcRenderer.invoke('agent:getAll'),
  kill: (agent: string, sessionId?: string) => ipcRenderer.invoke('agent:kill', { agent, sessionId }),
  getDiagnostics: () => ipcRenderer.invoke('agent:getDiagnostics'),
  getRuntimeStatus: () => ipcRenderer.invoke('agent:getRuntimeStatus'),
  listChannels: () => ipcRenderer.invoke('agent:listChannels'),
  listConversationScopes: (agent?: string) => ipcRenderer.invoke('agent:listConversationScopes', { agent }),
  listScopeRuns: (payload?: { channelKey?: string; statuses?: string[]; limit?: number }) =>
    ipcRenderer.invoke('agent:listScopeRuns', payload || {}),
  getConversationScopeMessages: (scopeId: string) =>
    ipcRenderer.invoke('agent:getConversationScopeMessages', { scopeId }),
  createLocalScope: (agent: string) => ipcRenderer.invoke('agent:createLocalScope', { agent }),
  listScopeAttachments: (scopeId?: string) => ipcRenderer.invoke('agent:listScopeAttachments', { scopeId }),
  getScopeAttachment: (scopeId: string, attachmentId: string) =>
    ipcRenderer.invoke('agent:getScopeAttachment', { scopeId, attachmentId }),
  clearRemoteAttachmentCache: (channelId?: string) =>
    ipcRenderer.invoke('agent:clearRemoteAttachmentCache', { channelId }),
  getRemoteAttachmentCacheStats: (channelId?: string) =>
    ipcRenderer.invoke('agent:getRemoteAttachmentCacheStats', { channelId }),
  sendScoped: (
    scopeId: string,
    message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
    requestId?: string
  ) => ipcRenderer.invoke('agent:sendScoped', { scopeId, message, requestId }),
  upsertChannel: (payload: {
    id?: string
    type: 'local-debug' | 'generic-webhook' | 'feishu-bot' | 'feishu-app' | 'telegram-bot'
    name: string
    enabled?: boolean
    config?: Record<string, unknown>
  }) => ipcRenderer.invoke('agent:upsertChannel', payload),
  testChannel: (payload: {
    id?: string
    type: 'local-debug' | 'generic-webhook' | 'feishu-bot' | 'feishu-app' | 'telegram-bot'
    name: string
    enabled?: boolean
    config?: Record<string, unknown>
  }) => ipcRenderer.invoke('agent:testChannel', payload),
  deleteChannel: (id: string) => ipcRenderer.invoke('agent:deleteChannel', { id }),
  setChannelEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('agent:setChannelEnabled', { id, enabled }),
  sendChannelProbe: (id: string, text: string) =>
    ipcRenderer.invoke('agent:sendChannelProbe', { id, text }),
  listSchedules: () => ipcRenderer.invoke('agent:listSchedules'),
  upsertSchedule: (payload: {
    id?: string
    name: string
    cronExpr: string
    prompt: string
    channelId?: string | null
    enabled?: boolean
    payload?: Record<string, unknown>
  }) => ipcRenderer.invoke('agent:upsertSchedule', payload),
  runScheduleNow: (id: string) => ipcRenderer.invoke('agent:runScheduleNow', { id }),
  pauseSchedule: (id: string) => ipcRenderer.invoke('agent:pauseSchedule', { id }),
  resumeSchedule: (id: string) => ipcRenderer.invoke('agent:resumeSchedule', { id }),
  deleteSchedule: (id: string) => ipcRenderer.invoke('agent:deleteSchedule', { id }),
  onStream: (callback: (data: { agent: string; sessionId?: string; runId?: string; chunk: string; type: string }) => void) => {
    const handler = (_: unknown, data: { agent: string; sessionId?: string; runId?: string; chunk: string; type: string }) => callback(data)
    ipcRenderer.on('agent:stream', handler)
    return () => { ipcRenderer.removeListener('agent:stream', handler) }
  },
  onStatusChange: (callback: (data: { agent: string; sessionId?: string; runId?: string; status: string; isMock: boolean }) => void) => {
    const handler = (_: unknown, data: { agent: string; sessionId?: string; runId?: string; status: string; isMock: boolean }) => callback(data)
    ipcRenderer.on('agent:status', handler)
    return () => { ipcRenderer.removeListener('agent:status', handler) }
  },
  onError: (callback: (data: { agent: string; sessionId?: string; runId?: string; error: string; type: string }) => void) => {
    const handler = (_: unknown, data: { agent: string; sessionId?: string; runId?: string; error: string; type: string }) => callback(data)
    ipcRenderer.on('agent:error', handler)
    return () => { ipcRenderer.removeListener('agent:error', handler) }
  },
  onToolAction: (callback: (data: { agent?: string; sessionId?: string; runId?: string; tool: string; args: Record<string, unknown> }) => void) => {
    const handler = (_: unknown, data: { agent?: string; sessionId?: string; runId?: string; tool: string; args: Record<string, unknown> }) => callback(data)
    ipcRenderer.on('agent:toolAction', handler)
    return () => { ipcRenderer.removeListener('agent:toolAction', handler) }
  },
  onToolActionRequest: (callback: (data: { requestId: string; agent?: string; sessionId?: string; runId?: string; tool: string; args: Record<string, unknown> }) => void) => {
    const handler = (_: unknown, data: { requestId: string; agent?: string; sessionId?: string; runId?: string; tool: string; args: Record<string, unknown> }) => callback(data)
    ipcRenderer.on('agent:toolActionRequest', handler)
    return () => { ipcRenderer.removeListener('agent:toolActionRequest', handler) }
  },
  completeToolActionRequest: (payload: {
    requestId: string
    handled: boolean
    payload?: Record<string, unknown>
    error?: string
  }) => ipcRenderer.invoke('agent:completeToolActionRequest', payload),
  onConversationEvent: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown) => callback(data)
    ipcRenderer.on('agent:conversationEvent', handler)
    return () => { ipcRenderer.removeListener('agent:conversationEvent', handler) }
  },
  onScopeRunEvent: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown) => callback(data)
    ipcRenderer.on('agent:scopeRunEvent', handler)
    return () => { ipcRenderer.removeListener('agent:scopeRunEvent', handler) }
  }
}

// Memory API
const memoryAPI = {
  query: (filters: unknown) => ipcRenderer.invoke('agent:memory:query', filters),
  create: (entry: unknown) => ipcRenderer.invoke('agent:memory:create', entry),
  update: (id: string, updates: unknown) => ipcRenderer.invoke('agent:memory:update', { id, updates }),
  delete: (id: string) => ipcRenderer.invoke('agent:memory:delete', id),
  stats: () => ipcRenderer.invoke('agent:memory:stats'),
  createFromConversation: (payload: unknown) => ipcRenderer.invoke('agent:memory:createFromConversation', payload),
}

// Trigger API
const triggerAPI = {
  list: (filters?: unknown) => ipcRenderer.invoke('agent:trigger:list', filters),
  create: (trigger: unknown) => ipcRenderer.invoke('agent:trigger:create', trigger),
  update: (id: string, updates: unknown) => ipcRenderer.invoke('agent:trigger:update', { id, updates }),
  createWithMemories: (payload: unknown) => ipcRenderer.invoke('agent:trigger:createWithMemories', payload),
}

// Memory Lifecycle API
const memoryLifecycleAPI = {
  status: () => ipcRenderer.invoke('agent:memory:lifecycle:status'),
  runMaintenance: () => ipcRenderer.invoke('agent:memory:lifecycle:runMaintenance'),
}

// Browser API
const browserAPI = {
  createTab: (url: string) => ipcRenderer.invoke('browser:createTab', url),
  closeTab: (tabId: string) => ipcRenderer.invoke('browser:closeTab', tabId),
  switchTab: (tabId: string) => ipcRenderer.invoke('browser:switchTab', tabId),
  navigate: (tabId: string, url: string) => ipcRenderer.invoke('browser:navigate', { tabId, url }),
  goBack: (tabId: string) => ipcRenderer.invoke('browser:goBack', tabId),
  goForward: (tabId: string) => ipcRenderer.invoke('browser:goForward', tabId),
  reload: (tabId: string) => ipcRenderer.invoke('browser:reload', tabId),
  updateBounds: (bounds: { x: number; y: number; width: number; height: number }) => {
    ipcRenderer.send('browser:updateBounds', bounds)
    return Promise.resolve({ success: true })
  },
  hideAll: () => ipcRenderer.invoke('browser:hideAll'),
  hideActiveHost: () => ipcRenderer.invoke('browser:hideActiveHost'),
  showActive: () => ipcRenderer.invoke('browser:showActive'),
  fitActiveTabToBounds: (tabId?: string | null) => ipcRenderer.invoke('browser:fitActiveTabToBounds', tabId),
  captureWindowSnapshot: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:captureWindowSnapshot', bounds),
  captureViewportSnapshot: (tabId?: string | null) => ipcRenderer.invoke('browser:captureViewportSnapshot', tabId),
  getTabs: () => ipcRenderer.invoke('browser:getTabs'),
  getAdblockState: () => ipcRenderer.invoke('browser:getAdblockState'),
  getDiagnostics: () => ipcRenderer.invoke('browser:getDiagnostics'),
  setAdblockEnabled: (enabled: boolean, scope?: 'main' | 'preview' | 'all') =>
    ipcRenderer.invoke('browser:setAdblockEnabled', { enabled, scope }),
  toggleAdblockDomain: (domain: string) => ipcRenderer.invoke('browser:toggleAdblockDomain', { domain }),
  getTabContext: (tabId?: string) => ipcRenderer.invoke('browser:getTabContext', tabId),
  previewOpen: (payload: { url: string }) => ipcRenderer.invoke('browser:previewOpen', payload),
  previewNavigate: (payload: { url: string }) => ipcRenderer.invoke('browser:previewNavigate', payload),
  previewGoBack: () => ipcRenderer.invoke('browser:previewGoBack'),
  previewGoForward: () => ipcRenderer.invoke('browser:previewGoForward'),
  previewReload: () => ipcRenderer.invoke('browser:previewReload'),
  previewUpdateBounds: (bounds: { x: number; y: number; width: number; height: number }) => {
    ipcRenderer.send('browser:previewUpdateBounds', bounds)
    return Promise.resolve({ success: true })
  },
  previewClose: () => ipcRenderer.invoke('browser:previewClose'),
  previewGetState: () => ipcRenderer.invoke('browser:previewGetState'),
  onPreviewUpdate: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:previewUpdate', handler)
    return () => ipcRenderer.removeListener('browser:previewUpdate', handler)
  },
  onTabUpdate: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:tabUpdate', handler)
    return () => ipcRenderer.removeListener('browser:tabUpdate', handler)
  },
  onAdblockUpdate: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:adblockUpdate', handler)
    return () => ipcRenderer.removeListener('browser:adblockUpdate', handler)
  },
  onNewTabRequest: (callback: (url: string) => void) => {
    const handler = (_: unknown, url: string): void => callback(url)
    ipcRenderer.on('browser:newTabRequest', handler)
    return () => ipcRenderer.removeListener('browser:newTabRequest', handler)
  },

  // Bookmarks
  addBookmark: (url: string, title: string, favicon?: string) =>
    ipcRenderer.invoke('browser:addBookmark', { url, title, favicon }),
  removeBookmark: (url: string) => ipcRenderer.invoke('browser:removeBookmark', url),
  getBookmarks: () => ipcRenderer.invoke('browser:getBookmarks'),
  isBookmarked: (url: string) => ipcRenderer.invoke('browser:isBookmarked', url),
  importBookmarks: () => ipcRenderer.invoke('browser:importBookmarks'),
  exportBookmarks: () => ipcRenderer.invoke('browser:exportBookmarks'),
  onBookmarksChanged: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:bookmarksChanged', handler)
    return () => ipcRenderer.removeListener('browser:bookmarksChanged', handler)
  },

  // History
  getHistory: (limit?: number) => ipcRenderer.invoke('browser:getHistory', limit),
  clearHistory: () => ipcRenderer.invoke('browser:clearHistory'),
  searchHistory: (query: string) => ipcRenderer.invoke('browser:searchHistory', query),

  // Downloads
  getDownloads: () => ipcRenderer.invoke('browser:getDownloads'),
  clearDownloads: () => ipcRenderer.invoke('browser:clearDownloads'),
  onDownloadUpdate: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('browser:downloadUpdate', handler)
    return () => ipcRenderer.removeListener('browser:downloadUpdate', handler)
  },

  showUtilityMenu: (payload: BrowserUtilityMenuRequest) => ipcRenderer.invoke('browser:showUtilityMenu', payload),

  // Print
  print: (tabId: string) => ipcRenderer.invoke('browser:print', tabId)
}

// Document API
const documentAPI = {
  readFile: (path: string) => ipcRenderer.invoke('document:read', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('document:write', { path, content }),
  saveFileAs: (payload: { content: string; suggestedName?: string; defaultPath?: string | null }) =>
    ipcRenderer.invoke('document:saveAs', payload),
  listFiles: (dir: string) => ipcRenderer.invoke('document:list', dir),
  parseDocx: (path: string) => ipcRenderer.invoke('document:parseDocx', path),
  parseXlsx: (path: string) => ipcRenderer.invoke('document:parseXlsx', path),
  // File management
  mkdir: (path: string) => ipcRenderer.invoke('document:mkdir', path),
  rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('document:rename', { oldPath, newPath }),
  deleteItem: (path: string) => ipcRenderer.invoke('document:delete', path),
  copyItem: (src: string, dest: string) => ipcRenderer.invoke('document:copy', { src, dest }),
  moveItem: (src: string, dest: string) => ipcRenderer.invoke('document:move', { src, dest }),
  stat: (path: string) => ipcRenderer.invoke('document:stat', path),
  openFolder: () => ipcRenderer.invoke('document:openFolder'),
  getHome: () => ipcRenderer.invoke('document:getHome'),
  showInFolder: (path: string) => ipcRenderer.invoke('document:showInFolder', path),
  openPath: (path: string) => ipcRenderer.invoke('document:openPath', path),
  createFile: (path: string) => ipcRenderer.invoke('document:createFile', path),
  watchDirectories: (paths: string[]) => ipcRenderer.invoke('document:watchDirectories', { paths }),
  onDirectoryChange: (callback: (data: { paths: string[]; timestamp: number }) => void) => {
    const handler = (_: unknown, data: { paths: string[]; timestamp: number }) => callback(data)
    ipcRenderer.on('document:directoryChanged', handler)
    return () => { ipcRenderer.removeListener('document:directoryChanged', handler) }
  }
}

// RSS API
const rssAPI = {
  getSources: () => ipcRenderer.invoke('rss:getSources'),
  addSource: (source: unknown) => ipcRenderer.invoke('rss:addSource', source),
  removeSource: (id: string) => ipcRenderer.invoke('rss:removeSource', id),
  getItems: (sourceId?: string) => ipcRenderer.invoke('rss:getItems', sourceId),
  markRead: (itemId: string) => ipcRenderer.invoke('rss:markRead', itemId),
  markReadBatch: (itemIds: string[]) => ipcRenderer.invoke('rss:markReadBatch', itemIds),
  deleteItems: (itemIds: string[]) => ipcRenderer.invoke('rss:deleteItems', itemIds),
  toggleStarred: (itemId: string) => ipcRenderer.invoke('rss:toggleStarred', itemId),
  refreshSource: (sourceId: string) => ipcRenderer.invoke('rss:refreshSource', { sourceId }),
  fetchAll: (options?: { digest?: boolean; classification?: 'simple' | 'none'; group?: string; sourceIds?: string[] }) =>
    ipcRenderer.invoke('rss:fetchAll', options),
  status: () => ipcRenderer.invoke('rss:status'),
  stats: () => ipcRenderer.invoke('rss:stats'),
  diagnostics: () => ipcRenderer.invoke('rss:diagnostics'),
  benchmarkSources: (options?: { group?: string; sourceIds?: string[] }) =>
    ipcRenderer.invoke('rss:benchmarkSources', options),
  repairRuntime: () => ipcRenderer.invoke('rss:repairRuntime'),
  exportOpml: () => ipcRenderer.invoke('rss:exportOpml'),
  exportFeed: (type?: 'master' | 'tech' | 'humanities' | 'design' | 'entertainment' | 'others') =>
    ipcRenderer.invoke('rss:exportFeed', type),
  startItemAnalysis: (payload: {
    itemId: string
    action: 'copy' | 'visual'
    link: string
    title: string
    targetDir: string
    source?: string
    summary?: string
    publishedAt?: string
    force?: boolean
  }) => ipcRenderer.invoke('rss:startItemAnalysis', payload),
  getItemAnalysisProgress: (payload?: { itemIds?: string[] }) =>
    ipcRenderer.invoke('rss:getItemAnalysisProgress', payload),
  listItemAnalysisJobs: (payload?: { itemId?: string; limit?: number }) =>
    ipcRenderer.invoke('rss:listItemAnalysisJobs', payload),
  pauseAnalysisJob: (payload: { jobId: string }) => ipcRenderer.invoke('rss:pauseAnalysisJob', payload),
  resumeAnalysisJob: (payload: { jobId: string }) => ipcRenderer.invoke('rss:resumeAnalysisJob', payload),
  deleteAnalysisJob: (payload: { jobId: string }) => ipcRenderer.invoke('rss:deleteAnalysisJob', payload),
}

// Calendar API
const calendarAPI = {
  getSources: () => ipcRenderer.invoke('calendar:getSources'),
  getEvents: (start: Date, end: Date) => ipcRenderer.invoke('calendar:getEvents', { start, end }),
  createEvent: (event: unknown) => ipcRenderer.invoke('calendar:createEvent', event),
  updateEvent: (id: string, event: unknown) => ipcRenderer.invoke('calendar:updateEvent', { id, event }),
  deleteEvent: (id: string) => ipcRenderer.invoke('calendar:deleteEvent', id)
}

// Skills Runtime API
const skillsAPI = {
  list: () => ipcRenderer.invoke('skills:list'),
  runtimeInfo: () => ipcRenderer.invoke('skills:runtimeInfo'),
  importCustomSkill: (payload: { path: string }) => ipcRenderer.invoke('skills:importCustomSkill', payload),
  removeCustomSkill: (payload: { skillId: string }) => ipcRenderer.invoke('skills:removeCustomSkill', payload),
  updateCustomSkillDescription: (payload: { skillId: string; description: string }) =>
    ipcRenderer.invoke('skills:updateCustomSkillDescription', payload),
  install: (payload: { skillId: string; force?: boolean }) => ipcRenderer.invoke('skills:install', payload),
  run: (payload: {
    skillId: string
    action: string
    params?: Record<string, unknown>
    timeoutMs?: number
    sessionId?: string
    executionMode?: 'auto' | 'workflow' | 'direct'
  }) => ipcRenderer.invoke('skills:run', payload),
  listJobs: (limit?: number) => ipcRenderer.invoke('skills:jobs:list', { limit }),
  listExecutions: (payload?: { limit?: number; sessionId?: string; activeOnly?: boolean }) =>
    ipcRenderer.invoke('skills:executions:list', payload || {}),
  getExecution: (payload: { id: string }) => ipcRenderer.invoke('skills:executions:get', payload),
  submitInput: (payload: { executionId: string; inputs: Record<string, unknown> }) =>
    ipcRenderer.invoke('skills:executions:submitInput', payload),
  submitConfirmation: (payload: { executionId: string; stepId: string; confirmed: boolean }) =>
    ipcRenderer.invoke('skills:executions:submitConfirmation', payload),
  submitAgentResult: (payload: {
    executionId: string
    stepId: string
    textContent?: string
    outputs?: Record<string, unknown>
  }) => ipcRenderer.invoke('skills:executions:submitAgentResult', payload),
  restartFromStep: (payload: { executionId: string; stepId: string; inputs?: Record<string, unknown> }) =>
    ipcRenderer.invoke('skills:executions:restartFromStep', payload),
  cancelExecution: (payload: { executionId: string }) => ipcRenderer.invoke('skills:executions:cancel', payload),
  listSchedules: () => ipcRenderer.invoke('skills:schedules:list'),
  createSchedule: (payload: {
    skillId: string
    action: string
    params?: Record<string, unknown>
    intervalMinutes: number
    startAt?: string
  }) => ipcRenderer.invoke('skills:schedules:create', payload),
  toggleSchedule: (payload: { id: string; enabled: boolean }) =>
    ipcRenderer.invoke('skills:schedules:toggle', payload),
  deleteSchedule: (payload: { id: string }) => ipcRenderer.invoke('skills:schedules:delete', payload),
}

// App / Auto-update API
const appAPI = {
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  onUpdateStatus: (callback: (data: {
    status: string; version?: string; releaseDate?: string;
    percent?: number; bytesPerSecond?: number; transferred?: number; total?: number;
    error?: string
  }) => void) => {
    const handler = (_: unknown, data: {
      status: string; version?: string; releaseDate?: string;
      percent?: number; bytesPerSecond?: number; transferred?: number; total?: number;
      error?: string
    }): void => callback(data)
    ipcRenderer.on('update-status', handler)
    return () => ipcRenderer.removeListener('update-status', handler)
  },
  onShortcut: (callback: (data: {
    key: string
    metaKey?: boolean
    ctrlKey?: boolean
    shiftKey?: boolean
    altKey?: boolean
  }) => void) => {
    const handler = (_: unknown, data: {
      key: string
      metaKey?: boolean
      ctrlKey?: boolean
      shiftKey?: boolean
      altKey?: boolean
    }): void => callback(data)
    ipcRenderer.on('app:shortcut', handler)
    return () => ipcRenderer.removeListener('app:shortcut', handler)
  }
}

// Window API
const windowAPI = {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
}

// Theme API
const themeAPI = {
  set: (theme: string) => ipcRenderer.invoke('theme:set', theme),
  get: () => ipcRenderer.invoke('theme:get'),
}

// Settings API
const settingsAPI = {
  get: (key: string) => ipcRenderer.invoke('settings:get', key),
  set: (key: string, value: string) => ipcRenderer.invoke('settings:set', { key, value }),
  getAll: () => ipcRenderer.invoke('settings:getAll'),
  getAIConfig: () => ipcRenderer.invoke('settings:getAIConfig'),
  setAIConfig: (config: unknown) => ipcRenderer.invoke('settings:setAIConfig', config),
  testAIConnection: (config: unknown) => ipcRenderer.invoke('settings:testAIConnection', config),
}

// Chat History + File API
const chatAPI = {
  getConversations: (agent: string) => ipcRenderer.invoke('chat:getConversations', agent),
  getMessages: (conversationId: string) => ipcRenderer.invoke('chat:getMessages', conversationId),
  deleteConversation: (conversationId: string) => ipcRenderer.invoke('chat:deleteConversation', conversationId),
  saveMessage: (data: { id: string; conversationId: string; role: string; content: string; timestamp: string }) =>
    ipcRenderer.invoke('chat:saveMessage', data),
  createConversation: (data: { id: string; agent: string; title: string }) =>
    ipcRenderer.invoke('chat:createConversation', data),
  updateConversationTitle: (data: { id: string; title: string }) =>
    ipcRenderer.invoke('chat:updateConversationTitle', data),
  pickFiles: () => ipcRenderer.invoke('chat:pickFiles'),
  readFileForAI: (filePath: string) => ipcRenderer.invoke('chat:readFileForAI', filePath),
}

// User Profile API
const userProfileAPI = {
  get: (userId: string) => ipcRenderer.invoke('userProfile:get', userId),
  list: () => ipcRenderer.invoke('userProfile:list'),
  create: (profile: {
    id?: string
    name?: string
    avatarUrl?: string
    preferredLanguage?: string
    communicationStyle?: string
  }) => ipcRenderer.invoke('userProfile:create', profile),
  update: (userId: string, updates: {
    name?: string
    avatarUrl?: string
    preferredLanguage?: string
    communicationStyle?: string
  }) => ipcRenderer.invoke('userProfile:update', userId, updates),
  delete: (userId: string) => ipcRenderer.invoke('userProfile:delete', userId),
}

// Agent Personality API
const agentPersonalityAPI = {
  get: (agentName: string) => ipcRenderer.invoke('agentPersonality:get', agentName),
  list: () => ipcRenderer.invoke('agentPersonality:list'),
  create: (personality: {
    agentName: string
    displayName?: string
    personalityText: string
    tone?: string
  }) => ipcRenderer.invoke('agentPersonality:create', personality),
  update: (agentName: string, updates: {
    displayName?: string
    personalityText?: string
    tone?: string
  }) => ipcRenderer.invoke('agentPersonality:update', agentName, updates),
  delete: (agentName: string) => ipcRenderer.invoke('agentPersonality:delete', agentName),
}

// Expose APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  agent: agentAPI,
  memory: memoryAPI,
  trigger: triggerAPI,
  memoryLifecycle: memoryLifecycleAPI,
  browser: browserAPI,
  document: documentAPI,
  rss: rssAPI,
  calendar: calendarAPI,
  skills: skillsAPI,
  app: appAPI,
  window: windowAPI,
  theme: themeAPI,
  settings: settingsAPI,
  chat: chatAPI,
  userProfile: userProfileAPI,
  agentPersonality: agentPersonalityAPI,
  platform: process.platform,
  // Utility for drag-and-drop: get real file path from File object
  getFilePathFromDrop: (file: File) => webUtils.getPathForFile(file),
})

// Type declarations for renderer
declare global {
  interface Window {
    electronAPI: {
      agent: typeof agentAPI
      memory: typeof memoryAPI
      trigger: typeof triggerAPI
      memoryLifecycle: typeof memoryLifecycleAPI
      browser: typeof browserAPI
      document: typeof documentAPI
      rss: typeof rssAPI
      calendar: typeof calendarAPI
      skills: typeof skillsAPI
      app: typeof appAPI
      window: typeof windowAPI
      theme: typeof themeAPI
      settings: typeof settingsAPI
      chat: typeof chatAPI
      userProfile: typeof userProfileAPI
      agentPersonality: typeof agentPersonalityAPI
      platform: string
      getFilePathFromDrop: (file: File) => string
    }
  }
}
