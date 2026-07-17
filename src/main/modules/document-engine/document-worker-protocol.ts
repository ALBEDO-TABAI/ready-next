export type DocumentWorkerCommand =
  | 'parseDocx'
  | 'parseXlsx'
  | 'importEpub'
  | 'extractDocumentText'
  | 'readDocxText'
  | 'writeDocx'
  | 'shutdown'

export interface DocumentWorkerRequest {
  id: number
  cmd: DocumentWorkerCommand
  args?: Record<string, unknown>
}

export interface DocumentWorkerResponse {
  id: number
  ok: boolean
  data?: unknown
  error?: { message: string; stack?: string; code?: string }
}

export interface DocumentWorkerApi {
  parseDocx(path: string): Promise<Record<string, unknown>>
  parseXlsx(path: string): Promise<Record<string, unknown>>
  importEpub(sourcePath: string): Promise<Record<string, unknown>>
  extractDocumentText(path: string, options?: DocumentTextExtractOptions): Promise<DocumentTextExtractResult>
  readDocxText(path: string): Promise<{ success: boolean; content: string; error?: string }>
  writeDocx(path: string, content: string): Promise<{ success: boolean; error?: string }>
  shutdown(): Promise<void>
}

export interface DocumentTextExtractOptions {
  maxSheets?: number
  maxRowsPerSheet?: number
  maxColumns?: number
  offset?: number
  maxChars?: number
}

export interface DocumentTextExtractResult {
  success: boolean
  kind: string
  text: string
  totalChars: number
  truncated: boolean
  offset: number
  nextOffset: number | null
  warning?: string
  error?: string
}
