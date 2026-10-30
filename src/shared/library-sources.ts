import type { LibraryResult } from './library'
export type BookSource = 'zlib' | 'treasure' | 'ctfile'
export type SourceFormat = 'epub' | 'pdf' | 'mobi' | 'azw3' | 'txt' | 'fb2' | 'cbz'
export interface SourceSettings { executable: string; format: SourceFormat; treasure: boolean; ctfile: boolean }
export interface SourceHit { source: BookSource; ref: string; title: string; author: string; format: string }
export type SourceStatus = { state: 'missing' | 'logged_out' | 'available' | 'error'; error?: string }
export type SourceJobStatus = 'queued' | 'downloading' | 'captcha' | 'extracting' | 'done' | 'failed' | 'cancelled'
export interface SourceJob {
  id: string; source: BookSource; ref: string; status: SourceJobStatus; progress: number
  error: string | null; book_id: string | null; created_at: number; updated_at: number
  message?: string; captcha?: { token: string; image: string }
}
export interface BookSourcesAPI {
  settings(): Promise<LibraryResult<{ settings: SourceSettings; extraSources: boolean }>>
  configure(settings: SourceSettings): Promise<LibraryResult<SourceSettings>>
  status(): Promise<LibraryResult<SourceStatus>>
  search(input: { source: BookSource; query: string; format: SourceFormat; category?: string }): Promise<LibraryResult<SourceHit[]>>
  categories(): Promise<LibraryResult<string[]>>
  jobs(): Promise<LibraryResult<SourceJob[]>>
  download(input: { source: BookSource; ref: string }): Promise<LibraryResult<SourceJob>>
  cancel(id: string): Promise<LibraryResult<SourceJob>>
  retry(id: string): Promise<LibraryResult<SourceJob>>
  answer(input: { id: string; token: string; text: string }): Promise<LibraryResult<void>>
  openManual(id: string): Promise<LibraryResult<void>>
  onChanged(listener: (jobs: SourceJob[]) => void): () => void
}
