import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { isAbsolute, relative, resolve } from 'path'
import { realpath } from 'fs/promises'

import {
  type FileEmergenceGetSnapshotPayload,
  type FileEmergenceRecordActivityPayload,
  type FileEmergenceRecordReadingSessionPayload,
  type FileEmergenceSnapshot,
} from '../../../shared/file-emergence'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'
import { getDatabase, type DatabaseConnection } from '../database'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { BrowserRepository } from '../repositories/browser-repository'
import { CalendarRepository } from '../repositories/calendar-repository'
import { ChatRepository } from '../repositories/chat-repository'
import { FileActivityRepository } from '../repositories/file-activity-repository'
import { FileReadingSessionRepository } from '../repositories/file-reading-session-repository'
import { addDocumentWriteListener } from '../document-engine/ipc-handler'
import { getSearchEngine } from '../search-engine/ipc-handler'
import { FileEmergenceService, isFileEmergenceEnabled } from './service'
import type { ChatPort, DocumentMetadataPort, RecentConversation } from './types'

interface IPCResponse<T = void> {
  success: boolean
  data?: T
  error?: string
  errorKind?: string
}

let fileEmergenceService: FileEmergenceService | null = null
let documentWriteDispose: (() => void) | null = null
const pendingReadingSessionFlushes = new Map<string, {
  pendingWebContentsIds: Set<number>
  resolve: () => void
  timeout: ReturnType<typeof setTimeout>
}>()

export function setupFileEmergenceIPC(): void {
  ipcMain.removeHandler('fileEmergence:getSnapshot')
  ipcMain.removeHandler('fileEmergence:recordActivity')
  ipcMain.removeHandler('fileEmergence:recordReadingSession')
  ipcMain.removeAllListeners('fileEmergence:readingSessionsFlushed')
  if (documentWriteDispose) {
    try { documentWriteDispose() } catch { /* ignore */ }
    documentWriteDispose = null
  }

  fileEmergenceService = createService()

  ipcMain.handle(
    'fileEmergence:getSnapshot',
    async (_, payload: FileEmergenceGetSnapshotPayload): Promise<IPCResponse<FileEmergenceSnapshot>> => {
      try {
        const roots = validateWorkspaceRoots(payload?.workspaceRoots)
        if (!roots.ok) {
          return { success: false, error: roots.error, errorKind: 'invalid_root' }
        }
        const service = getService()
        const snapshot = await service.getSnapshot({
          workspaceRoots: roots.roots,
          forceRefresh: payload?.forceRefresh === true,
        })
        return { success: true, data: snapshot }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.on('fileEmergence:readingSessionsFlushed', (event, requestId: unknown) => {
    if (typeof requestId !== 'string') return
    const pending = pendingReadingSessionFlushes.get(requestId)
    if (!pending) return
    pending.pendingWebContentsIds.delete(event.sender.id)
    if (pending.pendingWebContentsIds.size === 0) {
      clearTimeout(pending.timeout)
      pendingReadingSessionFlushes.delete(requestId)
      pending.resolve()
    }
  })

  ipcMain.handle(
    'fileEmergence:recordActivity',
    async (_, payload: FileEmergenceRecordActivityPayload): Promise<IPCResponse> => {
      try {
        if (!isFileEmergenceActivityEnabled()) return { success: true }
        const parsed = parseRecordPayload(payload)
        if (!parsed.ok) return { success: false, error: parsed.error, errorKind: parsed.errorKind }
        const resolved = await resolvePathInsideRoots(parsed.path, parsed.workspaceRoots)
        if (!resolved.ok) return { success: false, error: resolved.error, errorKind: 'invalid_path' }
        const rawDb = getDatabase().getRawDb()
        if (!rawDb) return { success: false, error: 'Database not available', errorKind: 'database_unavailable' }
        new FileActivityRepository(rawDb).recordEvent({
          path: resolved.path,
          workspaceRoot: resolved.workspaceRoot,
          eventType: parsed.eventType,
          source: parsed.source,
          meta: parsed.meta,
        })
        getService().markStale(parsed.workspaceRoots)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'fileEmergence:recordReadingSession',
    async (_, payload: FileEmergenceRecordReadingSessionPayload): Promise<IPCResponse> => {
      try {
        if (!isFileEmergenceActivityEnabled()) return { success: true }
        const parsed = parseReadingSessionPayload(payload)
        if (!parsed.ok) return { success: false, error: parsed.error, errorKind: parsed.errorKind }
        const resolved = await resolvePathInsideRoots(parsed.path, parsed.workspaceRoots)
        if (!resolved.ok) return { success: false, error: resolved.error, errorKind: 'invalid_path' }
        const rawDb = getDatabase().getRawDb()
        if (!rawDb) return { success: false, error: 'Database not available', errorKind: 'database_unavailable' }
        new FileReadingSessionRepository(rawDb).recordSession({
          path: resolved.path,
          workspaceRoot: resolved.workspaceRoot,
          source: 'document_mode',
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          activeMs: parsed.activeMs,
          progressStart: parsed.progressStart,
          progressEnd: parsed.progressEnd,
          progressKind: parsed.progressKind,
          meta: parsed.meta,
        })
        getService().markStale(parsed.workspaceRoots)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  documentWriteDispose = addDocumentWriteListener((path) => {
    if (!isFileEmergenceActivityEnabled()) return
    const root = getSearchEngine()?.findWorkspaceRootForPath(path)
    if (!root || validateWorkspaceRoot(root).ok === false) return
    const rawDb = getDatabase().getRawDb()
    if (!rawDb) return
    try {
      new FileActivityRepository(rawDb).recordEvent({
        path,
        workspaceRoot: root,
        eventType: 'save',
        source: 'document_write',
      })
      fileEmergenceService?.markStale([root])
    } catch (error) {
      console.warn('[file-emergence] document write activity record failed', error)
    }
  })
}

export function requestRendererReadingSessionFlush(timeoutMs = 800): Promise<void> {
  const targets = BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed())
  if (targets.length === 0) return Promise.resolve()

  const requestId = randomUUID()
  const pendingWebContentsIds = new Set(targets.map((window) => window.webContents.id))
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingReadingSessionFlushes.delete(requestId)
      resolve()
    }, timeoutMs)
    if (typeof timeout.unref === 'function') timeout.unref()
    pendingReadingSessionFlushes.set(requestId, {
      pendingWebContentsIds,
      resolve,
      timeout,
    })
    for (const target of targets) {
      target.webContents.send('fileEmergence:flushReadingSessions', requestId)
    }
  })
}

function isFileEmergenceActivityEnabled(): boolean {
  return isFileEmergenceEnabled(new AppSettingsRepository())
}

function getService(): FileEmergenceService {
  if (!fileEmergenceService) fileEmergenceService = createService()
  return fileEmergenceService
}

function createService(): FileEmergenceService {
  const rawDb = getDatabase().getRawDb()
  const activity = rawDb
    ? new FileActivityRepository(rawDb)
    : {
        listRecent: () => [],
        prune: () => undefined,
      }
  const readingSessions = rawDb
    ? new FileReadingSessionRepository(rawDb)
    : {
        listRecent: () => [],
        prune: () => undefined,
      }
  const settings = new AppSettingsRepository()
  const chatRepository = new ChatRepository()
  const chat: ChatPort = {
    listRecentConversations: (limit: number): RecentConversation[] =>
      chatRepository.listRecentConversations(limit).map((row) => ({
        id: row.id,
        title: row.resume_title || row.title || row.id,
        updatedAt: row.last_message_at || row.updated_at,
        agent: row.agent,
      })),
    getMessages: (conversationId: string) => chatRepository.getMessages(conversationId),
  }

  return new FileEmergenceService({
    settings,
    activity,
    readingSessions,
    calendar: new CalendarRepository(),
    browser: new BrowserRepository(),
    chat,
    search: getSearchEngine(),
    documentMetadata: rawDb ? createDocumentMetadataPort(rawDb) : null,
  })
}

function createDocumentMetadataPort(rawDb: DatabaseConnection): DocumentMetadataPort {
  return {
    getTitleMetadata(paths, workspaceRoots) {
      const allowed = Array.from(new Set(paths.filter((path) => isPathInsideRoots(path, workspaceRoots))))
        .slice(0, 300)
      if (allowed.length === 0) return new Map()
      const placeholders = allowed.map(() => '?').join(',')
      const rows = rawDb.prepare(`
        SELECT path, name, frontmatter_json AS frontmatterJson, source_meta_json AS sourceMetaJson
        FROM documents
        WHERE path IN (${placeholders})
      `).all<{
        path: string
        name: string | null
        frontmatterJson: string | null
        sourceMetaJson: string | null
      }>(...allowed)
      const out = new Map()
      for (const row of rows) {
        out.set(row.path, {
          path: row.path,
          name: row.name,
          frontmatterTitle: titleFromJson(row.frontmatterJson),
          metadataTitle: titleFromJson(row.sourceMetaJson),
        })
      }
      return out
    },
  }
}

function titleFromJson(raw: string | null): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return titleFromRecord(parsed as Record<string, unknown>)
  } catch {
    return null
  }
}

function titleFromRecord(record: Record<string, unknown>): string | null {
  for (const key of ['title', 'Title', '标题', 'name']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function isPathInsideRoots(path: string, workspaceRoots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false
  return workspaceRoots.some((root) => {
    const rel = relative(root, path)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

function validateWorkspaceRoots(rawRoots: unknown): { ok: true; roots: string[] } | { ok: false; error: string } {
  if (!Array.isArray(rawRoots)) return { ok: false, error: 'workspaceRoots must be an array' }
  const roots = Array.from(new Set(rawRoots.map((root) => String(root || '').trim()).filter(Boolean)))
  for (const root of roots) {
    const validation = validateWorkspaceRoot(root)
    if (!validation.ok) return { ok: false, error: `Invalid workspace root: ${root}` }
  }
  return { ok: true, roots }
}

function parseRecordPayload(payload: FileEmergenceRecordActivityPayload): {
  ok: true
  path: string
  eventType: 'open' | 'save'
  source: 'file_tree' | 'document_mode' | 'emergence'
  workspaceRoots: string[]
  meta?: Record<string, unknown>
} | { ok: false; error: string; errorKind: string } {
  const path = typeof payload?.path === 'string' ? payload.path.trim() : ''
  if (!path) return { ok: false, error: 'path is required', errorKind: 'invalid_path' }
  if (payload.eventType !== 'open' && payload.eventType !== 'save') {
    return { ok: false, error: 'eventType must be open or save', errorKind: 'invalid_event_type' }
  }
  if (payload.source !== 'file_tree' && payload.source !== 'document_mode' && payload.source !== 'emergence') {
    return { ok: false, error: 'source is not allowed for renderer activity', errorKind: 'invalid_source' }
  }
  const roots = validateWorkspaceRoots(payload.workspaceRoots)
  if (!roots.ok) return { ok: false, error: roots.error, errorKind: 'invalid_root' }
  const meta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
    ? payload.meta
    : undefined
  return {
    ok: true,
    path,
    eventType: payload.eventType,
    source: payload.source,
    workspaceRoots: roots.roots,
    meta,
  }
}

function parseReadingSessionPayload(payload: FileEmergenceRecordReadingSessionPayload): {
  ok: true
  path: string
  source: 'document_mode'
  workspaceRoots: string[]
  startedAt: number
  endedAt: number
  activeMs: number
  progressStart?: number | null
  progressEnd?: number | null
  progressKind?: FileEmergenceRecordReadingSessionPayload['progressKind']
  meta?: Record<string, unknown>
} | { ok: false; error: string; errorKind: string } {
  const path = typeof payload?.path === 'string' ? payload.path.trim() : ''
  if (!path) return { ok: false, error: 'path is required', errorKind: 'invalid_path' }
  if (payload.source !== 'document_mode') {
    return { ok: false, error: 'source must be document_mode', errorKind: 'invalid_source' }
  }
  const roots = validateWorkspaceRoots(payload.workspaceRoots)
  if (!roots.ok) return { ok: false, error: roots.error, errorKind: 'invalid_root' }
  const startedAt = Number(payload.startedAt)
  const endedAt = Number(payload.endedAt)
  const activeMs = Number(payload.activeMs)
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
    return { ok: false, error: 'session time range is invalid', errorKind: 'invalid_time_range' }
  }
  if (!Number.isFinite(activeMs) || activeMs < 0) {
    return { ok: false, error: 'activeMs must be non-negative', errorKind: 'invalid_active_ms' }
  }
  const meta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
    ? payload.meta
    : undefined
  return {
    ok: true,
    path,
    source: 'document_mode',
    workspaceRoots: roots.roots,
    startedAt,
    endedAt,
    activeMs,
    progressStart: normalizeProgress(payload.progressStart),
    progressEnd: normalizeProgress(payload.progressEnd),
    progressKind: payload.progressKind ?? null,
    meta,
  }
}

function normalizeProgress(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value))
}

async function resolvePathInsideRoots(
  rawPath: string,
  workspaceRoots: readonly string[],
): Promise<{ ok: true; path: string; workspaceRoot: string } | { ok: false; error: string }> {
  const path = resolve(rawPath)
  if (!isAbsolute(path)) return { ok: false, error: 'path must be absolute' }
  const realPath = await realpath(path).catch((error) => {
    throw new Error(error instanceof Error ? error.message : String(error))
  })
  for (const root of workspaceRoots) {
    const rootPath = resolve(root)
    const rootRealPath = await realpath(rootPath).catch(() => null)
    if (!rootRealPath) continue
    const lexical = relative(rootPath, path)
    if (lexical.startsWith('..') || isAbsolute(lexical)) continue
    const realRelative = relative(rootRealPath, realPath)
    if (realRelative === '' || (!realRelative.startsWith('..') && !isAbsolute(realRelative))) {
      return { ok: true, path, workspaceRoot: root }
    }
  }
  return { ok: false, error: 'path is outside workspaceRoots' }
}
