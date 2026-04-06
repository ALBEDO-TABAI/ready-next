import { session } from 'electron'

import { getUrlHostname } from '../../../shared/url-utils'
import { BrowserDataService, normalizeDomainToken, type BrowserAdblockState } from './data-service'
import { shouldAllowBrowserPermission } from './popup-policy'

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

interface BrowserSessionPolicyDeps {
  dataService: BrowserDataService
  sendToRenderer: (channel: string, data: unknown) => void
  resolveOriginDomain: (webContentsId?: number) => string
  isPreviewWebContentsId: (webContentsId?: number) => boolean
}

export class BrowserSessionPolicyService {
  private adblockState: BrowserAdblockState
  private adblockUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private lastAdblockRendererUpdateAt = 0

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
    const host = getUrlHostname(requestUrl)
    if (!host || this.isWhitelistedDomain(host, originDomain)) return false
    return this.isKnownAdHost(host)
  }
}
