import { ipcMain } from 'electron'
import { isAbsolute, relative, resolve } from 'path'
import { realpath } from 'fs/promises'

import {
  type FileEmergenceGetSnapshotPayload,
  type FileEmergenceRecordActivityPayload,
  type FileEmergenceRecordReadingSessionPayload,
  type FileEmergenceRenameProjectPayload,
  type FileEmergenceAssignFilePayload,
  type FileEmergenceCreateProjectForFilePayload,
  type FileEmergenceFeedbackPayload,
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
import { FileProjectIdentityRepository } from '../repositories/file-project-identity-repository'
import { FileAttentionRepository } from '../repositories/file-attention-repository'
import { FileEmergenceFeedbackRepository } from '../repositories/file-emergence-feedback-repository'
import { FileEmergenceEvaluationRepository } from '../repositories/file-emergence-evaluation-repository'
import { addTagAssignmentChangeListener } from '../tag-forge/reconcile'
import { addDocumentMoveIdentityListener, addDocumentWriteListener } from '../document-engine/ipc-handler'
import { getSearchEngine } from '../search-engine/ipc-handler'
import { FileEmergenceService, isFileEmergenceEnabled } from './service'
import type { ChatPort, FileProjectIdentityPort, RecentConversation, StructuralProjectHintPort } from './types'
import { createDocumentMetadataPort } from './document-metadata-port'
import { listCurrentVisibleTaskProjections } from './current-visible-task-projections'

interface IPCResponse<T = void> {
  success: boolean
  data?: T
  error?: string
  errorKind?: string
}

let fileEmergenceService: FileEmergenceService | null = null
let documentWriteDispose: (() => void) | null = null
let documentMoveDispose: (() => void) | null = null
let tagAssignmentDispose: (() => void) | null = null

export function setupFileEmergenceIPC(): void {
  ipcMain.removeHandler('fileEmergence:getSnapshot')
  ipcMain.removeHandler('fileEmergence:recordActivity')
  ipcMain.removeHandler('fileEmergence:recordReadingSession')
  ipcMain.removeHandler('fileEmergence:renameProject')
  ipcMain.removeHandler('fileEmergence:assignFile')
  ipcMain.removeHandler('fileEmergence:createProjectForFile')
  ipcMain.removeHandler('fileEmergence:feedbackProject')
  ipcMain.removeHandler('fileEmergence:listSuppressed')
  ipcMain.removeHandler('fileEmergence:getEvaluation')
  if (documentWriteDispose) {
    try { documentWriteDispose() } catch { /* ignore */ }
    documentWriteDispose = null
  }
  if (documentMoveDispose) {
    try { documentMoveDispose() } catch { /* ignore */ }
    documentMoveDispose = null
  }
  if(tagAssignmentDispose){try{tagAssignmentDispose()}catch{/* ignore */}tagAssignmentDispose=null}

  fileEmergenceService = createService()
  tagAssignmentDispose=addTagAssignmentChangeListener((root)=>fileEmergenceService?.markStale([root]))

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
          projectContext: payload?.projectContext,
        })
        if (snapshot.diagnostics?.cache === 'generated') {
          console.info('[file-emergence] snapshot diagnostics', snapshot.diagnostics)
        }
        return { success: true, data: snapshot }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

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
        const event = new FileActivityRepository(rawDb).recordEvent({
          path: resolved.path,
          workspaceRoot: resolved.workspaceRoot,
          eventType: parsed.eventType,
          source: parsed.source,
          meta: parsed.meta,
        })
        const identity = new FileProjectIdentityRepository(rawDb).ensureFile({ workspaceRoot: resolved.workspaceRoot, path: resolved.path, observedAt: event.createdAt })
        new FileAttentionRepository(rawDb).recordActivity(identity.fileKey, parsed.eventType, event.createdAt)
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
        const session = new FileReadingSessionRepository(rawDb).recordSession({
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
        if (session) {
          const identity = new FileProjectIdentityRepository(rawDb).ensureFile({ workspaceRoot: resolved.workspaceRoot, path: resolved.path, observedAt: session.endedAt })
          new FileAttentionRepository(rawDb).recordReading(identity.fileKey, session.endedAt, session.activeMs, session.progressEnd, session.progressKind)
        }
        getService().markStale(parsed.workspaceRoots)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'fileEmergence:renameProject',
    async (_, payload: FileEmergenceRenameProjectPayload): Promise<IPCResponse> => {
      try {
        const roots = validateWorkspaceRoots(payload?.workspaceRoots)
        if (!roots.ok) return { success: false, error: roots.error, errorKind: 'invalid_root' }
        const rawDb = getDatabase().getRawDb()
        if (!rawDb) return { success: false, error: 'Database not available', errorKind: 'database_unavailable' }
        const repository = new FileProjectIdentityRepository(rawDb)
        const project = repository.getProject(String(payload?.projectKey || '').trim())
        if (!project || !roots.roots.includes(project.workspaceRoot)) {
          return { success: false, error: 'Project is outside the active workspace', errorKind: 'invalid_project' }
        }
        repository.renameProject(project.projectKey, String(payload?.displayName || ''))
        new FileEmergenceFeedbackRepository(rawDb).record({projectKey:project.projectKey,action:'rename'})
        getService().markStale([project.workspaceRoot])
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'rename_failed' }
      }
    },
  )

  ipcMain.handle('fileEmergence:feedbackProject',async(_,payload:FileEmergenceFeedbackPayload):Promise<IPCResponse>=>{
    try{
      const roots=validateWorkspaceRoots(payload?.workspaceRoots);if(!roots.ok)return{success:false,error:roots.error,errorKind:'invalid_root'}
      const rawDb=getDatabase().getRawDb();if(!rawDb)return{success:false,error:'Database not available',errorKind:'database_unavailable'}
      const project=new FileProjectIdentityRepository(rawDb).getProject(String(payload?.projectKey||''));if(!project||!roots.roots.includes(project.workspaceRoot))return{success:false,error:'Project is outside the active workspace',errorKind:'invalid_project'}
      const action=payload?.action;if(!['not_related','snooze','hide','restore'].includes(action))return{success:false,error:'Unknown feedback action',errorKind:'invalid_action'}
      new FileEmergenceFeedbackRepository(rawDb).record({projectKey:project.projectKey,action,evidenceCutoff:normalizeTimestamp(payload.evidenceCutoff),snoozeUntil:normalizeTimestamp(payload.snoozeUntil)})
      getService().markStale([project.workspaceRoot]);return{success:true}
    }catch(error){return{success:false,error:error instanceof Error?error.message:String(error),errorKind:'feedback_failed'}}
  })

  ipcMain.handle('fileEmergence:listSuppressed',async(_,payload:{workspaceRoots:string[]}):Promise<IPCResponse<Array<{projectKey:string;displayName:string;reason:string;until:number|null}>>>=>{
    try{const roots=validateWorkspaceRoots(payload?.workspaceRoots);if(!roots.ok)return{success:false,error:roots.error,errorKind:'invalid_root'};const rawDb=getDatabase().getRawDb();if(!rawDb)return{success:false,error:'Database not available',errorKind:'database_unavailable'};return{success:true,data:new FileEmergenceFeedbackRepository(rawDb).listSuppressed(roots.roots)}}catch(error){return{success:false,error:error instanceof Error?error.message:String(error)}}
  })

  ipcMain.handle('fileEmergence:getEvaluation',async(_,payload:{workspaceRoots:string[]}):Promise<IPCResponse<unknown>>=>{
    try{const roots=validateWorkspaceRoots(payload?.workspaceRoots);if(!roots.ok)return{success:false,error:roots.error,errorKind:'invalid_root'};const rawDb=getDatabase().getRawDb();if(!rawDb)return{success:false,error:'Database not available',errorKind:'database_unavailable'};return{success:true,data:new FileEmergenceEvaluationRepository(rawDb).buildReport(roots.roots)}}catch(error){return{success:false,error:error instanceof Error?error.message:String(error)}}
  })

  ipcMain.handle(
    'fileEmergence:assignFile',
    async (_, payload: FileEmergenceAssignFilePayload): Promise<IPCResponse> => {
      try {
        const roots = validateWorkspaceRoots(payload?.workspaceRoots)
        if (!roots.ok) return { success: false, error: roots.error, errorKind: 'invalid_root' }
        const resolved = await resolvePathInsideRoots(String(payload?.path || ''), roots.roots)
        if (!resolved.ok) return { success: false, error: resolved.error, errorKind: 'invalid_path' }
        const rawDb = getDatabase().getRawDb()
        if (!rawDb) return { success: false, error: 'Database not available', errorKind: 'database_unavailable' }
        const repository = new FileProjectIdentityRepository(rawDb)
        repository.assignPathToProject({
          projectKey: String(payload?.projectKey || '').trim(),
          workspaceRoot: resolved.workspaceRoot,
          path: resolved.path,
        })
        getService().markStale([resolved.workspaceRoot])
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'assignment_failed' }
      }
    },
  )

  ipcMain.handle(
    'fileEmergence:createProjectForFile',
    async (_, payload: FileEmergenceCreateProjectForFilePayload): Promise<IPCResponse> => {
      try {
        const roots = validateWorkspaceRoots(payload?.workspaceRoots)
        if (!roots.ok) return { success: false, error: roots.error, errorKind: 'invalid_root' }
        const resolved = await resolvePathInsideRoots(String(payload?.path || ''), roots.roots)
        if (!resolved.ok) return { success: false, error: resolved.error, errorKind: 'invalid_path' }
        const rawDb = getDatabase().getRawDb()
        if (!rawDb) return { success: false, error: 'Database not available', errorKind: 'database_unavailable' }
        new FileProjectIdentityRepository(rawDb).createUserProjectForPath({
          workspaceRoot: resolved.workspaceRoot,
          path: resolved.path,
          displayName: String(payload?.displayName || ''),
        })
        getService().markStale([resolved.workspaceRoot])
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error), errorKind: 'create_project_failed' }
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
      const event = new FileActivityRepository(rawDb).recordEvent({
        path,
        workspaceRoot: root,
        eventType: 'save',
        source: 'document_write',
      })
      const identity = new FileProjectIdentityRepository(rawDb).ensureFile({ workspaceRoot: root, path, observedAt: event.createdAt })
      new FileAttentionRepository(rawDb).recordActivity(identity.fileKey, 'save', event.createdAt)
      fileEmergenceService?.markStale([root])
    } catch (error) {
      console.warn('[file-emergence] document write activity record failed', error)
    }
  })

  documentMoveDispose = addDocumentMoveIdentityListener(({ oldPath, newPath, isDirectory }) => {
    const rawDb = getDatabase().getRawDb()
    if (!rawDb) throw new Error('Database not available for file identity move')
    const repository = new FileProjectIdentityRepository(rawDb)
    const root = repository.findWorkspaceRootForMove(oldPath) || getSearchEngine()?.findWorkspaceRootForPath(newPath)
    if (!root || validateWorkspaceRoot(root).ok === false) {
      throw new Error('Cannot resolve a safe workspace for file identity move')
    }
    repository.recordInternalMove({
      workspaceRoot: root,
      oldPath,
      newPath,
      kind: isDirectory ? 'directory' : 'file',
    })
    fileEmergenceService?.markStale([root])
  })
}

function isFileEmergenceActivityEnabled(): boolean {
  return isFileEmergenceEnabled(new AppSettingsRepository())
}

function getService(): FileEmergenceService {
  if (!fileEmergenceService) fileEmergenceService = createService()
  return fileEmergenceService
}

export async function getFileEmergenceIntentCardsForFeed() {
  try {
    const rawDb = getDatabase().getRawDb()
    if (!rawDb) return []
    const roots = rootsForKnownFiles(rawDb)
    if (roots.length === 0) return []
    const snapshot = await getService().getSnapshot({ workspaceRoots:roots })
    return snapshot.intentCards ?? []
  } catch {
    return []
  }
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
    identity: rawDb ? createIdentityPort(rawDb) : null,
    structuralHints: rawDb ? createStructuralHintPort(rawDb) : null,
    attention: rawDb ? createAttentionPort(rawDb) : null,
    feedback: rawDb ? new FileEmergenceFeedbackRepository(rawDb) : null,
  })
}

function createAttentionPort(rawDb: DatabaseConnection): import('./types').AttentionPort {
  const repository = new FileAttentionRepository(rawDb)
  return {
    backfill: (roots, now) => {
      if (roots.length) {
        const placeholders=roots.map(()=>'?').join(',')
        const paths=rawDb.prepare(`SELECT workspace_root AS workspaceRoot,path,created_at AS at FROM file_activity_events WHERE workspace_root IN (${placeholders}) UNION SELECT workspace_root,path,ended_at FROM document_reading_sessions WHERE workspace_root IN (${placeholders})`).all<{workspaceRoot:string;path:string;at:number}>(...roots,...roots)
        const identities=new FileProjectIdentityRepository(rawDb)
        for(const row of paths) identities.ensureFile({workspaceRoot:row.workspaceRoot,path:row.path,observedAt:row.at})
      }
      repository.backfill(roots, now)
    },
    listFacts: (roots) => {
      const rollups = new Map(repository.list(roots).map((row) => [row.fileKey, row]))
      if (!roots.length) return []
      const placeholders = roots.map(() => '?').join(',')
      return rawDb.prepare(`SELECT file_key AS fileKey,current_path AS path,workspace_root AS workspaceRoot FROM file_identities WHERE workspace_root IN (${placeholders})`).all<{fileKey:string;path:string;workspaceRoot:string}>(...roots).flatMap((file) => {
        const row = rollups.get(file.fileKey)
        if (!row) return []
        return [{ fileKey:file.fileKey,path:file.path,workspaceRoot:file.workspaceRoot,lastActivityAt:Math.max(row.lastOpenAt??0,row.lastSaveAt??0,row.lastReadAt??0),openCount:row.openCount,saveCount:row.saveCount,activeDays:row.activeDays.length,readingMs:row.readingMs,progress:row.latestProgress,markCount:row.markCount,lastSurfacedAt:row.lastSurfacedAt }]
      })
    },
    activeIntentFileKeys: (now) => {
      const terminal=new Set(['completed','failed','cancelled','canceled','done'])
      const tasks=listCurrentVisibleTaskProjections(rawDb,200)
      for(const task of tasks){
        const paths=uniqueWorkspacePaths([...pathsFromJson(task.expectedOutputs),...pathsFromJson(task.recentArtifacts)], rootsForKnownFiles(rawDb))
        const files=paths.flatMap((path)=>rawDb.prepare(`SELECT f.file_key AS fileKey,m.project_key AS projectKey FROM file_identities f JOIN project_identity_members m ON m.file_key=f.file_key WHERE f.current_path=?`).all<{fileKey:string;projectKey:string}>(path))
        for(const projectKey of new Set(files.map((file)=>file.projectKey))){
          const intentId=`task:${task.taskId}:${projectKey}`;const fileKeys=files.filter((file)=>file.projectKey===projectKey).map((file)=>file.fileKey)
          if(terminal.has(task.status)) rawDb.prepare(`UPDATE project_intent_facts SET status='completed',updated_at=? WHERE intent_id=? AND status='active'`).run(now,intentId)
          else rawDb.prepare(`INSERT INTO project_intent_facts (intent_id,project_key,file_keys_json,kind,source,not_before,due_at,expires_at,status,evidence_code,evidence_ref,created_at,updated_at) VALUES (?,?,?,'deliver','task',NULL,NULL,?,'active','task_expected_output',?,?,?) ON CONFLICT(intent_id) DO UPDATE SET file_keys_json=excluded.file_keys_json,expires_at=excluded.expires_at,status='active',updated_at=excluded.updated_at`).run(intentId,projectKey,JSON.stringify(fileKeys),now+30*86_400_000,task.taskId,now,now)
        }
      }
      rawDb.prepare(`UPDATE project_intent_facts SET status='expired',updated_at=? WHERE status='active' AND expires_at<=?`).run(now,now)
      const rows=rawDb.prepare(`SELECT file_keys_json AS fileKeys FROM project_intent_facts WHERE status='active' AND expires_at>? AND (not_before IS NULL OR not_before<=?)`).all<{fileKeys:string}>(now,now)
      return new Set(rows.flatMap((row)=>{try{return JSON.parse(row.fileKeys) as string[]}catch{return[]}}))
    },
    recordSnapshot: (projects, generatedAt, context) => repository.recordSnapshot(projects, generatedAt, context),
  }
}

function rootsForKnownFiles(rawDb: DatabaseConnection): string[] {
  return rawDb.prepare(`SELECT DISTINCT workspace_root AS root FROM file_identities`).all<{root:string}>().map((row)=>row.root)
}

function createStructuralHintPort(rawDb: DatabaseConnection): StructuralProjectHintPort {
  return {
    listHints(workspaceRoots) {
      const hints: ReturnType<StructuralProjectHintPort['listHints']> = []
      const tasks = listCurrentVisibleTaskProjections(rawDb,100)
        .filter((task): task is typeof task & { title: string } => task.title !== null)
      for (const task of tasks) {
        const paths = uniqueWorkspacePaths([
          ...pathsFromJson(task.expectedOutputs),
          ...pathsFromJson(task.recentArtifacts),
        ], workspaceRoots)
        if (paths.length > 0) hints.push({
          source: 'task',
          label: task.title.trim(),
          paths,
          updatedAt: parseTime(task.updatedAt),
        })
      }
      const attachments = rawDb.prepare(`
        SELECT attachment.name, attachment.path, attachment.created_at AS createdAt
        FROM session_recall_attachment_index attachment
        JOIN chat_messages message ON message.id = attachment.source_message_id
        JOIN chat_conversations scope ON scope.id = message.conversation_id
        WHERE attachment.path IS NOT NULL AND attachment.path <> ''
          AND scope.closed_at IS NULL
          AND message.message_visibility_epoch = scope.message_visibility_epoch
        ORDER BY attachment.created_at DESC LIMIT 200
      `).all<{ name: string; path: string; createdAt: string }>()
      for (const attachment of attachments) {
        const paths = uniqueWorkspacePaths([attachment.path], workspaceRoots)
        if (paths.length > 0) hints.push({
          source: 'attachment',
          label: stripFileExtension(attachment.name),
          paths,
          updatedAt: parseTime(attachment.createdAt),
        })
      }
      return hints
    },
  }
}

function createIdentityPort(rawDb: DatabaseConnection): FileProjectIdentityPort {
  const repository = new FileProjectIdentityRepository(rawDb)
  return {
    resolveCurrentFile(workspaceRoot, observedPath) {
      const file = repository.resolveFileByObservedPath(workspaceRoot, observedPath)
      return file ? { fileKey: file.fileKey, currentPath: file.currentPath } : null
    },
    resolveProject(input) {
      const project = repository.resolveOrCreateProject(input)
      return {
        projectKey: project.projectKey,
        displayName: project.displayName,
        source: project.source,
        confidence: project.confidence,
        files: repository.listProjectFiles(project.projectKey).map((file) => ({
          fileKey: file.fileKey,
          currentPath: file.currentPath,
        })),
      }
    },
  }
}

function isPathInsideRoots(path: string, workspaceRoots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false
  return workspaceRoots.some((root) => {
    const rel = relative(root, path)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

function pathsFromJson(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    const paths: string[] = []
    collectStructuredPaths(parsed, paths, null)
    return paths
  } catch {
    return []
  }
}

function collectStructuredPaths(value: unknown, paths: string[], key: string | null): void {
  if (typeof value === 'string') {
    if ((key === null || /^(?:path|artifactPath|outputPath|filePath)$/i.test(key)) && isAbsolute(value)) paths.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredPaths(item, paths, key)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectStructuredPaths(child, paths, childKey)
  }
}

function uniqueWorkspacePaths(paths: readonly string[], workspaceRoots: readonly string[]): string[] {
  return Array.from(new Set(paths.filter((path) => isPathInsideRoots(path, workspaceRoots))))
}

function stripFileExtension(name: string): string {
  const value = name.trim()
  const dot = value.lastIndexOf('.')
  return dot > 0 && value.length - dot <= 9 ? value.slice(0, dot) : value
}

function parseTime(value: string): number {
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
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

function normalizeTimestamp(value:unknown):number|null{const numeric=Number(value);return Number.isFinite(numeric)&&numeric>0?numeric:null}

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
