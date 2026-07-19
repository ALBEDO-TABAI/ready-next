import { BrowserWindow, dialog, session, type MessageBoxOptions } from 'electron'

import { BrowserDataService, normalizeDomainToken, type BrowserAdblockState } from './data-service'
import {
  BrowserSitePermissionRequestStore,
  resolveBrowserPermissionPath,
  type BrowserPermissionRequestBinding,
  type BrowserSitePermissionNotice,
  type BrowserSitePermissionRequestReadback,
} from './browser-permission-policy'
import type { BrowserWorkflowWriteTarget } from '../../../shared/browser-workflow-control'
import {
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
  resolveAgentPermissionBinding: (
    webContentsId: number | undefined,
    partition: string,
  ) => BrowserPermissionRequestBinding | null
  isAgentPermissionBindingLive: (binding: BrowserPermissionRequestBinding) => boolean
  /** 权限请求/判决落 ready-browser.log（真机第十二轮观测盲区）。 */
  logDiagnostics?: (message: string) => void
}


export class BrowserSessionPolicyService {
  private adblockState: BrowserAdblockState
  private adblockUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private lastAdblockRendererUpdateAt = 0
  private permissionDecisions = new Map<string, boolean>()
  private readonly permissionRequests = new BrowserSitePermissionRequestStore()

  constructor(private readonly deps: BrowserSessionPolicyDeps) {
    this.adblockState = deps.dataService.readAdblockState()
  }

  getAdblockState(): BrowserAdblockState {
    return {
      ...this.adblockState,
      whitelistDomains: [...this.adblockState.whitelistDomains],
    }
  }

  getSitePermissionRequest(requestId: string): BrowserSitePermissionRequestReadback {
    return this.permissionRequests.read(
      requestId,
      (binding) => this.deps.isAgentPermissionBindingLive(binding),
    )
  }

  applySitePermissionRequest(
    requestId: string,
    decision: 'allow' | 'deny',
  ): BrowserSitePermissionRequestReadback {
    const readback = this.permissionRequests.apply(
      requestId,
      decision,
      (binding) => this.deps.isAgentPermissionBindingLive(binding),
    )
    if (readback.applied && readback.target && readback.permission && readback.requestingUrl) {
      this.permissionDecisions.set(
        this.getPermissionDecisionKey(readback.target.partition, readback.permission, readback.requestingUrl),
        decision === 'allow',
      )
      this.logPermissionEvent(`agent_set=${decision} requestId=${requestId}`, readback.permission, readback.requestingUrl)
    }
    return readback
  }

  resetPermissionDecision(partition: string, permission: string, requestingUrl: string): Record<string, unknown> {
    this.permissionDecisions.delete(this.getPermissionDecisionKey(partition, permission, requestingUrl))
    this.logPermissionEvent('agent_reset', permission, requestingUrl)
    return {
      permission: String(permission || '').toLowerCase(),
      origin: this.formatRequestingOrigin(requestingUrl),
      decision: shouldAllowBrowserPermission(permission, requestingUrl) ? 'allow' : 'ask',
      source: 'policy',
    }
  }

  consumeSitePermissionNotices(target: BrowserWorkflowWriteTarget): BrowserSitePermissionNotice[] {
    return this.permissionRequests.consumeNotices(
      target,
      (binding) => this.deps.isAgentPermissionBindingLive(binding),
    )
  }

  expireSitePermissionRequestsForTab(tabId: string): void {
    this.permissionRequests.expireForTab(tabId)
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
    this.applyForPartition('persist:browser')
  }

  applyForPartition(partition: string): void {
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
        return this.permissionDecisions.get(
          this.getPermissionDecisionKey(partition, permission, requestingOrigin),
        ) === true
      })

      targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const requestingUrl = String(details?.requestingUrl || webContents.getURL() || '')
        const decisionKey = this.getPermissionDecisionKey(partition, permission, requestingUrl)
        const agentBinding = this.deps.resolveAgentPermissionBinding(webContents.id, partition)
        const path = resolveBrowserPermissionPath({
          permission,
          requestingUrl,
          cachedDecision: this.permissionDecisions.get(decisionKey),
          agentDriveActive: agentBinding !== null,
        })
        this.logPermissionEvent(`request path=${path}`, permission, requestingUrl)
        switch (path) {
          case 'auto_allow':
          case 'cached_allow':
            callback(true)
            return
          case 'unsupported_deny':
          case 'policy_deny':
          case 'cached_deny':
            callback(false)
            return
          case 'agent_suspend': {
            if (!agentBinding) {
              callback(false)
              return
            }
            this.permissionRequests.queue({
              permission,
              origin: this.formatRequestingOrigin(requestingUrl),
              requestingUrl,
              target: agentBinding,
              callback,
            })
            return
          }
          case 'prompt':
            void this.promptForPermission(permission, requestingUrl).then((allowed) => {
              this.logPermissionEvent(`decision=${allowed ? 'allow' : 'deny'}`, permission, requestingUrl)
              this.permissionDecisions.set(decisionKey, allowed)
              callback(allowed)
            }).catch(() => {
              this.logPermissionEvent('decision=deny reason=prompt_failed', permission, requestingUrl)
              this.permissionDecisions.set(decisionKey, false)
              callback(false)
            })
        }
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

  private getPermissionDecisionKey(partition: string, permission: string, requestingUrl?: string): string {
    try {
      const parsed = new URL(String(requestingUrl || ''))
      return `${partition}::${parsed.origin}::${String(permission || '').toLowerCase()}`
    } catch {
      return `${partition}::${String(requestingUrl || '')}::${String(permission || '').toLowerCase()}`
    }
  }

  private logPermissionEvent(event: string, permission: string, requestingUrl?: string): void {
    try {
      this.deps.logDiagnostics?.(
        `[browser-v3][permission] ${event} permission=${String(permission || '').toLowerCase()} origin=${this.formatRequestingHost(requestingUrl)}`,
      )
    } catch {
      // silent-catch: 诊断日志失败不得影响权限判决回调。
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

  private formatRequestingOrigin(requestingUrl?: string): string {
    try {
      return new URL(String(requestingUrl || '')).origin
    } catch {
      return String(requestingUrl || '')
    }
  }
}
