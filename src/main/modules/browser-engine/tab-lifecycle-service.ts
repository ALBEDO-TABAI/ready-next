import type { Session, WebContents } from 'electron'
import type { BrowserHostView, BrowserRect } from './host-types'
import type { BrowserTabMetaPayload } from './tab-meta-service'
import { isReadyBrowserBlankUrl } from '../../../shared/browser-defaults'
import {
  BROWSER_LOCAL_MEDIA_UPLOAD_EXTENSIONS,
} from '../../../shared/browser-local-media-upload'
import { READY_LOCAL_MEDIA_DROP_SCHEME } from '../../../shared/browser-local-media-drop'
import { buildWebQuoteRevealScript, textDirectiveFromUrl } from '../library-engine/web-quote-reveal'
import type {
  RegisterDormantBrowserTabsRequest,
  RegisterDormantBrowserTabsResult,
} from '../../../shared/browser-tab-session'

function applyRoundedViewport(_view: BrowserHostView): void {
  // Rounded clipping is handled at the native host view layer.
}

/**
 * Transient/placeholder titles that must never be persisted as a page's name in
 * history (they are the cause of the "Loading…" / "New Tab" history entries).
 */
function isPlaceholderTitle(title: string | null | undefined): boolean {
  const t = String(title || '').trim()
  if (!t) return true
  return /^(loading…?|loading\.\.\.|new tab|untitled|about:blank|新标签页|加载中…?)$/i.test(t)
}

export type BrowserLifecycleTabOwner = 'manual' | 'agent'
export type BrowserLifecycleTabActivity = 'idle' | 'running' | 'attention'

export interface BrowserLifecycleTabRecord {
  id: string
  url: string
  title: string
  domain: string
  favicon: string | null
  owner: BrowserLifecycleTabOwner
  required: boolean
  activity: BrowserLifecycleTabActivity
  lastAuditedAt: number | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  openerTabId?: string | null
  profile?: string | null
  view?: BrowserHostView
  restoreSnapshot?: {
    entries: Electron.NavigationEntry[]
    index: number
  } | null
}

interface BrowserWindowOpenDetails {
  url: string
  frameName?: string
  features?: string
  disposition?: string
  referrer?: { url?: string }
}

interface BrowserWindowOpenResult {
  action: 'allow' | 'deny'
  overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions
}

interface BrowserTabLifecycleHost {
  tabs: Map<string, BrowserLifecycleTabRecord>
  getActiveTabId(): string | null
  setActiveTabId(tabId: string | null): void
  setSplitTabId(tabId: string | null): void
  observeRestoredTabId(tabId: string): void
  getNextTabId(): string
  getViewBounds(): BrowserRect
  shouldPresentHosts(): boolean
  isAllowedUrl(url: string): boolean
  extractDomain(url: string): string
  createHost(partition: string): BrowserHostView
  resetPageBackground(view: BrowserHostView): void
  syncPageBackground(view: BrowserHostView): void
  applyBounds(view: BrowserHostView): void
  detachHost(view: BrowserHostView): void
  showHost(view: BrowserHostView, bounds: BrowserRect): void
  sendToRenderer(channel: 'browser:tabOpened', data: unknown): void
  queueTabUpdate(data: { type: string; tabId: string } & Record<string, unknown>): void
  buildTabPayload(tab: BrowserLifecycleTabRecord): BrowserTabMetaPayload
  emitTabMeta(tabId: string): void
  logBrowserDiag(message: string): void
  bindPopup(webContents: WebContents): void
  bindAppShortcutBridge(webContents: WebContents): void
  installContextMenu(webContents: WebContents): void
  handleWindowOpen(details: BrowserWindowOpenDetails, source: 'tab', sourceContentsId: number): BrowserWindowOpenResult
  ensureDownloadSession(targetSession: Session): void
  addHistoryEntry(url: string, title: string, metadata: {
    favicon: string | null
    transition?: string | null
    sessionId?: string | null
  }): void
  updateHistoryEntryTitle(url: string, title: string, favicon?: string | null): void
  handleLocalMediaDropNavigation(tabId: string, url: string): boolean
  preparePageObservation?(tabId: string): Promise<void>
  onTabLoadStateMayChange?(tabId: string, reason: string): void
  browserUserAgent: string
  useMock: boolean
}

export function buildLocalMediaDropBridgeScript(): string {
  const mediaExts = JSON.stringify(Array.from(BROWSER_LOCAL_MEDIA_UPLOAD_EXTENSIONS))
  const dropScheme = JSON.stringify(READY_LOCAL_MEDIA_DROP_SCHEME)
  return `
    (() => {
      if (window.__readyLocalMediaDropBridgeInstalled) return true;
      Object.defineProperty(window, '__readyLocalMediaDropBridgeInstalled', {
        value: true,
        configurable: true,
      });
      const mediaExts = new Set(${mediaExts});
      const dropScheme = ${dropScheme};
      const mimeTypes = [
        'application/x-ready-drag',
        'application/x-ready-file',
        'application/x-ready-document-tab',
        'application/x-ready-workspace-item',
      ];
      let lastDropSignature = '';
      let lastDropAt = 0;
      const cleanExt = (value) => String(value || '').trim().toLowerCase().replace(/^\\./, '');
      const extForPath = (path) => {
        try {
          const parsed = new URL(String(path || ''), window.location.href);
          return cleanExt(parsed.pathname.split(/[\\\\/]/).pop().split('.').pop());
        } catch {
          return cleanExt(String(path || '').split(/[\\\\/]/).pop().split('.').pop());
        }
      };
      const isMediaPath = (path) => Boolean(path) && mediaExts.has(extForPath(path));
      const isLikelyRemoteMediaUrl = (value) => {
        try {
          const url = new URL(String(value || ''), window.location.href);
          return (url.protocol === 'http:' || url.protocol === 'https:') && isMediaPath(url.href);
        } catch {
          return false;
        }
      };
      const pushRemoteUrl = (urls, value) => {
        const raw = String(value || '').trim();
        if (!raw || urls.length >= 1) return;
        try {
          const url = new URL(raw, window.location.href);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
          if (!urls.includes(url.href)) urls.push(url.href);
        } catch {}
      };
      const fileUrlToPath = (value) => {
        try {
          const url = new URL(value);
          if (url.protocol !== 'file:') return null;
          return decodeURIComponent(url.pathname || '');
        } catch {
          return null;
        }
      };
      const pushPath = (paths, value) => {
        const raw = String(value || '').trim();
        if (!raw) return;
        const fromFileUrl = raw.startsWith('file:') ? fileUrlToPath(raw) : null;
        const path = fromFileUrl || raw;
        if (!path.startsWith('/') || !isMediaPath(path) || paths.includes(path)) return;
        paths.push(path);
      };
      const parseReadyPayload = (raw, paths) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw);
          const items = parsed && parsed.type === 'batch' && Array.isArray(parsed.items)
            ? parsed.items
            : [parsed];
          for (const item of items) {
            if (item && item.type !== 'folder' && !item.isDirectory) pushPath(paths, item.path);
          }
        } catch {}
      };
      const collectPaths = (dataTransfer) => {
        const paths = [];
        if (!dataTransfer) return paths;
        for (const type of mimeTypes) parseReadyPayload(dataTransfer.getData(type), paths);
        const uriList = dataTransfer.getData('text/uri-list') || '';
        for (const line of uriList.split(/\\r?\\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          pushPath(paths, trimmed);
        }
        const text = dataTransfer.getData('text/plain') || '';
        for (const line of text.split(/\\r?\\n/)) pushPath(paths, line);
        return paths;
      };
      const collectRemoteUrlsFromHtml = (html, urls) => {
        if (!html || urls.length > 0) return;
        try {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const image = doc.querySelector('img[src], img[srcset], source[srcset]');
          if (image) {
            const srcset = image.getAttribute('srcset') || '';
            const srcsetCandidates = srcset.split(',').map((candidate) => candidate.trim().split(/\\s+/)[0]).filter(Boolean);
            pushRemoteUrl(urls, srcsetCandidates[srcsetCandidates.length - 1] || image.getAttribute('src') || '');
          }
          if (urls.length === 0) {
            const link = Array.from(doc.querySelectorAll('a[href]'))
              .map((node) => node.getAttribute('href') || '')
              .find(isLikelyRemoteMediaUrl);
            pushRemoteUrl(urls, link || '');
          }
        } catch {
          const srcLike = /(?:src|href)=["']([^"']+)["']/gi;
          let match;
          while (urls.length === 0 && (match = srcLike.exec(html))) pushRemoteUrl(urls, match[1]);
        }
      };
      const collectRemoteUrls = (dataTransfer) => {
        const urls = [];
        if (!dataTransfer) return urls;
        const uriList = dataTransfer.getData('text/uri-list') || '';
        for (const line of uriList.split(/\\r?\\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          if (isLikelyRemoteMediaUrl(trimmed)) pushRemoteUrl(urls, trimmed);
        }
        const text = dataTransfer.getData('text/plain') || '';
        for (const line of text.split(/\\r?\\n/)) {
          if (urls.length > 0) break;
          if (isLikelyRemoteMediaUrl(line)) pushRemoteUrl(urls, line);
        }
        collectRemoteUrlsFromHtml(dataTransfer.getData('text/html') || '', urls);
        return urls;
      };
      const isDuplicateDrop = (paths, urls) => {
        const signature = JSON.stringify({ paths, urls });
        const now = Date.now();
        if (signature === lastDropSignature && now - lastDropAt < 2500) return true;
        lastDropSignature = signature;
        lastDropAt = now;
        return false;
      };
      const hasReadyLocalDragType = (dataTransfer) => {
        const types = Array.from(dataTransfer?.types || []);
        return types.some((type) => (
          mimeTypes.includes(type) ||
          type === 'text/uri-list' ||
          type === 'text/html' ||
          type === 'text/plain'
        ));
      };
      document.addEventListener('dragover', (event) => {
        if (!hasReadyLocalDragType(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      }, true);
      document.addEventListener('drop', (event) => {
        const paths = collectPaths(event.dataTransfer);
        const urls = collectRemoteUrls(event.dataTransfer);
        if (paths.length === 0 && urls.length === 0) return;
        if (isDuplicateDrop(paths, urls)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const payload = encodeURIComponent(JSON.stringify({
          paths,
          urls,
          x: Math.round(Number(event.clientX) || 0),
          y: Math.round(Number(event.clientY) || 0),
        }));
        window.location.href = dropScheme + '//upload?payload=' + payload;
      }, true);
      return true;
    })()
  `
}

export class BrowserTabLifecycleService {
  constructor(private readonly host: BrowserTabLifecycleHost) {}

  registerDormantTabs(request: RegisterDormantBrowserTabsRequest): RegisterDormantBrowserTabsResult {
    if (this.host.tabs.size > 0) {
      return { success: false, error: 'Browser runtime is already initialized.' }
    }
    const inputTabs = Array.isArray(request?.tabs) ? request.tabs : []
    const seen = new Set<string>()
    for (const input of inputTabs) {
      if (seen.size >= 200) break
      const id = String(input?.id || '').trim()
      const url = String(input?.url || '').trim()
      if (!id || seen.has(id) || !this.host.isAllowedUrl(url)) continue
      const profile = String(input.profile || '').trim().toLowerCase()
      if (profile && !/^[a-z0-9_-]{1,32}$/.test(profile)) continue
      seen.add(id)
      this.host.observeRestoredTabId(id)
      this.host.tabs.set(id, {
        id,
        url,
        title: String(input.title || 'New Tab'),
        domain: String(input.domain || this.host.extractDomain(url)),
        favicon: input.favicon ? String(input.favicon) : null,
        owner: input.owner === 'agent' ? 'agent' : 'manual',
        required: Boolean(input.required),
        activity: input.activity === 'running' || input.activity === 'attention' ? input.activity : 'idle',
        lastAuditedAt: typeof input.lastAuditedAt === 'number' ? input.lastAuditedAt : null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        profile: profile || null,
        restoreSnapshot: null,
      })
    }
    if (this.host.tabs.size === 0) return { success: false, error: 'No restorable browser tabs.' }

    const firstTabId = this.host.tabs.keys().next().value as string
    const activeTabId = request.activeTabId && this.host.tabs.has(request.activeTabId)
      ? request.activeTabId
      : firstTabId
    const splitTabId = request.splitTabId
      && request.splitTabId !== activeTabId
      && this.host.tabs.has(request.splitTabId)
      ? request.splitTabId
      : null
    this.host.setActiveTabId(activeTabId)
    this.host.setSplitTabId(splitTabId)

    const materializedTabIds: string[] = []
    const activeResult = this.materializeTab(activeTabId, { activate: true })
    if (!activeResult.success) {
      return { success: false, error: activeResult.error || 'Active tab restore failed.' }
    }
    materializedTabIds.push(activeTabId)
    let restoredSplitTabId = splitTabId
    if (splitTabId) {
      const splitResult = this.materializeTab(splitTabId)
      if (splitResult.success) materializedTabIds.push(splitTabId)
      else {
        restoredSplitTabId = null
        this.host.setSplitTabId(null)
      }
    }
    return {
      success: true,
      activeTabId,
      splitTabId: restoredSplitTabId,
      materializedTabIds,
      dormantTabIds: [...this.host.tabs.keys()].filter((id) => !materializedTabIds.includes(id)),
    }
  }

  async createTab(
    url: string,
    options?: { background?: boolean; openerTabId?: string | null; profile?: string | null; owner?: 'manual' | 'agent' },
  ): Promise<{ success: boolean; tabId?: string; error?: string }> {
    if (!this.host.isAllowedUrl(url)) {
      return { success: false, error: 'Blocked URL protocol. Only http:, https:, and local HTML files are allowed.' }
    }
    // background tabs (e.g. the agent collection tab) load WITHOUT becoming the
    // active tab or being presented, so they never preempt the user's foreground
    // (Codex result-review #4 — no flicker from create-then-switch-back).
    const background = options?.background === true

    const tabId = this.host.getNextTabId()
    if (this.host.useMock) {
      const tab: BrowserLifecycleTabRecord = {
        id: tabId,
        url,
        title: 'Mock Tab',
        domain: this.host.extractDomain(url),
        favicon: null,
        owner: options?.owner === 'agent' ? 'agent' : 'manual',
        required: options?.owner === 'agent',
        activity: options?.owner === 'agent' ? 'running' : 'idle',
        lastAuditedAt: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        openerTabId: options?.openerTabId ?? null,
        profile: options?.profile ?? null,
      }
      this.host.tabs.set(tabId, tab)
      if (!background) this.host.setActiveTabId(tabId)
      this.emitTabOpened(tab, background)
      return { success: true, tabId }
    }

    const profile = String(options?.profile || '').trim().toLowerCase()
    if (profile && !/^[a-z0-9_-]{1,32}$/.test(profile)) {
      return { success: false, error: 'Invalid browser profile name.' }
    }
    const tab: BrowserLifecycleTabRecord = {
      id: tabId,
      url,
      title: 'Loading...',
      domain: this.host.extractDomain(url),
      favicon: null,
      owner: options?.owner === 'agent' ? 'agent' : 'manual',
      required: options?.owner === 'agent',
      activity: options?.owner === 'agent' ? 'running' : 'idle',
      lastAuditedAt: null,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      error: null,
      openerTabId: options?.openerTabId ?? null,
      profile: profile || null,
      restoreSnapshot: null,
    }
    this.host.tabs.set(tabId, tab)
    const materialized = this.materializeTab(tabId, { activate: !background })
    if (!materialized.success) {
      this.host.tabs.delete(tabId)
      return materialized
    }
    this.emitTabOpened(tab, background)
    return { success: true, tabId }
  }

  materializeTab(
    tabId: string,
    options: { activate?: boolean } = {},
  ): { success: boolean; tabId?: string; error?: string } {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return { success: false, error: 'Tab not found' }
    if (tab.view) {
      if (options.activate) this.host.setActiveTabId(tabId)
      return { success: true, tabId }
    }
    const profile = String(tab.profile || '').trim().toLowerCase()
    if (profile && !/^[a-z0-9_-]{1,32}$/.test(profile)) {
      return { success: false, error: 'Invalid browser profile name.' }
    }
    if (this.host.useMock) {
      if (options.activate) this.host.setActiveTabId(tabId)
      return { success: true, tabId }
    }

    const previousTab = this.host.getActiveTabId()
      ? this.host.tabs.get(this.host.getActiveTabId() as string) || null
      : null
    const previousView = previousTab?.view || null
    const view = this.host.createHost(profile ? `persist:browser-profile-${profile}` : 'persist:browser')
    try {
      view.webContents.setUserAgent(this.host.browserUserAgent)
    } catch {
      // ignore user-agent sync failures
    }

    this.host.applyBounds(view)
    // No primer navigation before the real URL. The old data:-blank primer made
    // every tab a double navigation; when the real URL's speculative renderer
    // died at spawn (flaky seatbelt init under concurrent restore bursts), the
    // committed-primer + dead-speculative combination walked Chromium's early
    // RenderFrameHost swap into a bare CHECK in ~RenderFrameHostImpl and took
    // the whole main process down (2026-07-04 startup crash). A single
    // navigation keeps renderer spawn failures contained to their own tab.
    // White-flash protection is native paint instead of a navigated page.
    this.host.resetPageBackground(view)

    tab.view = view
    tab.loading = true
    tab.error = null
    this.host.onTabLoadStateMayChange?.(tabId, 'created')

    this.bindTabEvents(tabId, tab, view)

    this.host.bindPopup(view.webContents)
    this.host.bindAppShortcutBridge(view.webContents)
    view.webContents.setWindowOpenHandler((details) => this.host.handleWindowOpen(details, 'tab', view.webContents.id))
    this.host.installContextMenu(view.webContents)
    this.host.ensureDownloadSession(view.webContents.session)

    let resolvedSwap = false
    const finalizeSwap = (shouldShow: boolean) => {
      if (resolvedSwap) return
      resolvedSwap = true
      if (this.host.getActiveTabId() !== tabId) return
      if (previousView) {
        this.host.detachHost(previousView)
      }
      if (shouldShow && this.host.shouldPresentHosts()) {
        this.host.showHost(view, this.host.getViewBounds())
      }
    }

    view.webContents.once('did-stop-loading', () => {
      finalizeSwap(true)
    })
    view.webContents.once('did-fail-load', () => {
      // Even when a page reports a load failure, we still need to swap the
      // new host into view so the renderer can show the page's own error state
      // instead of leaving a blank container.
      finalizeSwap(true)
    })

    // background: do NOT activate or present. finalizeSwap no-ops while the tab
    // isn't active, so did-stop-loading won't show it either; the page still
    // loads in the background. Switching to it later (user choice) presents it.
    if (options.activate) {
      this.host.setActiveTabId(tabId)
      this.host.onTabLoadStateMayChange?.(tabId, 'activated')
      finalizeSwap(true)
    }
    try {
      if (tab.restoreSnapshot) {
        view.webContents.navigationHistory.restore({
          entries: tab.restoreSnapshot.entries,
          index: tab.restoreSnapshot.index,
        })
      } else {
        // fire-and-forget: load failures surface via did-fail-load.
        void view.webContents.loadURL(tab.url).catch(() => undefined)
        // Network tracking (W7 network idle) starts alongside the first load and never gates it: on a page that has
        // not navigated yet Network.enable waits for the renderer, and gating the load on it left every new tab
        // blank. A failure only means the next wait retries tracking.
        void this.host.preparePageObservation?.(tabId)?.catch(error => {
          console.warn('[browser] network tracking not started; waits retry it', tabId, error instanceof Error ? error.message : String(error))
        })
      }
    } catch (error) {
      this.host.detachHost(view)
      view.webContents.close?.()
      tab.view = undefined
      tab.loading = false
      tab.error = error instanceof Error ? error.message : String(error)
      this.host.onTabLoadStateMayChange?.(tabId, 'restore-failed')
      return { success: false, error: `Tab restore failed: ${tab.error}` }
    }
    return { success: true, tabId }
  }

  // Every successful create announces its record, including calls made outside
  // the renderer's tab actions. Background tabs must never preempt focus.
  private emitTabOpened(tab: BrowserLifecycleTabRecord, background: boolean): void {
    this.host.sendToRenderer('browser:tabOpened', {
      ...this.host.buildTabPayload(tab),
      activate: !background,
    })
  }

  private bindTabEvents(tabId: string, tab: BrowserLifecycleTabRecord, view: BrowserHostView): void {
    view.webContents.on('dom-ready', () => {
      applyRoundedViewport(view)
      this.host.syncPageBackground(view)
      void view.webContents.executeJavaScript(buildLocalMediaDropBridgeScript(), true).catch((error) => {
        this.host.logBrowserDiag(`[browser-v3][local-media-drop][tab:${tabId}] inject failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      // A source page's "原文" link carries a text directive that Electron does not apply; reveal the quote here.
      const directive = textDirectiveFromUrl(view.webContents.getURL())
      if (directive) void view.webContents.executeJavaScript(buildWebQuoteRevealScript(directive)).catch((error) => {
        this.host.logBrowserDiag(`[browser-v3][quote-reveal][tab:${tabId}] failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    view.webContents.on('audio-state-changed', () => {
      this.host.onTabLoadStateMayChange?.(tabId, 'audio-state-changed')
    })

    view.webContents.on('before-input-event', () => {
      this.host.onTabLoadStateMayChange?.(tabId, 'user-input')
    })

    view.webContents.on('will-navigate', (event, url) => {
      if (this.host.handleLocalMediaDropNavigation(tabId, url)) {
        event.preventDefault()
      }
    })

    view.webContents.on('page-title-updated', (_event, title) => {
      tab.title = title
      this.host.queueTabUpdate({ type: 'title', tabId, title })
      this.host.emitTabMeta(tabId)
      // Backfill the history row written at did-navigate time, when the new
      // page's real title was not yet known (it was still the previous page's
      // title or a "Loading…"/"New Tab" placeholder).
      if (!isReadyBrowserBlankUrl(tab.url) && !isPlaceholderTitle(title)) {
        try {
          this.host.updateHistoryEntryTitle(tab.url, title, tab.favicon)
        } catch {
          // ignore history write failures
        }
      }
    })

    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = Array.isArray(favicons) && favicons.length > 0 ? String(favicons[0] || '') : null
      this.host.emitTabMeta(tabId)
    })

    view.webContents.on('did-navigate', (_event, newUrl) => {
      tab.url = newUrl
      tab.domain = this.host.extractDomain(newUrl)
      tab.canGoBack = view.webContents.navigationHistory.canGoBack()
      tab.canGoForward = view.webContents.navigationHistory.canGoForward()
      tab.error = null
      if (!isReadyBrowserBlankUrl(newUrl)) {
        try {
          // At navigation-commit time the new document's title has not loaded
          // yet (`tab.title` still holds the previous page's title or a
          // placeholder), so persist an empty title and let page-title-updated
          // backfill the real one; the menu falls back to the URL until then.
          this.host.addHistoryEntry(newUrl, '', {
            favicon: tab.favicon,
            transition: 'navigate',
            sessionId: tabId,
          })
        } catch {
          // ignore history write failures
        }
      }
      this.emitNavigationState(tabId, tab, view, newUrl)
      this.host.syncPageBackground(view)
    })

    view.webContents.on('did-navigate-in-page', (_event, newUrl) => {
      tab.url = newUrl
      tab.domain = this.host.extractDomain(newUrl)
      tab.canGoBack = view.webContents.navigationHistory.canGoBack()
      tab.canGoForward = view.webContents.navigationHistory.canGoForward()
      tab.error = null
      this.emitNavigationState(tabId, tab, view, newUrl)
      this.host.syncPageBackground(view)
    })

    view.webContents.on('did-start-loading', () => {
      this.host.resetPageBackground(view)
      tab.loading = true
      this.host.queueTabUpdate({ type: 'loading', tabId, loading: true })
      this.host.onTabLoadStateMayChange?.(tabId, 'load-started')
    })

    view.webContents.on('did-stop-loading', () => {
      applyRoundedViewport(view)
      this.host.syncPageBackground(view)
      tab.loading = false
      tab.canGoBack = view.webContents.navigationHistory.canGoBack()
      tab.canGoForward = view.webContents.navigationHistory.canGoForward()
      this.host.queueTabUpdate({ type: 'loading', tabId, loading: false })
      this.host.emitTabMeta(tabId)
      this.host.onTabLoadStateMayChange?.(tabId, 'load-stopped')
    })

    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      if (errorCode === -3) return
      this.host.logBrowserDiag(`[browser-v3][fail-load][tab:${tabId}] code=${String(errorCode)} message=${errorDescription}`)
      tab.loading = false
      tab.error = `${errorDescription} (${errorCode})`
      this.host.queueTabUpdate({
        type: 'error',
        tabId,
        error: `${errorDescription} (${errorCode})`,
      })
      this.host.emitTabMeta(tabId)
      this.host.onTabLoadStateMayChange?.(tabId, 'load-failed')
    })
  }

  private emitNavigationState(
    tabId: string,
    tab: BrowserLifecycleTabRecord,
    view: BrowserHostView,
    url: string,
  ): void {
    this.host.queueTabUpdate({
      type: 'navigate',
      tabId,
      url,
      canGoBack: view.webContents.navigationHistory.canGoBack(),
      canGoForward: view.webContents.navigationHistory.canGoForward(),
    })
    this.host.emitTabMeta(tabId)
  }
}
