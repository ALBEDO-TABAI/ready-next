import type { BrowserBookmark, BrowserDownload, BrowserHistoryEntry } from '../database/records'

import { BrowserRepository } from '../repositories/browser-repository'

export interface BrowserAdblockState {
  enabled: boolean
  previewEnabled: boolean
  whitelistDomains: string[]
  rulesVersion: string
  networkBlockedCount: number
  lastUpdatedAt: number | null
}

export const READY_ADBLOCK_RULES_VERSION = 'ready-basic-ads-v1'

export function normalizeDomainToken(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, '')
}

export function normalizeDomainList(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : []
  return Array.from(
    new Set(raw.map((item) => normalizeDomainToken(String(item || ''))).filter(Boolean)),
  )
}

export class BrowserDataService {
  private readonly repository: BrowserRepository

  constructor(repository = new BrowserRepository()) {
    this.repository = repository
  }

  createDefaultAdblockState(): BrowserAdblockState {
    return {
      enabled: true,
      previewEnabled: true,
      whitelistDomains: [],
      rulesVersion: READY_ADBLOCK_RULES_VERSION,
      networkBlockedCount: 0,
      lastUpdatedAt: null,
    }
  }

  getSetting(key: string): string | undefined {
    return this.repository.getSetting(key)
  }

  readAdblockState(): BrowserAdblockState {
    const fallback = this.createDefaultAdblockState()
    try {
      const whitelistRaw = this.repository.getSetting('browser_adblock_whitelist_domains')
      const whitelist = whitelistRaw
        ? normalizeDomainList(JSON.parse(whitelistRaw))
        : []
      const lastUpdatedAt = Number(this.repository.getSetting('browser_adblock_last_updated_at') || 0)
      const networkBlockedCount = Number(this.repository.getSetting('browser_adblock_network_blocked_count') || 0)
      return {
        enabled: this.repository.getSetting('browser_adblock_enabled') !== 'false',
        previewEnabled: this.repository.getSetting('browser_adblock_preview_enabled') !== 'false',
        whitelistDomains: whitelist,
        rulesVersion: String(this.repository.getSetting('browser_adblock_rules_version') || READY_ADBLOCK_RULES_VERSION),
        networkBlockedCount: Number.isFinite(networkBlockedCount) ? networkBlockedCount : 0,
        lastUpdatedAt: Number.isFinite(lastUpdatedAt) && lastUpdatedAt > 0 ? lastUpdatedAt : null,
      }
    } catch {
      return fallback
    }
  }

  persistAdblockState(state: BrowserAdblockState): void {
    try {
      this.repository.setSetting('browser_adblock_enabled', state.enabled ? 'true' : 'false')
      this.repository.setSetting('browser_adblock_preview_enabled', state.previewEnabled ? 'true' : 'false')
      this.repository.setSetting('browser_adblock_whitelist_domains', JSON.stringify(state.whitelistDomains))
      this.repository.setSetting('browser_adblock_rules_version', state.rulesVersion)
      this.repository.setSetting('browser_adblock_network_blocked_count', String(state.networkBlockedCount))
      this.repository.setSetting(
        'browser_adblock_last_updated_at',
        String(state.lastUpdatedAt || Math.floor(Date.now() / 1000)),
      )
    } catch {
      // ignore persistence failures
    }
  }

  persistAdblockBlockedCount(count: number): void {
    try {
      this.repository.setSetting('browser_adblock_network_blocked_count', String(count))
    } catch {
      // ignore persistence failures
    }
  }

  addBookmark(url: string, title: string, favicon?: string): string {
    return this.repository.addBookmark(url, title, favicon)
  }

  removeBookmarkByUrl(url: string): void {
    this.repository.removeBookmarkByUrl(url)
  }

  getBookmarks(): BrowserBookmark[] {
    return this.repository.getBookmarks()
  }

  isBookmarked(url: string): boolean {
    return this.repository.isBookmarked(url)
  }

  addHistoryEntry(
    url: string,
    title: string,
    metadata?: {
      favicon?: string | null
      transition?: string | null
      sessionId?: string | null
    },
  ): string {
    return this.repository.addHistoryEntry(url, title, metadata)
  }

  updateHistoryEntryTitle(url: string, title: string, favicon?: string | null): void {
    this.repository.updateHistoryEntryTitle(url, title, favicon)
  }

  getHistory(limit?: number): BrowserHistoryEntry[] {
    return this.repository.getHistory(limit)
  }

  clearHistory(sinceEpochSeconds?: number): void {
    this.repository.clearHistory(sinceEpochSeconds)
  }

  getHistoryCount(): number {
    return this.repository.getHistoryCount()
  }

  searchHistory(query: string): BrowserHistoryEntry[] {
    return this.repository.searchHistory(query)
  }

  addDownload(download: {
    id: string
    url: string
    filename: string
    save_path?: string
    total_bytes: number
    received_bytes?: number
    state?: string
    mime_type?: string | null
    error?: string | null
    end_time?: number | null
    can_resume?: number | boolean
  }): void {
    this.repository.addDownload(download)
  }

  updateDownloadProgress(id: string, receivedBytes: number): void {
    this.repository.updateDownloadProgress(id, receivedBytes)
  }

  updateDownloadState(
    id: string,
    state: string,
    metadata?: {
      savePath?: string
      mimeType?: string | null
      error?: string | null
      endTime?: number | null
      canResume?: number | boolean
    },
  ): void {
    this.repository.updateDownloadState(id, state, metadata)
  }

  getDownloads(): BrowserDownload[] {
    return this.repository.getDownloads()
  }

  clearDownloads(sinceEpochSeconds?: number): void {
    this.repository.clearDownloads(sinceEpochSeconds)
  }

  getDownloadCount(): number {
    return this.repository.getDownloadCount()
  }
}
