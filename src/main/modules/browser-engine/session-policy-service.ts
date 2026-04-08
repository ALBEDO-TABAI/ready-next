import { BrowserWindow, dialog, session, type MessageBoxOptions } from 'electron'

import { BrowserDataService, normalizeDomainToken, type BrowserAdblockState } from './data-service'
import {
  requiresUserApprovalBrowserPermission,
  shouldAllowBrowserPermission,
  supportsBrowserPermissionRequest,
} from './popup-policy'

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

interface BrowserSessionPolicyDeps {
  dataService: BrowserDataService
  sendToRenderer: (channel: string, data: unknown) => void
  resolveOriginDomain: (webContentsId?: number) => string
  isPreviewWebContentsId: (webContentsId?: number) => boolean
  getMainWindow: () => BrowserWindow | null
}

export class BrowserSessionPolicyService {
  private adblockState: BrowserAdblockState
  private adblockUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private lastAdblockRendererUpdateAt = 0
  private permissionDecisions = new Map<string, boolean>()

  constructor(private readonly deps: BrowserSessionPolicyDeps) {
    this.adblockState = deps.dataService.readAdblockState()
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

  setupBrowserSessionPolicies(): void {
    const applyForPartition = (partition: string): void => {
      const targetSession = session.fromPartition(partition)
      const marker = targetSession as unknown as {
        __readyBrowserPolicyApplied?: boolean
        __readyBrowserAdblockApplied?: boolean
      }
      if (marker.__readyBrowserPolicyApplied) return
      marker.__readyBrowserPolicyApplied = true

      targetSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
        if (!supportsBrowserPermissionRequest(permission)) return false
        if (shouldAllowBrowserPermission(permission, requestingOrigin)) return true
        return this.permissionDecisions.get(this.getPermissionDecisionKey(permission, requestingOrigin)) === true
      })

      targetSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const requestingUrl = webContents.getURL()
        if (!supportsBrowserPermissionRequest(permission)) {
          callback(false)
          return
        }
        if (shouldAllowBrowserPermission(permission, requestingUrl)) {
          callback(true)
          return
        }
        if (!requiresUserApprovalBrowserPermission(permission)) {
          callback(false)
          return
        }

        const decisionKey = this.getPermissionDecisionKey(permission, requestingUrl)
        const existingDecision = this.permissionDecisions.get(decisionKey)
        if (existingDecision !== undefined) {
          callback(existingDecision)
          return
        }

        void this.promptForPermission(permission, requestingUrl).then((allowed) => {
          this.permissionDecisions.set(decisionKey, allowed)
          callback(allowed)
        }).catch(() => {
          this.permissionDecisions.set(decisionKey, false)
          callback(false)
        })
      })

      if (!marker.__readyBrowserAdblockApplied) {
        marker.__readyBrowserAdblockApplied = true
        targetSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
          try {
            const shouldBlock = this.shouldBlockAdRequest(
              details.url,
              details.resourceType || '',
              this.deps.resolveOriginDomain(details.webContentsId),
              this.deps.isPreviewWebContentsId(details.webContentsId),
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

    applyForPartition('persist:browser')
    applyForPartition('persist:browser-preview')
  }

  private persistAdblockState(): void {
    this.deps.dataService.persistAdblockState(this.adblockState)
  }

  private scheduleAdblockRendererUpdate(force = false): void {
    const now = Date.now()
    if (force || now - this.lastAdblockRendererUpdateAt >= 400) {
      this.lastAdblockRendererUpdateAt = now
      this.deps.sendToRenderer('browser:adblockUpdate', this.getAdblockState())
      return
    }
    if (this.adblockUpdateTimer) return
    this.adblockUpdateTimer = setTimeout(() => {
      this.adblockUpdateTimer = null
      this.lastAdblockRendererUpdateAt = Date.now()
      this.deps.sendToRenderer('browser:adblockUpdate', this.getAdblockState())
    }, 420)
  }

  private rememberBlockedAdRequest(): void {
    this.adblockState.networkBlockedCount += 1
    if (this.adblockState.networkBlockedCount % 10 === 0) {
      this.deps.dataService.persistAdblockBlockedCount(this.adblockState.networkBlockedCount)
    }
    this.scheduleAdblockRendererUpdate()
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

  private getPermissionDecisionKey(permission: string, requestingUrl?: string): string {
    try {
      const parsed = new URL(String(requestingUrl || ''))
      return `${parsed.origin}::${String(permission || '').toLowerCase()}`
    } catch {
      return `${String(requestingUrl || '')}::${String(permission || '').toLowerCase()}`
    }
  }

  private async promptForPermission(permission: string, requestingUrl?: string): Promise<boolean> {
    const mainWindow = this.deps.getMainWindow()
    const dialogOptions: MessageBoxOptions = {
      type: 'question',
      buttons: ['允许', '拒绝'] as string[],
      defaultId: 1,
      cancelId: 1,
      title: '站点权限请求',
      message: `${this.formatRequestingHost(requestingUrl)} 想要使用${this.formatPermissionLabel(permission)}`,
      detail: 'Ready 不会默认静默放行高风险站点权限。本次允许只对当前运行期生效。',
      noLink: true,
    }
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions)
    return result.response === 0
  }

  private formatPermissionLabel(permission: string): string {
    switch (String(permission || '').toLowerCase()) {
      case 'camera':
        return '摄像头'
      case 'microphone':
      case 'media':
        return '麦克风'
      case 'geolocation':
        return '定位'
      case 'notifications':
        return '通知'
      case 'clipboard-read':
        return '读取剪贴板'
      case 'hid':
        return 'HID 设备'
      case 'serial':
        return '串口设备'
      case 'midi':
        return 'MIDI 设备'
      case 'window-management':
        return '窗口管理能力'
      case 'identity-credentials-get':
        return '身份凭据'
      default:
        return String(permission || '该权限')
    }
  }

  private formatRequestingHost(requestingUrl?: string): string {
    try {
      const parsed = new URL(String(requestingUrl || ''))
      return parsed.hostname || parsed.origin || '当前站点'
    } catch {
      return '当前站点'
    }
  }
}
