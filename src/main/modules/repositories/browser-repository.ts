import type {
  BrowserBookmark,
  BrowserDownload,
  BrowserHistoryEntry,
} from '../database'
import { getDatabase } from '../database'

export class BrowserRepository {
  getSetting(key: string): string | undefined {
    return getDatabase().getSetting(key)
  }

  setSetting(key: string, value: string): void {
    getDatabase().setSetting(key, value)
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

  getHistory(limit?: number): BrowserHistoryEntry[] {
    return getDatabase().getHistory(limit)
  }

  clearHistory(): void {
    getDatabase().clearHistory()
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

  clearDownloads(): void {
    getDatabase().clearDownloads()
  }
}
