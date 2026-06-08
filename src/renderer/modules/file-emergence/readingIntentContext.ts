import {
  readDocumentReadingPositions,
  type DocumentReadingPositionRecord,
} from '../document/documentScrollAnchor'
import type {
  FileEmergenceReadingProgress,
  FileEmergenceReadingProgressKind,
} from '../../../shared/file-emergence'

export const EBOOK_READING_STATE_KEY = 'ready-ebook-reading-state-v1'

type StorageLike = {
  getItem: (key: string) => string | null
}

interface EbookReadingState {
  path: string
  size?: number
  modifiedTime?: number
  fraction?: number
  index?: number
  updatedAt: number
}

export interface CurrentDocumentTabContext {
  path: string
  title: string
  isActive: boolean
  isSplit: boolean
  isDirty: boolean
}

export interface CurrentDocumentContext {
  tabs: CurrentDocumentTabContext[]
}

export function buildCurrentDocumentContext(input: {
  tabs: ReadonlyArray<{ id: string; path: string | null; title: string; isDirty: boolean }>
  activeTabId: string
  splitTabId: string | null
  workspaceRoots: readonly string[]
}): CurrentDocumentContext {
  const tabs = input.tabs
    .filter((tab) => typeof tab.path === 'string' && isInsideWorkspace(tab.path, input.workspaceRoots))
    .map((tab) => ({
      path: tab.path!,
      title: tab.title,
      isActive: tab.id === input.activeTabId,
      isSplit: tab.id === input.splitTabId,
      isDirty: tab.isDirty,
    }))
  return { tabs }
}

export async function readWorkspaceReadingProgress(input: {
  workspaceRoots: readonly string[]
  storage?: StorageLike | null
  statPath?: (path: string) => Promise<boolean>
}): Promise<FileEmergenceReadingProgress[]> {
  const storage = input.storage ?? resolveStorage()
  if (!storage) return []
  const raw = collectReadingProgress({ storage, workspaceRoots: input.workspaceRoots })
  const statPath = input.statPath ?? defaultStatPath
  const checked: FileEmergenceReadingProgress[] = []
  for (const record of raw.slice(0, 120)) {
    if (!isInsideWorkspace(record.path, input.workspaceRoots)) continue
    const exists = await statPath(record.path)
    if (!exists) continue
    checked.push({ ...record, exists: true })
  }
  return checked
}

export function collectReadingProgress(input: {
  storage: StorageLike
  workspaceRoots: readonly string[]
}): FileEmergenceReadingProgress[] {
  const byPath = new Map<string, FileEmergenceReadingProgress>()
  for (const record of readDocumentProgress(input.storage, input.workspaceRoots)) {
    upsertProgress(byPath, record)
  }
  for (const record of readEbookProgress(input.storage, input.workspaceRoots)) {
    upsertProgress(byPath, record)
  }
  return Array.from(byPath.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function readProgressForPath(path: string): FileEmergenceReadingProgress | null {
  const storage = resolveStorage()
  if (!storage) return null
  return collectReadingProgress({ storage, workspaceRoots: [path] })
    .find((record) => normalizePathKey(record.path) === normalizePathKey(path)) || null
}

export function isReadingSessionPath(path: string | null | undefined): boolean {
  if (!path) return false
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return ['md', 'txt', 'pdf', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'cbz'].includes(ext)
}

function readDocumentProgress(
  storage: StorageLike,
  workspaceRoots: readonly string[],
): FileEmergenceReadingProgress[] {
  return readDocumentReadingPositions({
    getItem: storage.getItem,
    setItem: () => undefined,
  })
    .filter((record) => isInsideWorkspace(record.key, workspaceRoots))
    .map((record) => fromDocumentPosition(record))
    .filter((record): record is FileEmergenceReadingProgress => Boolean(record))
}

function fromDocumentPosition(record: DocumentReadingPositionRecord): FileEmergenceReadingProgress | null {
  const ratio = clamp01(record.ratio)
  const kind: FileEmergenceReadingProgressKind = record.key.toLowerCase().endsWith('.pdf') ? 'pdf' : 'document'
  return {
    path: record.key,
    title: basenameWithoutExtension(record.key),
    kind,
    progressRatio: ratio,
    updatedAt: record.updatedAt,
    detail: kind === 'pdf'
      ? `阅读进度 ${Math.round(ratio * 100)}%`
      : record.anchorTitle
        ? `${record.anchorTitle} · ${Math.round(ratio * 100)}%`
        : `阅读进度 ${Math.round(ratio * 100)}%`,
  }
}

function readEbookProgress(
  storage: StorageLike,
  workspaceRoots: readonly string[],
): FileEmergenceReadingProgress[] {
  try {
    const parsed = JSON.parse(storage.getItem(EBOOK_READING_STATE_KEY) || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeEbookState)
      .filter((state): state is EbookReadingState => Boolean(state))
      .filter((state) => isInsideWorkspace(state.path, workspaceRoots))
      .map((state) => ({
        path: state.path,
        title: basenameWithoutExtension(state.path),
        kind: 'ebook' as const,
        progressRatio: clamp01(state.fraction ?? 0),
        updatedAt: state.updatedAt,
        detail: `阅读进度 ${Math.round(clamp01(state.fraction ?? 0) * 100)}%`,
      }))
  } catch {
    // silent-catch: corrupted cached ebook progress should not block file emergence.
    return []
  }
}

function normalizeEbookState(value: unknown): EbookReadingState | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<EbookReadingState>
  const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
  const updatedAt = Number(candidate.updatedAt)
  if (!path || !Number.isFinite(updatedAt)) return null
  return {
    path,
    size: Number(candidate.size) || 0,
    modifiedTime: Number(candidate.modifiedTime) || 0,
    fraction: typeof candidate.fraction === 'number' ? clamp01(candidate.fraction) : undefined,
    index: typeof candidate.index === 'number' ? candidate.index : undefined,
    updatedAt,
  }
}

function upsertProgress(
  byPath: Map<string, FileEmergenceReadingProgress>,
  record: FileEmergenceReadingProgress,
): void {
  const key = normalizePathKey(record.path)
  const existing = byPath.get(key)
  if (!existing || record.updatedAt >= existing.updatedAt) byPath.set(key, record)
}

async function defaultStatPath(path: string): Promise<boolean> {
  const stat = window.electronAPI?.document?.stat
  if (!stat) return false
  const result = await stat(path).catch(() => null)
  return Boolean(result?.success && !(result.data?.isDirectory ?? result.stat?.isDirectory))
}

function resolveStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  return window.localStorage || null
}

function isInsideWorkspace(path: string, workspaceRoots: readonly string[]): boolean {
  const key = normalizePathKey(path)
  return workspaceRoots.some((root) => {
    const rootKey = normalizePathKey(root)
    return key === rootKey || key.startsWith(`${rootKey}/`)
  })
}

function normalizePathKey(path: string): string {
  return path.normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '')
}

function basenameWithoutExtension(path: string): string {
  const name = normalizePathKey(path).split('/').pop() || path
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return name
  const ext = name.slice(dot + 1)
  if (ext.length > 8) return name
  return name.slice(0, dot) || name
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
