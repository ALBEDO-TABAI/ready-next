import type { BrowserBookmark, BrowserDownload, BrowserHistoryEntry, BrowserTaskRecord } from '../database/records'

import { getDatabase } from '../database'

export class BrowserRepository {
  getSetting(key: string): string | undefined {
    return getDatabase().settings.getSetting(key)
  }

  setSetting(key: string, value: string): void {
    getDatabase().settings.setSetting(key, value)
  }

  deleteSetting(key: string): void {
    getDatabase().settings.deleteSetting(key)
  }

  getAllSettings(): Record<string, string> {
    return getDatabase().settings.getAllSettings()
  }

  addBookmark(url: string, title: string, favicon?: string): string {
    return getDatabase().browser.addBookmark(url, title, favicon)
  }

  removeBookmarkByUrl(url: string): void {
    getDatabase().browser.removeBookmarkByUrl(url)
  }

  getBookmarks(): BrowserBookmark[] {
    return getDatabase().browser.getBookmarks()
  }

  isBookmarked(url: string): boolean {
    return getDatabase().browser.isBookmarked(url)
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
    return getDatabase().browser.addHistoryEntry(url, title, metadata)
  }

  updateHistoryEntryTitle(url: string, title: string, favicon?: string | null): void {
    getDatabase().browser.updateHistoryEntryTitle(url, title, favicon)
  }

  getHistory(limit?: number): BrowserHistoryEntry[] {
    return getDatabase().browser.getHistory(limit)
  }

  clearHistory(sinceEpochSeconds?: number): void {
    getDatabase().browser.clearHistory(sinceEpochSeconds)
  }

  getHistoryCount(): number {
    return getDatabase().browser.getHistoryCount()
  }

  searchHistory(query: string): BrowserHistoryEntry[] {
    return getDatabase().browser.searchHistory(query)
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
    getDatabase().browser.addDownload(download)
  }

  updateDownloadProgress(id: string, receivedBytes: number): void {
    getDatabase().browser.updateDownloadProgress(id, receivedBytes)
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
    getDatabase().browser.updateDownloadState(id, state, metadata)
  }

  getDownloads(): BrowserDownload[] {
    return getDatabase().browser.getDownloads()
  }

  clearDownloads(sinceEpochSeconds?: number): void {
    getDatabase().browser.clearDownloads(sinceEpochSeconds)
  }

  getDownloadCount(): number {
    return getDatabase().browser.getDownloadCount()
  }

  createTask(task: {
    id: string
    kind: string
    status: string
    payload_json: string
    checkpoint_json?: string | null
    result_json?: string | null
    progress_total?: number
    progress_completed?: number
    progress_failed?: number
    current_label?: string | null
    error?: string | null
    created_at: string
    started_at?: string | null
    updated_at: string
    finished_at?: string | null
  }): void {
    getDatabase().browser.createBrowserTask(task)
  }

  updateTask(
    id: string,
    updates: {
      status?: string
      payload_json?: string | null
      checkpoint_json?: string | null
      result_json?: string | null
      progress_total?: number
      progress_completed?: number
      progress_failed?: number
      current_label?: string | null
      error?: string | null
      started_at?: string | null
      updated_at?: string
      finished_at?: string | null
    },
  ): void {
    getDatabase().browser.updateBrowserTask(id, updates)
  }

  getTask(id: string): BrowserTaskRecord | undefined {
    return getDatabase().browser.getBrowserTask(id)
  }

  listTasks(statuses?: string[]): BrowserTaskRecord[] {
    return getDatabase().browser.listBrowserTasks(statuses)
  }
}
