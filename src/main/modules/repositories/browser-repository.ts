import type {
  BrowserBookmark,
  BrowserDownload,
  BrowserHistoryEntry,
  BrowserPowerPreflightAuditRecord,
  BrowserTaskRecord,
} from '../database'
import { getDatabase } from '../database'

export class BrowserRepository {
  getSetting(key: string): string | undefined {
    return getDatabase().getSetting(key)
  }

  setSetting(key: string, value: string): void {
    getDatabase().setSetting(key, value)
  }

  deleteSetting(key: string): void {
    getDatabase().deleteSetting(key)
  }

  getAllSettings(): Record<string, string> {
    return getDatabase().getAllSettings()
  }

  addBookmark(url: string, title: string, favicon?: string): string {
    return getDatabase().addBookmark(url, title, favicon)
  }

  removeBookmarkByUrl(url: string): void {
    getDatabase().removeBookmarkByUrl(url)
  }

  getBookmarks(): BrowserBookmark[] {
    return getDatabase().getBookmarks()
  }

  isBookmarked(url: string): boolean {
    return getDatabase().isBookmarked(url)
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
    return getDatabase().addHistoryEntry(url, title, metadata)
  }

  updateHistoryEntryTitle(url: string, title: string, favicon?: string | null): void {
    getDatabase().updateHistoryEntryTitle(url, title, favicon)
  }

  getHistory(limit?: number): BrowserHistoryEntry[] {
    return getDatabase().getHistory(limit)
  }

  clearHistory(sinceEpochSeconds?: number): void {
    getDatabase().clearHistory(sinceEpochSeconds)
  }

  getHistoryCount(): number {
    return getDatabase().getHistoryCount()
  }

  searchHistory(query: string): BrowserHistoryEntry[] {
    return getDatabase().searchHistory(query)
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
    getDatabase().addDownload(download)
  }

  updateDownloadProgress(id: string, receivedBytes: number): void {
    getDatabase().updateDownloadProgress(id, receivedBytes)
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
    getDatabase().updateDownloadState(id, state, metadata)
  }

  getDownloads(): BrowserDownload[] {
    return getDatabase().getDownloads()
  }

  clearDownloads(sinceEpochSeconds?: number): void {
    getDatabase().clearDownloads(sinceEpochSeconds)
  }

  getDownloadCount(): number {
    return getDatabase().getDownloadCount()
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
    getDatabase().createBrowserTask(task)
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
    options?: { expectedUpdatedAt?: string },
  ): boolean {
    return getDatabase().updateBrowserTask(id, updates, options)
  }

  getTask(id: string): BrowserTaskRecord | undefined {
    return getDatabase().getBrowserTask(id)
  }

  listTasks(statuses?: string[]): BrowserTaskRecord[] {
    return getDatabase().listBrowserTasks(statuses)
  }

  addPowerPreflightAudit(record: BrowserPowerPreflightAuditRecord): void {
    getDatabase().addBrowserPowerPreflightAudit(record)
  }

  getPowerPreflightAudit(id: string): BrowserPowerPreflightAuditRecord | undefined {
    return getDatabase().getBrowserPowerPreflightAudit(id)
  }
}
