import { useDocTabs } from '../../../stores/useDocTabs'
import { useMode } from '../../../stores/useMode'
import type { ActiveDocumentSnapshot, DocActionPayload } from './types'
import { getFreshRecentToolTargetTab } from './write-locks'

export function getActiveDocTab() {
  const store = useDocTabs.getState()
  return store.tabs.find((tab) => tab.id === store.activeTabId) || null
}

export function resolveDocTab(target?: string): ReturnType<typeof getActiveDocTab> {
  const store = useDocTabs.getState()
  if (!target || target.trim() === '') return getActiveDocTab()
  const trimmed = target.trim()
  if (trimmed.toLowerCase() === 'current') return getActiveDocTab()
  const exactById = store.tabs.find((tab) => tab.id === trimmed)
  if (exactById) return exactById
  const index = Number(trimmed)
  if (Number.isInteger(index) && index >= 1 && index <= store.tabs.length) {
    return store.tabs[index - 1]
  }
  const lower = trimmed.toLowerCase()
  return store.tabs.find((tab) => tab.title.toLowerCase().includes(lower)) || null
}

export function resolveDocActionTab(action: DocActionPayload): ReturnType<typeof getActiveDocTab> {
  const explicitTabId = typeof action.tabId === 'string' ? action.tabId : ''
  if (explicitTabId.trim()) return resolveDocTab(explicitTabId)

  const recentTarget = getFreshRecentToolTargetTab()
  if (recentTarget) return recentTarget

  return getActiveDocTab()
}

export function buildActiveDocumentContext(): string | null {
  const mode = useMode.getState().workbenchMode
  if (mode !== 'document') return null

  const docStore = useDocTabs.getState()
  const activeTab = docStore.tabs.find((tab) => tab.id === docStore.activeTabId)
  if (!activeTab) return null

  const ext = activeTab.path?.split('.').pop()?.toLowerCase() || 'untitled'
  const raw = activeTab.content || ''
  const clipped = raw.slice(0, 1_200)
  const truncated = raw.length > 1_200

  const lines = [
    '### 当前文档上下文',
    `- 标题: ${activeTab.title}`,
    `- 路径: ${activeTab.path || '(未保存草稿)'}`,
    `- 类型: ${ext}`,
    `- 字符数: ${raw.length}`,
    '',
    '--- 文档摘要开始 ---',
    clipped,
    truncated ? '...[文档摘要已截断]' : null,
    '--- 文档摘要结束 ---',
  ].filter(Boolean)

  return lines.join('\n')
}

export function getActiveDocumentSnapshot(tabId?: string): ActiveDocumentSnapshot | null {
  const mode = useMode.getState().workbenchMode
  if (mode !== 'document') return null

  const docStore = useDocTabs.getState()
  const activeTab = typeof tabId === 'string' && tabId.trim().length > 0
    ? docStore.tabs.find((tab) => tab.id === tabId.trim())
    : docStore.tabs.find((tab) => tab.id === docStore.activeTabId)
  if (!activeTab) return null

  const content = activeTab.content || ''
  return {
    tabId: activeTab.id,
    title: activeTab.title,
    path: activeTab.path || null,
    content,
    isDirty: Boolean(activeTab.isDirty),
    charCount: content.length,
  }
}
