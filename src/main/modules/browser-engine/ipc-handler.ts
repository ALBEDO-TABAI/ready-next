import { ipcMain, BrowserWindow, BrowserView, WebContentsView, shell, dialog, session, Menu, clipboard } from 'electron'
import { extname } from 'path'
import { appendFile, readFile, writeFile } from 'fs/promises'
import { getDatabase } from '../database'
import { AuthPopupManager } from './auth-popup-manager'
import {
  isAllowedBrowserURL,
  shouldAllowBrowserPermission,
  toOAuthCompatibleUserAgent,
} from './popup-policy'

type BrowserHostKind = 'browserView' | 'webContentsView'
type BrowserHostView = BrowserView | WebContentsView

interface Tab {
  id: string
  url: string
  title: string
  domain: string
  favicon: string | null
  owner: BrowserTabOwner
  required: boolean
  activity: BrowserTabActivity
  lastAuditedAt: number | null
  view?: BrowserHostView
}

export type BrowserTabOwner = 'manual' | 'agent'
export type BrowserTabActivity = 'idle' | 'running' | 'attention'

export interface BrowserAdblockState {
  enabled: boolean
  previewEnabled: boolean
  whitelistDomains: string[]
  rulesVersion: string
  networkBlockedCount: number
  lastUpdatedAt: number | null
}

export interface BrowserTabContextData {
  title: string
  url: string
  domain: string
  heading: string
  selection: string
  excerpt: string
  capturedAt: number
}

interface PreviewTabState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

interface BookmarkTransferItem {
  url: string
  title: string
}

export type BrowserCDPErrorCode =
  | 'NO_ACTIVE_TAB'
  | 'TAB_NOT_FOUND'
  | 'DEBUGGER_ATTACH_FAILED'
  | 'CDP_COMMAND_FAILED'

export interface BrowserViewportMetrics {
  width: number
  height: number
  pageX: number
  pageY: number
  scale: number
}

export interface BrowserMouseEventPayload {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel'
  x: number
  y: number
  button?: 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward'
  buttons?: number
  clickCount?: number
  deltaX?: number
  deltaY?: number
  modifiers?: number
}

export interface BrowserKeyEventPayload {
  type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char'
  key?: string
  code?: string
  text?: string
  modifiers?: number
  windowsVirtualKeyCode?: number
  nativeVirtualKeyCode?: number
  isKeypad?: boolean
  autoRepeat?: boolean
  unmodifiedText?: string
  location?: number
}

export interface BrowserScreenshotOptions {
  mode?: 'viewport' | 'clip' | 'full_page'
  clip?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export interface BrowserUploadTarget {
  id: string
  kind: 'input' | 'launcher' | 'dropzone'
  selectorHint: string
  label: string
  accepts: string
  multiple: boolean
  hidden: boolean
  confidence?: number
  evidence?: string[]
  associatedInputSelector?: string
  x?: number
  y?: number
}

const READY_ADBLOCK_RULES_VERSION = 'ready-basic-ads-v1'
const READY_ADBLOCK_HOST_PATTERNS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagservices.com',
  '2mdn.net',
  'adnxs.com',
  'adsrvr.org',
  'amazon-adsystem.com',
  'casalemedia.com',
  'criteo.com',
  'criteo.net',
  'googletagmanager.com',
  'moatads.com',
  'openx.net',
  'outbrain.com',
  'pubmatic.com',
  'rubiconproject.com',
  'scorecardresearch.com',
  'smartadserver.com',
  'taboola.com',
]

function extractBrowserDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function normalizeDomainToken(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, '')
}

function normalizeDomainList(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : []
  return Array.from(new Set(
    raw
      .map((item) => normalizeDomainToken(String(item || '')))
      .filter(Boolean)
  ))
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function normalizeBookmarkItem(rawUrl: unknown, rawTitle: unknown): BookmarkTransferItem | null {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!url || !isAllowedBrowserURL(url)) return null
  const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0
    ? rawTitle.trim()
    : url
  return { url, title }
}

function parseBookmarksFromHTML(content: string): BookmarkTransferItem[] {
  const result: BookmarkTransferItem[] = []
  const anchorRegex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorRegex.exec(content)) !== null) {
    const item = normalizeBookmarkItem(decodeHtmlEntities(match[1]), decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '').trim()))
    if (item) result.push(item)
  }
  return result
}

function parseBookmarksFromJSON(content: string): BookmarkTransferItem[] {
  const result: BookmarkTransferItem[] = []
  const parsed = JSON.parse(content) as unknown

  const visit = (node: unknown): void => {
    if (!node) return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (typeof node !== 'object') return

    const record = node as Record<string, unknown>
    const candidate = normalizeBookmarkItem(
      record.url ?? record.href,
      record.title ?? record.name,
    )
    if (candidate) {
      result.push(candidate)
    }

    Object.values(record).forEach(visit)
  }

  visit(parsed)
  return result
}

function buildBookmarksHTML(items: BookmarkTransferItem[]): string {
  const rows = items
    .map((item) => `    <DT><A HREF="${escapeHtml(item.url)}" ADD_DATE="${Math.floor(Date.now() / 1000)}">${escapeHtml(item.title)}</A>`)
    .join('\n')
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This file was generated by Ready Browser. -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    rows,
    '</DL><p>',
    '',
  ].join('\n')
}

// Re-export for use by tools module
export { isAllowedBrowserURL }

/**
 * BrowserController — programmatic API for browser tab management.
 * Extracted from the closure-based setupBrowserIPC so that other modules
 * (e.g. tool-executor) can access BrowserView instances directly.
 */
export class BrowserController {
  tabs = new Map<string, Tab>()
  activeTabId: string | null = null
  tabCounter = 0
  viewBounds = { x: 0, y: 0, width: 800, height: 600 }
  previewBounds = { x: 0, y: 0, width: 800, height: 600 }
  private appliedBoundsByView = new WeakMap<BrowserHostView, string>()
  private pendingBoundsByView = new WeakMap<BrowserHostView, { x: number; y: number; width: number; height: number }>()
  private boundsFlushTimers = new WeakMap<BrowserHostView, ReturnType<typeof setTimeout>>()
  private hostKindByView = new WeakMap<BrowserHostView, BrowserHostKind>()
  private attachedHosts = new WeakSet<BrowserHostView>()
  private hiddenHosts = new WeakSet<BrowserHostView>()
  private readonly offscreenBounds = { x: -100000, y: -100000, width: 1, height: 1 }
  private readonly browserHostKind: BrowserHostKind
  private mainWindow: BrowserWindow
  private useMock: boolean
  private downloadListenerRegistered = false
  private previewView: BrowserHostView | null = null
  private popupManager: AuthPopupManager
  private readonly browserUserAgent: string
  private adblockState: BrowserAdblockState
  private adblockUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private lastAdblockRendererUpdateAt = 0
  private previewState: PreviewTabState = {
    url: '',
    title: 'Preview',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  }

  constructor(mainWindow: BrowserWindow, useMock = false) {
    this.mainWindow = mainWindow
    this.useMock = useMock
    this.browserHostKind = this.resolveBrowserHostKind()
    this.browserUserAgent = toOAuthCompatibleUserAgent(mainWindow.webContents.getUserAgent())
    this.popupManager = new AuthPopupManager(
      mainWindow,
      (url) => {
        void this.createTab(url).catch((error) => {
          this.logBrowserDiag(`[browser-v3][popup] create tab failed: ${String(error)}`)
          shell.openExternal(url)
        })
      },
      (message) => this.logBrowserDiag(message),
      this.browserUserAgent,
    )
    this.adblockState = this.readAdblockState()
    this.setupBrowserSessionPolicies()
  }

  private logBrowserDiag(message: string): void {
    const line = `${new Date().toISOString()} ${message}\n`
    void appendFile('/tmp/ready-browser.log', line, 'utf-8').catch(() => {
      // ignore file logging failures
    })
    console.log(message)
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private resolveBrowserHostKind(): BrowserHostKind {
    const envRaw = process.env.READY_BROWSER_HOST_DRIVER
    const normalizedEnv = typeof envRaw === 'string' ? envRaw.trim().toLowerCase() : ''
    if (normalizedEnv === 'browserview') return 'browserView'
    if (normalizedEnv === 'webcontentsview') return 'webContentsView'
    try {
      const raw = String(getDatabase().getSetting('browser_host_driver') || '').trim().toLowerCase()
      if (raw === 'browserview') return 'browserView'
      if (raw === 'webcontentsview') return 'webContentsView'
    } catch {
      // ignore persisted setting failures
    }
    return 'webContentsView'
  }

  private createDefaultAdblockState(): BrowserAdblockState {
    return {
      enabled: true,
      previewEnabled: true,
      whitelistDomains: [],
      rulesVersion: READY_ADBLOCK_RULES_VERSION,
      networkBlockedCount: 0,
      lastUpdatedAt: null,
    }
  }

  private readAdblockState(): BrowserAdblockState {
    const fallback = this.createDefaultAdblockState()
    try {
      const db = getDatabase()
      const whitelistRaw = db.getSetting('browser_adblock_whitelist_domains')
      const whitelist = whitelistRaw
        ? normalizeDomainList(JSON.parse(whitelistRaw))
        : []
      const lastUpdatedAt = Number(db.getSetting('browser_adblock_last_updated_at') || 0)
      const networkBlockedCount = Number(db.getSetting('browser_adblock_network_blocked_count') || 0)
      return {
        enabled: db.getSetting('browser_adblock_enabled') !== 'false',
        previewEnabled: db.getSetting('browser_adblock_preview_enabled') !== 'false',
        whitelistDomains: whitelist,
        rulesVersion: String(db.getSetting('browser_adblock_rules_version') || READY_ADBLOCK_RULES_VERSION),
        networkBlockedCount: Number.isFinite(networkBlockedCount) ? networkBlockedCount : 0,
        lastUpdatedAt: Number.isFinite(lastUpdatedAt) && lastUpdatedAt > 0 ? lastUpdatedAt : null,
      }
    } catch {
      return fallback
    }
  }

  private persistAdblockState(): void {
    try {
      const db = getDatabase()
      db.setSetting('browser_adblock_enabled', this.adblockState.enabled ? 'true' : 'false')
      db.setSetting('browser_adblock_preview_enabled', this.adblockState.previewEnabled ? 'true' : 'false')
      db.setSetting('browser_adblock_whitelist_domains', JSON.stringify(this.adblockState.whitelistDomains))
      db.setSetting('browser_adblock_rules_version', this.adblockState.rulesVersion)
      db.setSetting('browser_adblock_network_blocked_count', String(this.adblockState.networkBlockedCount))
      db.setSetting(
        'browser_adblock_last_updated_at',
        String(this.adblockState.lastUpdatedAt || Math.floor(Date.now() / 1000)),
      )
    } catch {
      // ignore persistence failures
    }
  }

  private scheduleAdblockRendererUpdate(force = false): void {
    const now = Date.now()
    if (force || now - this.lastAdblockRendererUpdateAt >= 400) {
      this.lastAdblockRendererUpdateAt = now
      this.sendToRenderer('browser:adblockUpdate', this.getAdblockState())
      return
    }
    if (this.adblockUpdateTimer) return
    this.adblockUpdateTimer = setTimeout(() => {
      this.adblockUpdateTimer = null
      this.lastAdblockRendererUpdateAt = Date.now()
      this.sendToRenderer('browser:adblockUpdate', this.getAdblockState())
    }, 420)
  }

  private rememberBlockedAdRequest(): void {
    this.adblockState.networkBlockedCount += 1
    if (this.adblockState.networkBlockedCount % 10 === 0) {
      try {
        getDatabase().setSetting(
          'browser_adblock_network_blocked_count',
          String(this.adblockState.networkBlockedCount),
        )
      } catch {
        // ignore persistence failures
      }
    }
    this.scheduleAdblockRendererUpdate()
  }

  private resolveOriginDomainForWebContentsId(webContentsId?: number): string {
    if (!webContentsId) return ''
    for (const tab of this.tabs.values()) {
      if (tab.view?.webContents.id === webContentsId) {
        return tab.domain || extractBrowserDomain(tab.url)
      }
    }
    if (this.previewView?.webContents.id === webContentsId) {
      return extractBrowserDomain(this.previewState.url)
    }
    return ''
  }

  private isWhitelistedDomain(hostname: string, originDomain?: string): boolean {
    const host = normalizeDomainToken(hostname)
    const origin = normalizeDomainToken(originDomain || '')
    if (!host && !origin) return false
    return this.adblockState.whitelistDomains.some((candidate) => {
      const normalized = normalizeDomainToken(candidate)
      if (!normalized) return false
      return (
        host === normalized ||
        host.endsWith(`.${normalized}`) ||
        origin === normalized ||
        origin.endsWith(`.${normalized}`)
      )
    })
  }

  private isKnownAdHost(hostname: string): boolean {
    const host = normalizeDomainToken(hostname)
    if (!host) return false
    return READY_ADBLOCK_HOST_PATTERNS.some((pattern) => host === pattern || host.endsWith(`.${pattern}`))
  }

  private shouldBlockAdRequest(
    requestUrl: string,
    resourceType: string,
    originDomain: string,
    isPreview: boolean,
  ): boolean {
    if (!this.adblockState.enabled) return false
    if (isPreview && !this.adblockState.previewEnabled) return false
    if (resourceType === 'mainFrame') return false
    if (!/^https?:\/\//i.test(requestUrl)) return false
    const host = extractBrowserDomain(requestUrl)
    if (!host || this.isWhitelistedDomain(host, originDomain)) return false
    return this.isKnownAdHost(host)
  }

  private buildTabPayload(tab: Tab): {
    id: string
    url: string
    title: string
    domain: string
    favicon: string | null
    owner: BrowserTabOwner
    required: boolean
    activity: BrowserTabActivity
    lastAuditedAt: number | null
    active: boolean
  } {
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      domain: tab.domain,
      favicon: tab.favicon,
      owner: tab.owner,
      required: tab.required,
      activity: tab.activity,
      lastAuditedAt: tab.lastAuditedAt,
      active: tab.id === this.activeTabId,
    }
  }

  private emitTabMeta(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.sendToRenderer('browser:tabUpdate', {
      type: 'meta',
      tabId,
      ...this.buildTabPayload(tab),
    })
  }

  private createHost(partition: string): BrowserHostView {
    const options = {
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition,
        spellcheck: true,
        webSecurity: true,
      },
    }
    const view = this.browserHostKind === 'webContentsView'
      ? new WebContentsView(options)
      : new BrowserView(options)
    this.hostKindByView.set(view, this.browserHostKind)
    return view
  }

  private attachHost(view: BrowserHostView): void {
    if (this.attachedHosts.has(view)) return
    const kind = this.hostKindByView.get(view) || 'browserView'
    if (kind === 'webContentsView') {
      this.mainWindow.contentView.addChildView(view as WebContentsView)
    } else {
      this.mainWindow.addBrowserView(view as BrowserView)
    }
    this.attachedHosts.add(view)
  }

  detachHost(view: BrowserHostView): void {
    if (!this.attachedHosts.has(view)) return
    const timer = this.boundsFlushTimers.get(view)
    if (timer) {
      clearTimeout(timer)
      this.boundsFlushTimers.delete(view)
    }
    const kind = this.hostKindByView.get(view) || 'browserView'
    try {
      if (kind === 'webContentsView') {
        this.mainWindow.contentView.removeChildView(view as WebContentsView)
      } else {
        this.mainWindow.removeBrowserView(view as BrowserView)
      }
    } catch {
      // ignore detached host errors
    }
    this.attachedHosts.delete(view)
    this.hiddenHosts.delete(view)
  }

  private setHostBoundsNow(view: BrowserHostView, bounds: { x: number; y: number; width: number; height: number }): void {
    const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
    if (this.appliedBoundsByView.get(view) === key) return
    view.setBounds(bounds)
    this.appliedBoundsByView.set(view, key)
  }

  private scheduleHostBounds(view: BrowserHostView, bounds: { x: number; y: number; width: number; height: number }): void {
    this.pendingBoundsByView.set(view, bounds)
    const existing = this.boundsFlushTimers.get(view)
    if (existing) return
    const timer = setTimeout(() => {
      this.boundsFlushTimers.delete(view)
      const pending = this.pendingBoundsByView.get(view)
      if (!pending) return
      this.setHostBoundsNow(view, pending)
    }, 24)
    this.boundsFlushTimers.set(view, timer)
  }

  showHost(view: BrowserHostView, bounds: { x: number; y: number; width: number; height: number }): void {
    this.attachHost(view)
    this.hiddenHosts.delete(view)
    this.pendingBoundsByView.set(view, bounds)
    this.scheduleHostBounds(view, bounds)
  }

  hideHost(view: BrowserHostView): void {
    this.attachHost(view)
    this.hiddenHosts.add(view)
    this.pendingBoundsByView.set(view, this.offscreenBounds)
    this.setHostBoundsNow(view, this.offscreenBounds)
  }

  sendToRenderer(channel: string, data: unknown): void {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }

  applyBounds(view: BrowserHostView): void {
    this.pendingBoundsByView.set(view, this.viewBounds)
    if (this.hiddenHosts.has(view)) return
    this.scheduleHostBounds(view, this.viewBounds)
  }

  applyPreviewBounds(view: BrowserHostView): void {
    this.pendingBoundsByView.set(view, this.previewBounds)
    if (this.hiddenHosts.has(view)) return
    this.scheduleHostBounds(view, this.previewBounds)
  }

  private isAppShortcutInput(input: Electron.Input): boolean {
    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return false
    const key = String(input.key || '')
    const meta = Boolean(input.meta) || Boolean(input.control)
    if (!meta && !input.shift) {
      if (key === 'Home') return true
      if (/^F[1-6]$/.test(key)) return true
    }
    if (meta && !input.shift) {
      if (/^[1-6]$/.test(key)) return true
      if (key === 'b' || key === 'B' || key === ',' || key === '\\') return true
    }
    return false
  }

  private dispatchAppShortcut(input: Electron.Input): void {
    this.sendToRenderer('app:shortcut', {
      key: String(input.key || ''),
      metaKey: Boolean(input.meta),
      ctrlKey: Boolean(input.control),
      shiftKey: Boolean(input.shift),
      altKey: Boolean(input.alt),
    })
  }

  private bindAppShortcutBridge(webContents: Electron.WebContents): void {
    webContents.on('before-input-event', (event, input) => {
      if (!this.isAppShortcutInput(input)) return
      event.preventDefault()
      this.dispatchAppShortcut(input)
    })
  }

  private buildBrowserContextMenu(
    webContents: Electron.WebContents,
    params: Electron.ContextMenuParams,
  ): Electron.MenuItemConstructorOptions[] {
    const template: Electron.MenuItemConstructorOptions[] = []
    const pushSeparator = () => {
      if (template.length === 0) return
      if (template[template.length - 1].type === 'separator') return
      template.push({ type: 'separator' })
    }

    template.push(
      {
        label: '后退',
        enabled: webContents.navigationHistory.canGoBack(),
        click: () => {
          if (webContents.navigationHistory.canGoBack()) {
            webContents.navigationHistory.goBack()
          }
        },
      },
      {
        label: '前进',
        enabled: webContents.navigationHistory.canGoForward(),
        click: () => {
          if (webContents.navigationHistory.canGoForward()) {
            webContents.navigationHistory.goForward()
          }
        },
      },
      {
        label: '刷新',
        click: () => webContents.reload(),
      },
      {
        label: '强制刷新（忽略缓存）',
        click: () => webContents.reloadIgnoringCache(),
      },
    )

    pushSeparator()
    template.push(
      {
        label: '实际大小',
        click: () => webContents.setZoomFactor(1),
      },
      {
        label: '放大',
        click: () => webContents.setZoomFactor(Math.min(3, webContents.getZoomFactor() + 0.1)),
      },
      {
        label: '缩小',
        click: () => webContents.setZoomFactor(Math.max(0.25, webContents.getZoomFactor() - 0.1)),
      },
    )

    const linkUrl = String(params.linkURL || '').trim()
    if (linkUrl && isAllowedBrowserURL(linkUrl)) {
      pushSeparator()
      template.push(
        {
          label: '在新标签页打开链接',
          click: () => {
            void this.createTab(linkUrl).catch((error) => {
              this.logBrowserDiag(`[browser-v3][context] open link in tab failed: ${String(error)}`)
            })
          },
        },
        {
          label: '在外部浏览器打开链接',
          click: () => {
            void shell.openExternal(linkUrl)
          },
        },
        {
          label: '复制链接地址',
          click: () => clipboard.writeText(linkUrl),
        },
        {
          label: '下载链接',
          click: () => {
            try {
              webContents.downloadURL(linkUrl)
            } catch (error) {
              this.logBrowserDiag(`[browser-v3][context] download link failed: ${String(error)}`)
            }
          },
        },
      )
    }

    const imageUrl = String(params.srcURL || '').trim()
    const hasImage = params.mediaType === 'image' || params.hasImageContents
    if (hasImage && imageUrl) {
      pushSeparator()
      template.push(
        {
          label: '在新标签页打开图片',
          click: () => {
            void this.createTab(imageUrl).catch((error) => {
              this.logBrowserDiag(`[browser-v3][context] open image in tab failed: ${String(error)}`)
            })
          },
        },
        {
          label: '复制图片地址',
          click: () => clipboard.writeText(imageUrl),
        },
        {
          label: '复制图片',
          click: () => {
            try {
              webContents.copyImageAt(params.x, params.y)
            } catch (error) {
              this.logBrowserDiag(`[browser-v3][context] copy image failed: ${String(error)}`)
            }
          },
        },
        {
          label: '下载图片',
          click: () => {
            try {
              webContents.downloadURL(imageUrl)
            } catch (error) {
              this.logBrowserDiag(`[browser-v3][context] download image failed: ${String(error)}`)
            }
          },
        },
        {
          label: '在外部浏览器打开图片',
          click: () => {
            void shell.openExternal(imageUrl)
          },
        },
      )
    }

    pushSeparator()
    template.push(
      {
        label: '复制页面地址',
        click: () => clipboard.writeText(webContents.getURL()),
      },
      {
        label: '查看网页源代码',
        click: () => {
          const url = webContents.getURL()
          if (!isAllowedBrowserURL(url)) return
          void shell.openExternal(`view-source:${url}`)
        },
      },
      {
        label: '网页另存为…',
        click: () => {
          void (async () => {
            try {
              const defaultName = (webContents.getTitle() || '网页内容').replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').slice(0, 64)
              const result = await dialog.showSaveDialog(this.mainWindow, {
                title: '保存网页',
                defaultPath: `${defaultName || '网页内容'}.html`,
                filters: [
                  { name: '网页文件', extensions: ['html', 'htm'] },
                  { name: '全部文件', extensions: ['*'] },
                ],
              })
              if (result.canceled || !result.filePath) return
              await webContents.savePage(result.filePath, 'HTMLComplete')
            } catch (error) {
              this.logBrowserDiag(`[browser-v3][context] save page failed: ${String(error)}`)
            }
          })()
        },
      },
      {
        label: '打印…',
        click: () => webContents.print(),
      },
    )

    pushSeparator()
    template.push(
      {
        label: '剪切',
        click: () => {
          try { webContents.cut() } catch (error) {
            this.logBrowserDiag(`[browser-v3][context] cut failed: ${String(error)}`)
          }
        },
        enabled: Boolean(params.editFlags?.canCut),
      },
      {
        label: '复制',
        click: () => {
          try { webContents.copy() } catch (error) {
            this.logBrowserDiag(`[browser-v3][context] copy failed: ${String(error)}`)
          }
        },
        enabled: Boolean(params.editFlags?.canCopy || (params.selectionText && params.selectionText.length > 0)),
      },
      {
        label: '粘贴',
        click: () => {
          try { webContents.paste() } catch (error) {
            this.logBrowserDiag(`[browser-v3][context] paste failed: ${String(error)}`)
          }
        },
        enabled: Boolean(params.editFlags?.canPaste),
      },
      {
        label: '全选',
        click: () => {
          try { webContents.selectAll() } catch (error) {
            this.logBrowserDiag(`[browser-v3][context] selectAll failed: ${String(error)}`)
          }
        },
      },
    )

    pushSeparator()
    template.push(
      {
        label: '检查元素',
        click: () => {
          webContents.openDevTools({ mode: 'detach' })
          webContents.inspectElement(params.x, params.y)
        },
      },
      {
        label: '打开开发者工具',
        click: () => webContents.openDevTools({ mode: 'detach' }),
      },
    )

    return template
  }

  private installContextMenu(webContents: Electron.WebContents): void {
    webContents.on('context-menu', (_event, params) => {
      try {
        const template = this.buildBrowserContextMenu(webContents, params)
        if (!template.length) return
        const menu = Menu.buildFromTemplate(template)
        menu.popup({ window: this.mainWindow })
      } catch (error) {
        this.logBrowserDiag(`[browser-v3][context] build menu failed: ${String(error)}`)
      }
    })
  }

  getActiveTab(): Tab | undefined {
    if (!this.activeTabId) return undefined
    return this.tabs.get(this.activeTabId)
  }

  updateTabRuntimeState(
    tabId: string | null,
    updates: Partial<Pick<Tab, 'owner' | 'required' | 'activity' | 'lastAuditedAt'>>,
  ): Tab | null {
    const resolvedTabId = tabId || this.activeTabId
    if (!resolvedTabId) return null
    const tab = this.tabs.get(resolvedTabId)
    if (!tab) return null
    if (updates.owner !== undefined) tab.owner = updates.owner
    if (updates.required !== undefined) tab.required = updates.required
    if (updates.activity !== undefined) tab.activity = updates.activity
    if (updates.lastAuditedAt !== undefined) tab.lastAuditedAt = updates.lastAuditedAt
    this.emitTabMeta(resolvedTabId)
    return tab
  }

  getAdblockState(): BrowserAdblockState {
    return {
      ...this.adblockState,
      whitelistDomains: [...this.adblockState.whitelistDomains],
    }
  }

  setAdblockEnabled(enabled: boolean, scope: 'main' | 'preview' | 'all' = 'all'): BrowserAdblockState {
    if (scope === 'all' || scope === 'main') {
      this.adblockState.enabled = enabled
    }
    if (scope === 'all' || scope === 'preview') {
      this.adblockState.previewEnabled = enabled
    }
    this.adblockState.lastUpdatedAt = Math.floor(Date.now() / 1000)
    this.persistAdblockState()
    this.scheduleAdblockRendererUpdate(true)
    return this.getAdblockState()
  }

  toggleAdblockDomain(domain: string): BrowserAdblockState {
    const normalized = normalizeDomainToken(domain)
    if (!normalized) return this.getAdblockState()
    const current = new Set(this.adblockState.whitelistDomains)
    if (current.has(normalized)) current.delete(normalized)
    else current.add(normalized)
    this.adblockState.whitelistDomains = Array.from(current).sort()
    this.adblockState.lastUpdatedAt = Math.floor(Date.now() / 1000)
    this.persistAdblockState()
    this.scheduleAdblockRendererUpdate(true)
    return this.getAdblockState()
  }

  getTabList(): Array<{
    id: string
    url: string
    title: string
    domain: string
    favicon: string | null
    owner: BrowserTabOwner
    required: boolean
    activity: BrowserTabActivity
    lastAuditedAt: number | null
    active: boolean
  }> {
    return Array.from(this.tabs.values()).map((tab) => this.buildTabPayload(tab))
  }

  async getTabContext(tabId?: string | null): Promise<BrowserTabContextData> {
    const resolvedTabId = tabId || this.activeTabId
    if (!resolvedTabId) throw new Error('No active tab')
    const tab = this.tabs.get(resolvedTabId)
    if (!tab?.view) throw new Error(`Tab not found: ${resolvedTabId}`)

    const context = await tab.view.webContents.executeJavaScript(
      `(() => {
        const title = document.title || ''
        const url = location.href || ''
        const hostname = (() => {
          try { return new URL(url).hostname.toLowerCase() } catch { return '' }
        })()
        const selection = (window.getSelection && String(window.getSelection() || '')) || ''
        const heading = (document.querySelector('h1')?.textContent || '').trim()
        const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim()
        return {
          title,
          url,
          domain: hostname,
          heading,
          selection: selection.trim().slice(0, 4000),
          excerpt: bodyText.slice(0, 8000),
          capturedAt: Date.now(),
        }
      })()`,
      true,
    ) as Partial<BrowserTabContextData> | null

    return {
      title: context?.title || tab.title || '',
      url: context?.url || tab.url || '',
      domain: context?.domain || (() => {
        try { return new URL(context?.url || tab.url || '').hostname.toLowerCase() } catch { return '' }
      })(),
      heading: context?.heading || '',
      selection: context?.selection || '',
      excerpt: context?.excerpt || '',
      capturedAt: context?.capturedAt || Date.now(),
    }
  }

  private createBrowserError(code: BrowserCDPErrorCode, message: string): Error {
    const error = new Error(message)
    ;(error as Error & { code?: BrowserCDPErrorCode }).code = code
    return error
  }

  private resolveTabView(tabId: string | null): { tabId: string; tab: Tab; view: BrowserHostView } {
    const tid = tabId || this.activeTabId
    if (!tid) {
      throw this.createBrowserError('NO_ACTIVE_TAB', 'No active tab')
    }
    const tab = this.tabs.get(tid)
    if (!tab?.view) {
      throw this.createBrowserError('TAB_NOT_FOUND', `Tab not found: ${tid}`)
    }
    return { tabId: tid, tab, view: tab.view }
  }

  private sendPreviewUpdate(): void {
    this.sendToRenderer('browser:previewUpdate', { ...this.previewState })
  }

  private setupBrowserSessionPolicies(): void {
    const applyForPartition = (partition: string, isPreview: boolean): void => {
      const targetSession = session.fromPartition(partition)
      const marker = targetSession as unknown as {
        __readyBrowserPolicyApplied?: boolean
        __readyBrowserAdblockApplied?: boolean
      }
      if (marker.__readyBrowserPolicyApplied) return
      marker.__readyBrowserPolicyApplied = true

      targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
        return shouldAllowBrowserPermission(permission, requestingOrigin)
      })

      targetSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const requestingUrl = webContents.getURL()
        const allowed = shouldAllowBrowserPermission(permission, requestingUrl)
        callback(allowed)
      })

      if (!marker.__readyBrowserAdblockApplied) {
        marker.__readyBrowserAdblockApplied = true
        targetSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
          try {
            const originDomain = this.resolveOriginDomainForWebContentsId(details.webContentsId)
            const shouldBlock = this.shouldBlockAdRequest(
              details.url,
              details.resourceType || '',
              originDomain,
              isPreview,
            )
            if (shouldBlock) {
              this.rememberBlockedAdRequest()
              callback({ cancel: true })
              return
            }
          } catch {
            // ignore adblock hook failures
          }
          callback({ cancel: false })
        })
      }
    }

    applyForPartition('persist:browser', false)
    applyForPartition('persist:browser-preview', true)
  }

  private handleWindowOpen(
    details: {
      url: string
      frameName?: string
      features?: string
      disposition?: string
      referrer?: { url?: string }
    },
    source: 'tab' | 'preview',
    sourceContentsId: number,
  ): {
    action: 'allow' | 'deny'
    overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions
  } {
    const resolved = this.popupManager.resolveWindowOpen({
      url: details.url,
      frameName: details.frameName,
      features: details.features,
      disposition: details.disposition,
      referrer: details.referrer?.url,
    })
    this.logBrowserDiag(
      `[browser-v3][popup] source=${source} mode=${resolved.mode} reason=${resolved.reason} url=${details.url}`,
    )
    this.popupManager.notifyWindowOpenRequested({
      sourceContentsId,
      url: details.url,
      mode: resolved.mode,
      reason: resolved.reason,
    })

    if (resolved.mode === 'allow-popup') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: resolved.overrideBrowserWindowOptions,
      }
    }

    if (resolved.mode === 'open-tab') {
      void this.createTab(details.url).catch((error) => {
        this.logBrowserDiag(`[browser-v3][popup] failed to open in tab: ${String(error)}`)
        shell.openExternal(details.url)
      })
      return { action: 'deny' }
    }

    shell.openExternal(details.url)
    return { action: 'deny' }
  }

  private importBookmarksFromList(items: BookmarkTransferItem[]): { imported: number; skipped: number } {
    const db = getDatabase()
    const seen = new Set<string>()
    let imported = 0
    let skipped = 0

    for (const item of items) {
      const key = item.url.trim()
      if (!key || seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)
      if (db.isBookmarked(key)) {
        skipped += 1
        continue
      }
      db.addBookmark(key, item.title)
      imported += 1
    }

    return { imported, skipped }
  }

  async importBookmarksFromDialog(): Promise<{
    success: boolean
    canceled?: boolean
    imported?: number
    skipped?: number
    error?: string
    filePath?: string
  }> {
    try {
      const picked = await dialog.showOpenDialog(this.mainWindow, {
        title: '导入收藏夹',
        properties: ['openFile'],
        filters: [
          { name: 'Bookmarks', extensions: ['html', 'htm', 'json'] },
          { name: 'HTML', extensions: ['html', 'htm'] },
          { name: 'JSON', extensions: ['json'] },
        ],
      })

      if (picked.canceled || picked.filePaths.length === 0) {
        return { success: true, canceled: true }
      }

      const filePath = picked.filePaths[0]
      const content = await readFile(filePath, 'utf-8')
      const ext = extname(filePath).toLowerCase()

      const parsedItems = ext === '.json'
        ? parseBookmarksFromJSON(content)
        : parseBookmarksFromHTML(content)

      const { imported, skipped } = this.importBookmarksFromList(parsedItems)

      this.sendToRenderer('browser:bookmarksChanged', {
        action: 'import',
        imported,
        skipped,
        filePath,
      })

      return { success: true, imported, skipped, filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async exportBookmarksToDialog(): Promise<{
    success: boolean
    canceled?: boolean
    exported?: number
    error?: string
    filePath?: string
  }> {
    try {
      const saved = await dialog.showSaveDialog(this.mainWindow, {
        title: '导出收藏夹',
        defaultPath: 'ready-bookmarks.html',
        filters: [
          { name: 'HTML', extensions: ['html'] },
          { name: 'JSON', extensions: ['json'] },
        ],
      })

      if (saved.canceled || !saved.filePath) {
        return { success: true, canceled: true }
      }

      const filePath = saved.filePath
      const ext = extname(filePath).toLowerCase()
      const bookmarks = getDatabase().getBookmarks()
      const normalized = bookmarks.map((item) => ({ url: item.url, title: item.title }))

      const payload = ext === '.json'
        ? JSON.stringify(normalized, null, 2)
        : buildBookmarksHTML(normalized)

      await writeFile(filePath, payload, 'utf-8')

      this.sendToRenderer('browser:bookmarksChanged', {
        action: 'export',
        exported: normalized.length,
        filePath,
      })

      return { success: true, exported: normalized.length, filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private ensurePreviewView(): BrowserHostView {
    if (this.previewView) {
      return this.previewView
    }

    const view = this.createHost('persist:browser-preview')
    try {
      view.webContents.setUserAgent(this.browserUserAgent)
    } catch {
      // ignore user-agent sync failures
    }
    this.applyPreviewBounds(view)

    view.webContents.on('page-title-updated', (_, title) => {
      this.previewState.title = title
      this.sendPreviewUpdate()
    })

    view.webContents.on('did-navigate', (_, url) => {
      this.previewState.url = url
      this.previewState.canGoBack = view.webContents.navigationHistory.canGoBack()
      this.previewState.canGoForward = view.webContents.navigationHistory.canGoForward()
      this.previewState.error = undefined
      this.sendPreviewUpdate()
    })

    view.webContents.on('did-navigate-in-page', (_, url) => {
      this.previewState.url = url
      this.previewState.canGoBack = view.webContents.navigationHistory.canGoBack()
      this.previewState.canGoForward = view.webContents.navigationHistory.canGoForward()
      this.previewState.error = undefined
      this.sendPreviewUpdate()
    })

    view.webContents.on('did-start-loading', () => {
      this.previewState.loading = true
      this.sendPreviewUpdate()
    })

    view.webContents.on('did-stop-loading', () => {
      this.previewState.loading = false
      this.previewState.canGoBack = view.webContents.navigationHistory.canGoBack()
      this.previewState.canGoForward = view.webContents.navigationHistory.canGoForward()
      this.sendPreviewUpdate()
    })

    view.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
      this.logBrowserDiag(`[browser-v3][fail-load][preview] code=${String(errorCode)} message=${errorDescription}`)
      this.previewState.loading = false
      this.previewState.error = `${errorDescription} (${errorCode})`
      this.sendPreviewUpdate()
    })

    this.popupManager.bindWindow(view.webContents)
    view.webContents.setWindowOpenHandler((details) => this.handleWindowOpen(details, 'preview', view.webContents.id))
    this.installContextMenu(view.webContents)

    this.previewView = view
    return view
  }

  async previewOpen(url: string): Promise<{ success: boolean; error?: string }> {
    if (!isAllowedBrowserURL(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http: and https: are allowed.' }
    }
    if (this.useMock) {
      this.previewState = {
        url,
        title: 'Mock Preview',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      }
      this.sendPreviewUpdate()
      return { success: true }
    }

    const view = this.ensurePreviewView()
    if (this.activeTabId) {
      const activeTab = this.tabs.get(this.activeTabId)
      if (activeTab?.view) {
        this.hideHost(activeTab.view)
      }
    }
    this.showHost(view, this.previewBounds)
    this.applyPreviewBounds(view)
    this.previewState = {
      ...this.previewState,
      url,
      loading: true,
      error: undefined,
    }
    this.sendPreviewUpdate()
    await view.webContents.loadURL(url)
    return { success: true }
  }

  async previewNavigate(url: string): Promise<{ success: boolean; error?: string }> {
    if (!isAllowedBrowserURL(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http: and https: are allowed.' }
    }
    if (this.useMock) {
      this.previewState = { ...this.previewState, url }
      this.sendPreviewUpdate()
      return { success: true }
    }

    const view = this.ensurePreviewView()
    if (this.activeTabId) {
      const activeTab = this.tabs.get(this.activeTabId)
      if (activeTab?.view) {
        this.hideHost(activeTab.view)
      }
    }
    this.showHost(view, this.previewBounds)
    await view.webContents.loadURL(url)
    return { success: true }
  }

  previewGoBack(): { success: boolean; error?: string } {
    if (this.useMock) return { success: true }
    if (!this.previewView) return { success: false, error: 'Preview is not open' }
    if (this.previewView.webContents.navigationHistory.canGoBack()) {
      this.previewView.webContents.navigationHistory.goBack()
    }
    return { success: true }
  }

  previewGoForward(): { success: boolean; error?: string } {
    if (this.useMock) return { success: true }
    if (!this.previewView) return { success: false, error: 'Preview is not open' }
    if (this.previewView.webContents.navigationHistory.canGoForward()) {
      this.previewView.webContents.navigationHistory.goForward()
    }
    return { success: true }
  }

  previewReload(): { success: boolean; error?: string } {
    if (this.useMock) return { success: true }
    if (!this.previewView) return { success: false, error: 'Preview is not open' }
    this.previewView.webContents.reload()
    return { success: true }
  }

  previewUpdateBounds(bounds: { x: number; y: number; width: number; height: number }): { success: boolean } {
    this.previewBounds = bounds
    if (this.previewView) {
      this.applyPreviewBounds(this.previewView)
    }
    return { success: true }
  }

  previewClose(): { success: boolean } {
    if (this.previewView) {
      this.detachHost(this.previewView)
      this.previewView.webContents.close()
      this.previewView = null
    }
    this.previewState = {
      url: '',
      title: 'Preview',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    }
    this.sendPreviewUpdate()
    if (this.activeTabId) {
      const activeTab = this.tabs.get(this.activeTabId)
      if (activeTab?.view) {
        this.showHost(activeTab.view, this.viewBounds)
        this.applyBounds(activeTab.view)
      }
    }
    return { success: true }
  }

  previewGetState(): PreviewTabState {
    return { ...this.previewState }
  }

  detachPreviewView(): void {
    if (!this.previewView) return
    this.hideHost(this.previewView)
  }

  // ── Programmatic API (for tool calling, not IPC) ──────────────────

  /**
   * Create a new tab and navigate to URL. Returns the tab ID.
   */
  async createTab(url: string): Promise<{ success: boolean; tabId?: string; error?: string }> {
    if (!isAllowedBrowserURL(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http: and https: are allowed.' }
    }
    if (this.useMock) {
      const tabId = `tab-${++this.tabCounter}`
      const tab: Tab = {
        id: tabId,
        url,
        title: 'Mock Tab',
        domain: extractBrowserDomain(url),
        favicon: null,
        owner: 'manual',
        required: false,
        activity: 'idle',
        lastAuditedAt: null,
      }
      this.tabs.set(tabId, tab)
      this.activeTabId = tabId
      return { success: true, tabId }
    }

    const tabId = `tab-${++this.tabCounter}`

    const view = this.createHost('persist:browser')
    try {
      view.webContents.setUserAgent(this.browserUserAgent)
    } catch {
      // ignore user-agent sync failures
    }

    this.applyBounds(view)

    const tab: Tab = {
      id: tabId,
      url,
      title: 'Loading...',
      domain: extractBrowserDomain(url),
      favicon: null,
      owner: 'manual',
      required: false,
      activity: 'idle',
      lastAuditedAt: null,
      view,
    }
    this.tabs.set(tabId, tab)

    // -- Events --
    view.webContents.on('page-title-updated', (_, title) => {
      tab.title = title
      this.sendToRenderer('browser:tabUpdate', { type: 'title', tabId, title })
      this.emitTabMeta(tabId)
    })

    view.webContents.on('page-favicon-updated', (_, favicons) => {
      tab.favicon = Array.isArray(favicons) && favicons.length > 0 ? String(favicons[0] || '') : null
      this.emitTabMeta(tabId)
    })

    view.webContents.on('did-navigate', (_, newUrl) => {
      tab.url = newUrl
      tab.domain = extractBrowserDomain(newUrl)
      try {
        getDatabase().addHistoryEntry(newUrl, tab.title, {
          favicon: tab.favicon,
          transition: 'navigate',
          sessionId: tabId,
        })
      } catch {
        /* ignore */
      }
      this.sendToRenderer('browser:tabUpdate', {
        type: 'navigate',
        tabId,
        url: newUrl,
        canGoBack: view.webContents.navigationHistory.canGoBack(),
        canGoForward: view.webContents.navigationHistory.canGoForward(),
      })
      this.emitTabMeta(tabId)
    })

    view.webContents.on('did-navigate-in-page', (_, newUrl) => {
      tab.url = newUrl
      tab.domain = extractBrowserDomain(newUrl)
      this.sendToRenderer('browser:tabUpdate', {
        type: 'navigate',
        tabId,
        url: newUrl,
        canGoBack: view.webContents.navigationHistory.canGoBack(),
        canGoForward: view.webContents.navigationHistory.canGoForward(),
      })
      this.emitTabMeta(tabId)
    })

    view.webContents.on('did-start-loading', () => {
      this.sendToRenderer('browser:tabUpdate', { type: 'loading', tabId, loading: true })
    })

    view.webContents.on('did-stop-loading', () => {
      this.sendToRenderer('browser:tabUpdate', { type: 'loading', tabId, loading: false })
    })

    view.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
      this.logBrowserDiag(`[browser-v3][fail-load][tab:${tabId}] code=${String(errorCode)} message=${errorDescription}`)
      this.sendToRenderer('browser:tabUpdate', {
        type: 'error',
        tabId,
        error: `${errorDescription} (${errorCode})`,
      })
    })

    this.popupManager.bindWindow(view.webContents)
    this.bindAppShortcutBridge(view.webContents)
    view.webContents.setWindowOpenHandler((details) => this.handleWindowOpen(details, 'tab', view.webContents.id))
    this.installContextMenu(view.webContents)

    // Register download listener on the shared browser session (once)
    if (!this.downloadListenerRegistered) {
      const browserSession = view.webContents.session
      browserSession.on('will-download', (_, item) => {
        const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const filename = item.getFilename()
        const totalBytes = item.getTotalBytes()
        const startedAt = Math.floor(Date.now() / 1000)
        const mimeType = typeof item.getMimeType === 'function' ? item.getMimeType() : null
        const canResume = typeof item.canResume === 'function' ? item.canResume() : false

        try {
          getDatabase().addDownload({
            id: downloadId,
            url: item.getURL(),
            filename,
            save_path: item.getSavePath() || '',
            total_bytes: totalBytes,
            received_bytes: 0,
            state: 'progressing',
            mime_type: mimeType,
            end_time: null,
            can_resume: canResume,
          })
        } catch {
          /* ignore */
        }

        item.on('updated', (_ev, state) => {
          if (state === 'progressing') {
            const received = item.getReceivedBytes()
            try { getDatabase().updateDownloadProgress(downloadId, received) } catch { /* ignore */ }
            try {
              getDatabase().updateDownloadState(downloadId, 'progressing', {
                savePath: item.getSavePath() || '',
                mimeType,
                canResume: typeof item.canResume === 'function' ? item.canResume() : canResume,
              })
            } catch {
              /* ignore */
            }
            this.sendToRenderer('browser:downloadUpdate', {
              id: downloadId, filename, totalBytes, receivedBytes: received, state: 'progressing'
            })
          }
        })

        item.once('done', (_ev, state) => {
          const finalPath = item.getSavePath()
          if (state === 'completed') {
            try {
              getDatabase().updateDownloadProgress(downloadId, item.getReceivedBytes())
              getDatabase().updateDownloadState(downloadId, 'completed', {
                savePath: finalPath,
                mimeType,
                endTime: Math.max(startedAt, Math.floor(Date.now() / 1000)),
                error: null,
                canResume: typeof item.canResume === 'function' ? item.canResume() : canResume,
              })
            } catch { /* ignore */ }
          } else {
            try {
              getDatabase().updateDownloadProgress(downloadId, item.getReceivedBytes())
              getDatabase().updateDownloadState(downloadId, state, {
                savePath: finalPath,
                mimeType,
                endTime: Math.max(startedAt, Math.floor(Date.now() / 1000)),
                error: state,
                canResume: typeof item.canResume === 'function' ? item.canResume() : canResume,
              })
            } catch {
              /* ignore */
            }
          }
          this.sendToRenderer('browser:downloadUpdate', {
            id: downloadId, filename, totalBytes, receivedBytes: item.getReceivedBytes(), state
          })
        })
      })
      this.downloadListenerRegistered = true
    }

    // Hide old active view, show new one
    if (this.activeTabId) {
      const oldTab = this.tabs.get(this.activeTabId)
      if (oldTab?.view) {
        this.detachHost(oldTab.view)
      }
    }

    this.showHost(view, this.viewBounds)
    this.activeTabId = tabId

    view.webContents.loadURL(url).catch(() => { /* handled by did-fail-load event */ })
    return { success: true, tabId }
  }

  /**
   * Attach Chrome DevTools Protocol debugger to a tab's webContents.
   * Safe to call repeatedly.
   */
  async ensureDebugger(tabId: string | null): Promise<{ tabId: string }> {
    const { tabId: tid, view } = this.resolveTabView(tabId)
    try {
      if (!view.webContents.debugger.isAttached()) {
        view.webContents.debugger.attach('1.3')
      }
      return { tabId: tid }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.createBrowserError('DEBUGGER_ATTACH_FAILED', `Debugger attach failed: ${message}`)
    }
  }

  /**
   * Resolve viewport metrics in CSS pixels.
   * Prefers window.visualViewport and falls back to CDP layout metrics.
   */
  async getViewportMetrics(tabId: string | null): Promise<BrowserViewportMetrics> {
    const { view } = this.resolveTabView(tabId)
    let fromPage: Partial<BrowserViewportMetrics> | null = null

    try {
      const result = await view.webContents.executeJavaScript(
        `
          (() => {
            const vv = window.visualViewport
            if (!vv) return null
            return {
              width: Number(vv.width || window.innerWidth || 0),
              height: Number(vv.height || window.innerHeight || 0),
              pageX: Number(vv.pageLeft || window.scrollX || 0),
              pageY: Number(vv.pageTop || window.scrollY || 0),
              scale: Number(vv.scale || 1),
            }
          })()
        `,
        true,
      ) as Partial<BrowserViewportMetrics> | null
      if (
        result &&
        Number.isFinite(result.width) &&
        Number.isFinite(result.height) &&
        (result.width || 0) > 0 &&
        (result.height || 0) > 0
      ) {
        fromPage = result
      }
    } catch {
      fromPage = null
    }

    if (fromPage) {
      return {
        width: Number(fromPage.width),
        height: Number(fromPage.height),
        pageX: Number(fromPage.pageX || 0),
        pageY: Number(fromPage.pageY || 0),
        scale: Number(fromPage.scale || 1),
      }
    }

    await this.ensureDebugger(tabId)
    try {
      const layout = await view.webContents.debugger.sendCommand('Page.getLayoutMetrics') as {
        layoutViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number }
        visualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number; scale?: number }
      }

      const width = Number(
        layout.visualViewport?.clientWidth ||
        layout.layoutViewport?.clientWidth ||
        this.viewBounds.width,
      )
      const height = Number(
        layout.visualViewport?.clientHeight ||
        layout.layoutViewport?.clientHeight ||
        this.viewBounds.height,
      )
      return {
        width,
        height,
        pageX: Number(layout.visualViewport?.pageX || layout.layoutViewport?.pageX || 0),
        pageY: Number(layout.visualViewport?.pageY || layout.layoutViewport?.pageY || 0),
        scale: Number(layout.visualViewport?.scale || 1),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.createBrowserError('CDP_COMMAND_FAILED', `Page.getLayoutMetrics failed: ${message}`)
    }
  }

  /**
   * Map normalized coordinates (0..999) into CSS pixel coordinates in viewport.
   */
  async normalizedToCss(tabId: string | null, x: number, y: number): Promise<{
    x: number
    y: number
    width: number
    height: number
  }> {
    const metrics = await this.getViewportMetrics(tabId)
    const clamp = (value: number) => Math.max(0, Math.min(999, Number.isFinite(value) ? value : 0))
    const nx = clamp(x)
    const ny = clamp(y)

    const width = Math.max(1, Math.floor(metrics.width))
    const height = Math.max(1, Math.floor(metrics.height))
    const pixelX = Math.round((nx / 999) * (width - 1))
    const pixelY = Math.round((ny / 999) * (height - 1))
    return { x: pixelX, y: pixelY, width, height }
  }

  /**
   * Dispatch low-level mouse event through CDP.
   */
  async dispatchMouse(tabId: string | null, payload: BrowserMouseEventPayload): Promise<void> {
    const { view } = this.resolveTabView(tabId)
    await this.ensureDebugger(tabId)
    try {
      await view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: payload.type,
        x: payload.x,
        y: payload.y,
        button: payload.button || 'left',
        buttons: payload.buttons || 0,
        clickCount: payload.clickCount || 1,
        deltaX: payload.deltaX || 0,
        deltaY: payload.deltaY || 0,
        modifiers: payload.modifiers || 0,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.createBrowserError('CDP_COMMAND_FAILED', `Input.dispatchMouseEvent failed: ${message}`)
    }
  }

  /**
   * Dispatch low-level keyboard event through CDP.
   */
  async dispatchKey(tabId: string | null, payload: BrowserKeyEventPayload): Promise<void> {
    const { view } = this.resolveTabView(tabId)
    await this.ensureDebugger(tabId)
    try {
      await view.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: payload.type,
        key: payload.key || '',
        code: payload.code || '',
        text: payload.text || '',
        modifiers: payload.modifiers || 0,
        windowsVirtualKeyCode: payload.windowsVirtualKeyCode,
        nativeVirtualKeyCode: payload.nativeVirtualKeyCode,
        isKeypad: payload.isKeypad,
        autoRepeat: payload.autoRepeat,
        unmodifiedText: payload.unmodifiedText,
        location: payload.location,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.createBrowserError('CDP_COMMAND_FAILED', `Input.dispatchKeyEvent failed: ${message}`)
    }
  }

  /**
   * Insert text at current focus target via CDP.
   */
  async typeTextDirectly(
    tabId: string | null,
    text: string,
    options?: { useShiftEnterForNewline?: boolean },
  ): Promise<void> {
    const { view } = this.resolveTabView(tabId)
    await this.ensureDebugger(tabId)
    const useShiftEnterForNewline = options?.useShiftEnterForNewline === true

    try {
      if (!useShiftEnterForNewline || !text.includes('\n')) {
        await view.webContents.debugger.sendCommand('Input.insertText', { text })
        return
      }

      const segments = text.split('\n')
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i]
        if (segment.length > 0) {
          await view.webContents.debugger.sendCommand('Input.insertText', { text: segment })
        }
        if (i < segments.length - 1) {
          await this.dispatchKey(tabId, { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8 })
          await this.dispatchKey(tabId, { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 8 })
          await this.dispatchKey(tabId, { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 8 })
          await this.dispatchKey(tabId, { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0 })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.createBrowserError('CDP_COMMAND_FAILED', `Input.insertText failed: ${message}`)
    }
  }

  /**
   * Take screenshot in different modes.
   */
  async screenshotAdvanced(tabId: string | null, options?: BrowserScreenshotOptions): Promise<string> {
    const { view } = this.resolveTabView(tabId)
    const mode = options?.mode || 'viewport'

    if (mode === 'viewport') {
      const image = await view.webContents.capturePage()
      return image.toPNG().toString('base64')
    }

    await this.ensureDebugger(tabId)
    try {
      if (mode === 'clip' && options?.clip) {
        const result = await view.webContents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true,
          clip: {
            x: options.clip.x,
            y: options.clip.y,
            width: Math.max(1, options.clip.width),
            height: Math.max(1, options.clip.height),
            scale: 1,
          },
        }) as { data?: string }
        return String(result.data || '')
      }

      const layout = await view.webContents.debugger.sendCommand('Page.getLayoutMetrics') as {
        contentSize?: { width?: number; height?: number; x?: number; y?: number }
      }
      const clipWidth = Math.max(1, Math.ceil(Number(layout.contentSize?.width || this.viewBounds.width)))
      const clipHeight = Math.max(1, Math.ceil(Number(layout.contentSize?.height || this.viewBounds.height)))
      const result = await view.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: Number(layout.contentSize?.x || 0),
          y: Number(layout.contentSize?.y || 0),
          width: clipWidth,
          height: clipHeight,
          scale: 1,
        },
      }) as { data?: string }
      return String(result.data || '')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.createBrowserError('CDP_COMMAND_FAILED', `Page.captureScreenshot failed: ${message}`)
    }
  }

  /**
   * Execute JavaScript in a tab's webContents. Runs in BrowserView sandbox (isolated from Node).
   */
  async executeJS(tabId: string | null, code: string): Promise<unknown> {
    const { view } = this.resolveTabView(tabId)
    const result = await view.webContents.executeJavaScript(code, true)
    return result
  }

  /**
   * Get the plain text content of a page (document.body.innerText), truncated to 30K chars.
   */
  async getPageContent(tabId: string | null): Promise<string> {
    const text = await this.executeJS(tabId, 'document.body.innerText') as string
    if (typeof text !== 'string') return String(text ?? '')
    return text.slice(0, 30_000)
  }

  /**
   * Get the HTML content of a page (document.documentElement.outerHTML), truncated to 50K chars.
   */
  async getPageHTML(tabId: string | null): Promise<string> {
    const html = await this.executeJS(tabId, 'document.documentElement.outerHTML') as string
    if (typeof html !== 'string') return String(html ?? '')
    return html.slice(0, 50_000)
  }

  /**
   * Take a screenshot of the tab, returned as base64 PNG.
   */
  async screenshot(tabId: string | null): Promise<string> {
    return this.screenshotAdvanced(tabId, { mode: 'viewport' })
  }

  async findUploadTargets(tabId: string | null): Promise<BrowserUploadTarget[]> {
    const raw = await this.executeJS(tabId, `
      (() => {
        const out = []
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return rect.width >= 6 &&
            rect.height >= 6 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0
        }
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const keywordRe = /(upload|attach|image|photo|file|media|add|plus|drag|drop|上传|附件|图片|照片|文件|媒体|添加|导入|拖拽|选择)/i
        const iconishRe = /(upload|attach|image|photo|plus|paperclip|media|add|文件|上传|附件|图片|添加|回形针)/i
        const selectorFor = (el, fallbackTag = 'div') => {
          if (!(el instanceof Element)) return fallbackTag
          if (el.id) return '#' + CSS.escape(el.id)
          const name = el.getAttribute('name')
          if (el instanceof HTMLInputElement && el.type === 'file' && name) {
            return 'input[type="file"][name="' + CSS.escape(name) + '"]'
          }
          const tag = (el.tagName || fallbackTag).toLowerCase()
          let sameTagSiblings = 0
          let index = 0
          const parent = el.parentElement
          if (parent) {
            for (const child of Array.from(parent.children)) {
              if ((child.tagName || '').toLowerCase() === tag) {
                sameTagSiblings += 1
                if (child === el) index = sameTagSiblings
              }
            }
          }
          return sameTagSiblings > 1 ? tag + ':nth-of-type(' + Math.max(1, index) + ')' : tag
        }
        const findLinkedInput = (node) => {
          if (!node) return null
          if (node instanceof HTMLInputElement && node.type === 'file') return node
          if (node instanceof HTMLLabelElement && node.htmlFor) {
            const linked = document.getElementById(node.htmlFor)
            if (linked instanceof HTMLInputElement && linked.type === 'file') return linked
          }
          if (node instanceof HTMLElement) {
            const nested = node.querySelector('input[type="file"]')
            if (nested instanceof HTMLInputElement) return nested
            const root = node.closest('label,[role="button"],button,div,section,form')
            const deeper = root?.querySelector?.('input[type="file"]')
            if (deeper instanceof HTMLInputElement) return deeper
          }
          return null
        }
        const pushTarget = (target) => {
          if (!target || typeof target !== 'object') return
          const key = [target.kind, target.selectorHint, target.label, target.x, target.y].join('::')
          if (out.some((item) => [item.kind, item.selectorHint, item.label, item.x, item.y].join('::') === key)) return
          out.push(target)
        }
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
        inputs.slice(0, 24).forEach((input, index) => {
          const el = input
          const rect = el.getBoundingClientRect()
          const label =
            normalize(el.getAttribute('aria-label')) ||
            normalize(el.getAttribute('title')) ||
            normalize(el.getAttribute('name')) ||
            normalize(el.getAttribute('id')) ||
            normalize(el.closest('label')?.textContent) ||
            normalize(el.parentElement?.textContent) ||
            ('上传入口 ' + (index + 1))
          pushTarget({
            id: 'upload-' + (index + 1),
            kind: 'input',
            selectorHint: selectorFor(el, 'input[type="file"]'),
            label,
            accepts: normalize(el.getAttribute('accept')),
            multiple: el.hasAttribute('multiple'),
            hidden: !visible(el),
            confidence: visible(el) ? 0.96 : 0.72,
            evidence: ['input[type=file]'],
            x: rect.width > 0 ? Math.round(rect.left + rect.width / 2) : undefined,
            y: rect.height > 0 ? Math.round(rect.top + rect.height / 2) : undefined,
          })
        })

        const candidates = Array.from(document.querySelectorAll('button,label,[role="button"],div,section,a,span'))
        let launcherIndex = 0
        let dropzoneIndex = 0
        for (const node of candidates) {
          if (!(node instanceof HTMLElement) || !visible(node)) continue
          const rect = node.getBoundingClientRect()
          if (rect.width < 20 || rect.height < 20) continue
          const linkedInput = findLinkedInput(node)
          const meta = normalize([
            node.getAttribute('aria-label'),
            node.getAttribute('title'),
            node.getAttribute('data-testid'),
            node.getAttribute('class'),
            node.textContent,
          ].filter(Boolean).join(' '))
          const hasKeyword = keywordRe.test(meta)
          const iconish = iconishRe.test(meta)
          const dropzone = /(drag|drop|拖拽|拖入|放到这里|dropzone|upload-zone)/i.test(meta)
          if (!hasKeyword && !iconish && !linkedInput) continue
          const kind = dropzone ? 'dropzone' : 'launcher'
          const label = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || meta) ||
            (kind === 'dropzone' ? '拖拽上传区域' : '上传启动入口')
          const associatedInputSelector = linkedInput ? selectorFor(linkedInput, 'input[type="file"]') : undefined
          const confidenceBase = linkedInput ? 0.9 : hasKeyword ? 0.75 : 0.58
          const evidence = [
            hasKeyword ? 'keyword_match' : '',
            iconish ? 'iconish_meta' : '',
            linkedInput ? 'linked_file_input' : '',
            dropzone ? 'dropzone_pattern' : '',
          ].filter(Boolean)
          if (kind === 'launcher') launcherIndex += 1
          if (kind === 'dropzone') dropzoneIndex += 1
          pushTarget({
            id: kind === 'launcher' ? 'launcher-' + launcherIndex : 'dropzone-' + dropzoneIndex,
            kind,
            selectorHint: selectorFor(node),
            label,
            accepts: linkedInput ? normalize(linkedInput.getAttribute('accept')) : '',
            multiple: linkedInput ? linkedInput.hasAttribute('multiple') : false,
            hidden: false,
            confidence: confidenceBase,
            evidence,
            associatedInputSelector,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
          })
        }
        return out
          .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
          .slice(0, 32)
      })()
    `)
    return Array.isArray(raw) ? raw as BrowserUploadTarget[] : []
  }

  async setFileInputFiles(
    tabId: string | null,
    payload: {
      files: string[]
      selector?: string
      target?: string
      x?: number
      y?: number
    },
  ): Promise<{ ok: boolean; targetDescription: string; inputFound: boolean; filesAssigned?: boolean; assignedFileNames?: string[] }> {
    const { view } = this.resolveTabView(tabId)
    await this.ensureDebugger(tabId)
    const files = (payload.files || []).filter((item) => typeof item === 'string' && item.trim().length > 0)
    if (files.length === 0) {
      throw this.createBrowserError('CDP_COMMAND_FAILED', 'No files provided for upload')
    }

    const marker = `ready-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const selector = typeof payload.selector === 'string' ? payload.selector.trim() : ''
    const target = typeof payload.target === 'string' ? payload.target.trim() : ''
    const x = Number.isFinite(Number(payload.x)) ? Number(payload.x) : null
    const y = Number.isFinite(Number(payload.y)) ? Number(payload.y) : null

    const markResult = await this.executeJS(tabId, `
      (() => {
        const marker = ${JSON.stringify(marker)}
        const clearMarker = () => {
          document.querySelectorAll('[data-ready-upload-target]').forEach((node) => {
            if (node instanceof HTMLElement) node.removeAttribute('data-ready-upload-target')
          })
        }
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return rect.width >= 6 &&
            rect.height >= 6 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0
        }
        const toInput = (node) => {
          if (!node) return null
          if (node instanceof HTMLInputElement && node.type === 'file') return node
          if (node instanceof HTMLLabelElement) {
            if (node.htmlFor) {
              const linked = document.getElementById(node.htmlFor)
              if (linked instanceof HTMLInputElement && linked.type === 'file') return linked
            }
            const nested = node.querySelector('input[type="file"]')
            if (nested instanceof HTMLInputElement) return nested
          }
          if (node instanceof HTMLElement) {
            const nested = node.querySelector('input[type="file"]')
            if (nested instanceof HTMLInputElement) return nested
            const root = node.closest('label,[role="button"],button,div,section,form')
            const deeper = root?.querySelector?.('input[type="file"]')
            if (deeper instanceof HTMLInputElement) return deeper
          }
          return null
        }
        const chooseByTarget = (text) => {
          const wanted = normalize(text).toLowerCase()
          if (!wanted) return null
          const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
          let best = null
          let bestScore = -1
          for (const input of inputs) {
            const label = [
              input.getAttribute('aria-label'),
              input.getAttribute('title'),
              input.getAttribute('name'),
              input.getAttribute('id'),
              input.closest('label')?.textContent,
              input.parentElement?.textContent,
            ].map(normalize).join(' ').toLowerCase()
            let score = 0
            if (label.includes(wanted)) score += 10
            if (visible(input)) score += 3
            if (score > bestScore) {
              best = input
              bestScore = score
            }
          }
          return best
        }
        clearMarker()
        let input = null
        const selector = ${JSON.stringify(selector)}
        const target = ${JSON.stringify(target)}
        const pointX = ${x === null ? 'null' : JSON.stringify(x)}
        const pointY = ${y === null ? 'null' : JSON.stringify(y)}
        if (selector) {
          input = toInput(document.querySelector(selector))
        }
        if (!input && target) {
          input = chooseByTarget(target)
        }
        if (!input && Number.isFinite(pointX) && Number.isFinite(pointY)) {
          const node = document.elementFromPoint(pointX, pointY)
          input = toInput(node)
        }
        if (!input) {
          input = document.querySelector('input[type="file"]')
        }
        if (!(input instanceof HTMLInputElement)) {
          return { ok: false, targetDescription: target || selector || 'input[type=file]', inputFound: false }
        }
        input.setAttribute('data-ready-upload-target', marker)
        return {
          ok: true,
          targetDescription:
            normalize(input.getAttribute('aria-label')) ||
            normalize(input.getAttribute('title')) ||
            normalize(input.getAttribute('name')) ||
            normalize(input.getAttribute('id')) ||
            normalize(input.closest('label')?.textContent) ||
            target || selector || 'input[type=file]',
          inputFound: true,
        }
      })()
    `) as { ok?: boolean; targetDescription?: string; inputFound?: boolean } | null

    if (!markResult?.inputFound) {
      return {
        ok: false,
        targetDescription: markResult?.targetDescription || target || selector || 'input[type=file]',
        inputFound: false,
        filesAssigned: false,
        assignedFileNames: [],
      }
    }

    try {
      const documentNode = await view.webContents.debugger.sendCommand('DOM.getDocument', {
        depth: 2,
        pierce: true,
      }) as { root?: { nodeId?: number } }
      const rootNodeId = Number(documentNode.root?.nodeId || 0)
      const query = await view.webContents.debugger.sendCommand('DOM.querySelector', {
        nodeId: rootNodeId,
        selector: `[data-ready-upload-target="${marker}"]`,
      }) as { nodeId?: number }
      const nodeId = Number(query.nodeId || 0)
      if (!nodeId) {
        return {
          ok: false,
          targetDescription: markResult?.targetDescription || target || selector || 'input[type=file]',
          inputFound: false,
          filesAssigned: false,
          assignedFileNames: [],
        }
      }
      await view.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
        nodeId,
        files,
      })
      const assignmentResult = await this.executeJS(tabId, `
        (() => {
          const input = document.querySelector('[data-ready-upload-target="${marker}"]')
          if (!(input instanceof HTMLInputElement)) return { assigned: false, names: [] }
          const names = Array.from(input.files || []).map((file) => String(file.name || ''))
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
          input.removeAttribute('data-ready-upload-target')
          return { assigned: names.length > 0, names }
        })()
      `) as { assigned?: boolean; names?: string[] } | null
      return {
        ok: true,
        targetDescription: markResult?.targetDescription || target || selector || 'input[type=file]',
        inputFound: true,
        filesAssigned: Boolean(assignmentResult?.assigned),
        assignedFileNames: Array.isArray(assignmentResult?.names) ? assignmentResult.names.map((item) => String(item || '')) : [],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.createBrowserError('CDP_COMMAND_FAILED', `DOM.setFileInputFiles failed: ${message}`)
    }
  }

  /**
   * Navigate the active tab (or specified tab) to a URL.
   */
  async navigate(tabId: string | null, url: string): Promise<{ success: boolean; error?: string }> {
    if (!isAllowedBrowserURL(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http: and https: are allowed.' }
    }

    const tid = tabId || this.activeTabId
    // If no tabs exist, create one
    if (!tid) {
      return this.createTab(url)
    }

    const tab = this.tabs.get(tid)
    if (!tab?.view) return { success: false, error: 'Tab not found' }

    await tab.view.webContents.loadURL(url)
    return { success: true }
  }

  /**
   * Go back in the active tab.
   */
  goBack(tabId: string | null): { success: boolean; error?: string } {
    const tid = tabId || this.activeTabId
    if (!tid) return { success: false, error: 'No active tab' }
    const tab = this.tabs.get(tid)
    if (!tab?.view) return { success: false, error: 'Tab not found' }
    if (tab.view.webContents.navigationHistory.canGoBack()) {
      tab.view.webContents.navigationHistory.goBack()
    }
    return { success: true }
  }
}

export function setupBrowserIPC(mainWindow: BrowserWindow, useMock = false): BrowserController {
  const controller = new BrowserController(mainWindow, useMock)

  // Create new tab
  ipcMain.handle('browser:createTab', async (_, url: string) => {
    try {
      const result = await controller.createTab(url)
      if (!result.success) return result
      const tab = controller.tabs.get(result.tabId!)
      return { success: true, tabId: result.tabId, title: tab?.title || 'Loading...', mock: useMock }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Close tab
  ipcMain.handle('browser:closeTab', (_, tabId: string) => {
    try {
      const tab = controller.tabs.get(tabId)
      if (tab?.view) {
        controller.detachHost(tab.view)
        tab.view.webContents.close()
      }
      controller.tabs.delete(tabId)

      if (controller.activeTabId === tabId) {
        const remaining = Array.from(controller.tabs.values())
        if (remaining.length > 0) {
          const newTab = remaining[remaining.length - 1]
          if (newTab.view) {
            controller.showHost(newTab.view, controller.viewBounds)
            controller.applyBounds(newTab.view)
            controller.activeTabId = newTab.id
          }
        } else {
          controller.activeTabId = null
        }
      }

      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Switch tab
  ipcMain.handle('browser:switchTab', (_, tabId: string) => {
    try {
      const newTab = controller.tabs.get(tabId)
      if (!newTab?.view) return { success: false, error: 'Tab not found' }

      if (controller.activeTabId) {
        const oldTab = controller.tabs.get(controller.activeTabId)
        if (oldTab?.view) controller.detachHost(oldTab.view)
      }

      controller.showHost(newTab.view, controller.viewBounds)
      controller.applyBounds(newTab.view)
      controller.activeTabId = tabId

      return {
        success: true,
        url: newTab.url,
        title: newTab.title,
        domain: newTab.domain,
        favicon: newTab.favicon,
        owner: newTab.owner,
        required: newTab.required,
        activity: newTab.activity,
        lastAuditedAt: newTab.lastAuditedAt,
        canGoBack: newTab.view.webContents.navigationHistory.canGoBack(),
        canGoForward: newTab.view.webContents.navigationHistory.canGoForward(),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Navigate tab
  ipcMain.handle('browser:navigate', async (_, { tabId, url }: { tabId: string; url: string }) => {
    try {
      if (!isAllowedBrowserURL(url)) {
        return { success: false, error: `Blocked URL protocol. Only http: and https: are allowed.` }
      }

      const tab = controller.tabs.get(tabId)
      if (!tab?.view) return { success: false, error: 'Tab not found' }
      await tab.view.webContents.loadURL(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Go back
  ipcMain.handle('browser:goBack', (_, tabId: string) => {
    try {
      const tab = controller.tabs.get(tabId)
      if (!tab?.view) return { success: false, error: 'Tab not found' }
      if (tab.view.webContents.navigationHistory.canGoBack()) {
        tab.view.webContents.navigationHistory.goBack()
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Go forward
  ipcMain.handle('browser:goForward', (_, tabId: string) => {
    try {
      const tab = controller.tabs.get(tabId)
      if (!tab?.view) return { success: false, error: 'Tab not found' }
      if (tab.view.webContents.navigationHistory.canGoForward()) {
        tab.view.webContents.navigationHistory.goForward()
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Reload
  ipcMain.handle('browser:reload', (_, tabId: string) => {
    try {
      const tab = controller.tabs.get(tabId)
      if (!tab?.view) return { success: false, error: 'Tab not found' }
      tab.view.webContents.reload()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Update bounds
  ipcMain.handle('browser:updateBounds', (_, bounds: { x: number; y: number; width: number; height: number }) => {
    controller.viewBounds = bounds
    if (controller.activeTabId) {
      const tab = controller.tabs.get(controller.activeTabId)
      if (tab?.view) {
        controller.applyBounds(tab.view)
      }
    }
    return { success: true }
  })

  // Hide all BrowserViews
  ipcMain.handle('browser:hideAll', () => {
    if (controller.activeTabId) {
      const tab = controller.tabs.get(controller.activeTabId)
      if (tab?.view) {
        controller.hideHost(tab.view)
      }
    }
    controller.detachPreviewView()
    return { success: true }
  })

  // Show active BrowserView
  ipcMain.handle('browser:showActive', () => {
    controller.detachPreviewView()
    if (controller.activeTabId) {
      const tab = controller.tabs.get(controller.activeTabId)
      if (tab?.view) {
        controller.showHost(tab.view, controller.viewBounds)
        controller.applyBounds(tab.view)
      }
    }
    return { success: true }
  })

  // Get all tabs
  ipcMain.handle('browser:getTabs', () => {
    return controller.getTabList()
  })

  ipcMain.handle('browser:getAdblockState', () => {
    return { success: true, data: controller.getAdblockState() }
  })

  ipcMain.handle('browser:setAdblockEnabled', (_, payload: { enabled: boolean; scope?: 'main' | 'preview' | 'all' }) => {
    try {
      return { success: true, data: controller.setAdblockEnabled(Boolean(payload.enabled), payload.scope || 'all') }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:toggleAdblockDomain', (_, payload: { domain: string }) => {
    try {
      return { success: true, data: controller.toggleAdblockDomain(payload.domain) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Get current page context for a tab (title/url/selection/excerpt) for chat referencing.
  ipcMain.handle('browser:getTabContext', async (_, tabId?: string) => {
    try {
      const context = await controller.getTabContext(tabId)
      return { success: true, data: context }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // --- Preview BrowserView channel (used by RSS preview) ---
  ipcMain.handle('browser:previewOpen', async (_, payload: { url: string }) => {
    try {
      return await controller.previewOpen(payload.url)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:previewNavigate', async (_, payload: { url: string }) => {
    try {
      return await controller.previewNavigate(payload.url)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:previewGoBack', () => controller.previewGoBack())
  ipcMain.handle('browser:previewGoForward', () => controller.previewGoForward())
  ipcMain.handle('browser:previewReload', () => controller.previewReload())

  ipcMain.handle(
    'browser:previewUpdateBounds',
    (_, bounds: { x: number; y: number; width: number; height: number }) =>
      controller.previewUpdateBounds(bounds),
  )

  ipcMain.handle('browser:previewClose', () => controller.previewClose())
  ipcMain.handle('browser:previewGetState', () => controller.previewGetState())

  // --- Bookmarks ---
  ipcMain.handle('browser:addBookmark', (_, { url, title, favicon }: { url: string; title: string; favicon?: string }) => {
    try {
      const id = getDatabase().addBookmark(url, title, favicon)
      return { success: true, id }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:removeBookmark', (_, url: string) => {
    try {
      getDatabase().removeBookmarkByUrl(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:getBookmarks', () => {
    try {
      return { success: true, data: getDatabase().getBookmarks() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:isBookmarked', (_, url: string) => {
    try {
      return { success: true, bookmarked: getDatabase().isBookmarked(url) }
    } catch (error) {
      return { success: false, bookmarked: false }
    }
  })

  ipcMain.handle('browser:importBookmarks', async () => {
    return controller.importBookmarksFromDialog()
  })

  ipcMain.handle('browser:exportBookmarks', async () => {
    return controller.exportBookmarksToDialog()
  })

  // --- History ---
  ipcMain.handle('browser:getHistory', (_, limit?: number) => {
    try {
      return { success: true, data: getDatabase().getHistory(limit) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:clearHistory', () => {
    try {
      getDatabase().clearHistory()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:searchHistory', (_, query: string) => {
    try {
      return { success: true, data: getDatabase().searchHistory(query) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // --- Downloads ---
  ipcMain.handle('browser:getDownloads', () => {
    try {
      return { success: true, data: getDatabase().getDownloads() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('browser:clearDownloads', () => {
    try {
      getDatabase().clearDownloads()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // --- Print ---
  ipcMain.handle('browser:print', (_, tabId: string) => {
    try {
      const tab = controller.tabs.get(tabId)
      if (!tab?.view) return { success: false, error: 'Tab not found' }
      tab.view.webContents.print()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  return controller
}
