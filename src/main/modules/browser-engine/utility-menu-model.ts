import type { BrowserBookmark, BrowserDownload, BrowserHistoryEntry } from '../database'
import type {
  BrowserUtilityMenuCurrentTab,
  BrowserUtilityMenuKind,
} from '../../../shared/browser-utility-menu'

export type BrowserUtilityMenuAction =
  | 'toggle-current-bookmark'
  | 'open-bookmark'
  | 'remove-bookmark'
  | 'import-bookmarks'
  | 'export-bookmarks'
  | 'open-download'
  | 'clear-downloads'
  | 'open-history-entry'
  | 'clear-history'
  | 'toggle-adblock'
  | 'toggle-current-site-adblock'
  | 'print'
  | 'open-external'
  | 'clip-current-tab'

export interface BrowserUtilityMenuItem {
  type: 'action' | 'separator' | 'submenu'
  label?: string
  enabled?: boolean
  action?: BrowserUtilityMenuAction
  payload?: Record<string, string | number | boolean | null | undefined>
  items?: BrowserUtilityMenuItem[]
}

export interface BrowserUtilityMenuModel {
  kind: BrowserUtilityMenuKind
  items: BrowserUtilityMenuItem[]
}

export interface BrowserUtilityMenuState {
  currentTab: BrowserUtilityMenuCurrentTab | null
  bookmarks: Pick<BrowserBookmark, 'url' | 'title'>[]
  downloads: Pick<BrowserDownload, 'filename' | 'url' | 'save_path' | 'state' | 'created_at'>[]
  history: Pick<BrowserHistoryEntry, 'title' | 'url' | 'visited_at'>[]
  currentDomain: string
  adblockEnabled: boolean
  adblockDomainWhitelisted: boolean
}

function createDisabledLabel(label: string): BrowserUtilityMenuItem {
  return {
    type: 'action',
    label,
    enabled: false,
  }
}

function truncateMenuLabel(value: string, maxLength = 42): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed || '未命名'
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function buildBookmarksMenu(state: BrowserUtilityMenuState): BrowserUtilityMenuModel {
  const currentUrl = state.currentTab?.url || ''
  const currentTitle = state.currentTab?.title || currentUrl || '当前页面'
  const currentBookmarked = !!currentUrl && state.bookmarks.some((item) => item.url === currentUrl)

  const bookmarkItems: BrowserUtilityMenuItem[] = state.bookmarks.slice(0, 10).map((item) => ({
    type: 'submenu',
    label: truncateMenuLabel(item.title || item.url),
    items: [
      {
        type: 'action',
        label: '打开',
        action: 'open-bookmark',
        payload: { url: item.url },
      },
      {
        type: 'action',
        label: '移除',
        action: 'remove-bookmark',
        payload: { url: item.url },
      },
    ],
  }))

  return {
    kind: 'bookmarks',
    items: [
      {
        type: 'action',
        label: currentBookmarked ? '取消收藏当前页面' : '收藏当前页面',
        enabled: Boolean(currentUrl),
        action: 'toggle-current-bookmark',
        payload: { url: currentUrl, title: currentTitle },
      },
      { type: 'separator' },
      ...(bookmarkItems.length > 0
        ? bookmarkItems
        : [createDisabledLabel('暂无收藏')]),
      { type: 'separator' },
      {
        type: 'action',
        label: '导入收藏夹…',
        action: 'import-bookmarks',
      },
      {
        type: 'action',
        label: '导出收藏夹…',
        action: 'export-bookmarks',
        enabled: state.bookmarks.length > 0,
      },
    ],
  }
}

function buildDownloadsMenu(state: BrowserUtilityMenuState): BrowserUtilityMenuModel {
  const downloadItems: BrowserUtilityMenuItem[] = state.downloads
    .slice()
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 10)
    .map((item) => ({
      type: 'action',
      label: truncateMenuLabel(item.filename || item.url || '未命名下载'),
      enabled: Boolean(item.save_path || item.url),
      action: 'open-download',
      payload: {
        savePath: item.save_path,
        url: item.url,
        completed: item.state === 'completed',
      },
    }))

  return {
    kind: 'downloads',
    items: [
      ...(downloadItems.length > 0
        ? downloadItems
        : [createDisabledLabel('暂无下载')]),
      { type: 'separator' },
      {
        type: 'action',
        label: '清空下载记录',
        enabled: state.downloads.length > 0,
        action: 'clear-downloads',
      },
    ],
  }
}

function buildHistorySubmenu(state: BrowserUtilityMenuState): BrowserUtilityMenuItem {
  const historyItems: BrowserUtilityMenuItem[] = state.history
    .slice()
    .sort((a, b) => b.visited_at - a.visited_at)
    .slice(0, 10)
    .map((item) => ({
      type: 'action',
      label: truncateMenuLabel(item.title || item.url || '未命名页面'),
      action: 'open-history-entry',
      payload: { url: item.url },
    }))

  return {
    type: 'submenu',
    label: '历史记录',
    items: historyItems.length > 0
      ? [
          ...historyItems,
          { type: 'separator' },
          {
            type: 'action',
            label: '清空历史记录',
            action: 'clear-history',
          },
        ]
      : [createDisabledLabel('暂无历史记录')],
  }
}

function buildMoreMenu(state: BrowserUtilityMenuState): BrowserUtilityMenuModel {
  const currentUrl = state.currentTab?.url || ''
  const currentDomain = state.currentDomain || state.currentTab?.domain || ''

  return {
    kind: 'more',
    items: [
      buildHistorySubmenu(state),
      { type: 'separator' },
      {
        type: 'action',
        label: state.adblockEnabled ? '关闭广告拦截' : '开启广告拦截',
        action: 'toggle-adblock',
      },
      {
        type: 'action',
        label: !currentDomain
          ? '当前页面没有可识别域名'
          : state.adblockDomainWhitelisted
            ? `恢复 ${currentDomain} 的广告拦截`
            : `对 ${currentDomain} 关闭广告拦截`,
        enabled: Boolean(currentDomain),
        action: 'toggle-current-site-adblock',
        payload: { domain: currentDomain },
      },
      { type: 'separator' },
      {
        type: 'action',
        label: '打印',
        enabled: Boolean(state.currentTab),
        action: 'print',
      },
      {
        type: 'action',
        label: '剪藏到 Obsidian 笔记',
        enabled: Boolean(currentUrl),
        action: 'clip-current-tab',
        payload: { url: currentUrl },
      },
      {
        type: 'action',
        label: '外部浏览器打开',
        enabled: Boolean(currentUrl),
        action: 'open-external',
        payload: { url: currentUrl },
      },
    ],
  }
}

export function buildBrowserUtilityMenuModel(
  kind: BrowserUtilityMenuKind,
  state: BrowserUtilityMenuState,
): BrowserUtilityMenuModel {
  switch (kind) {
    case 'bookmarks':
      return buildBookmarksMenu(state)
    case 'downloads':
      return buildDownloadsMenu(state)
    case 'more':
      return buildMoreMenu(state)
    default: {
      const exhaustiveCheck: never = kind
      throw new Error(`Unsupported utility menu kind: ${String(exhaustiveCheck)}`)
    }
  }
}
