import { constants, existsSync } from 'fs'
import { copyFile, lstat, mkdir, realpath, rename, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'

import type { SearchEngine } from '../search-engine/indexer'
import {
  assertInsideWorkspace,
  authorizeRoot,
  getFileManagementStoreDir,
  isPathInsideRoot,
  readJsonFile,
  resolveExistingPathInsideRoot,
  resolvePlannedPathInsideRoot,
  resolveRelativeFolderInsideRoot,
  toJsonString,
  writeJsonFile,
  type FileManagementToolContext,
} from './file-management-runtime'

const ORGANIZE_PLAN_TTL_MS = 30 * 60 * 1000

type OrganizeOperationInput = {
  path: string
  destDir: string
  newName?: string
}

type OrganizeOperation = OrganizeOperationInput & {
  targetPath: string
}

type OrganizeConflict = {
  kind: string
  path?: string
  targetPath?: string
  message: string
}

type OrganizePlan = {
  planId: string
  rootPath: string
  workspaceRoot: string
  createFolders: string[]
  operations: OrganizeOperation[]
  conflicts: OrganizeConflict[]
  confirmed: boolean
  createdAt: string
  expiresAt: string
}

type JournalMove = {
  type: 'move'
  sourcePath: string
  targetPath: string
}

type JournalFolder = {
  type: 'mkdir'
  path: string
}

type OrganizeJournal = {
  journalId: string
  planId: string
  rootPath: string
  workspaceRoot: string
  executedAt: string
  undoneAt: string | null
  operations: Array<JournalMove | JournalFolder>
}

function planPath(storeDir: string, planId: string): string {
  return join(storeDir, 'plans', `${planId}.json`)
}

function journalPath(storeDir: string, journalId: string): string {
  return join(storeDir, 'journals', `${journalId}.json`)
}

export async function executeFileManagementMutationTool(
  toolName: string,
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  switch (toolName) {
    case 'file_create_folder':
      return runFileCreateFolder(args, engine, context)
    case 'file_organize_preview':
      return runFileOrganizePreview(args, engine, context)
    case 'file_organize_apply':
      return runFileOrganizeApply(args, engine, context)
    case 'file_organize_undo':
      return runFileOrganizeUndo(args, engine, context)
    case 'file_rename':
      return runFileRename(args, engine, context)
    case 'file_copy':
      return runFileCopy(args, engine, context)
    case 'file_move':
      return runFileMove(args, engine, context)
    default:
      return `Unknown file management tool: ${toolName}`
  }
}

async function runFileCreateFolder(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const auth = await authorizeRoot(typeof args.rootPath === 'string' ? args.rootPath : '', engine, context?.workspaceRoots)
  if (!auth.ok) return toJsonString(auth.output)
  const target = resolveRelativeFolderInsideRoot(typeof args.relativePath === 'string' ? args.relativePath : '', auth)
  if (!target.ok) return toJsonString({ ok: false, error: target.error })
  const parentReal = await realpath(dirname(target.path)).catch(() => null)
  if (parentReal && !isPathInsideRoot(parentReal, auth.rootRealPath)) {
    return toJsonString({ ok: false, error: 'folder parent escapes authorized root via symlink' })
  }
  try {
    await mkdir(target.path, { recursive: true })
    return toJsonString({ ok: true, path: target.path, relativePath: target.relativePath })
  } catch (error) {
    // silent-catch: folder creation failures are returned as structured tool errors.
    return toJsonString({ ok: false, path: target.path, error: error instanceof Error ? error.message : String(error) })
  }
}

function parseOrganizeOperations(value: unknown): OrganizeOperationInput[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      path: typeof item.path === 'string' ? item.path : '',
      destDir: typeof item.destDir === 'string' ? item.destDir : '',
      newName: typeof item.newName === 'string' ? item.newName : undefined,
    }))
}

async function validateOrganizePlan(
  rootPath: string,
  createFoldersInput: unknown,
  operationsInput: unknown,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<{ ok: true; plan: OrganizePlan } | { ok: false; output: Record<string, unknown> }> {
  const auth = await authorizeRoot(rootPath, engine, context?.workspaceRoots)
  if (!auth.ok) return { ok: false, output: auth.output }
  const conflicts: OrganizeConflict[] = []
  const createFolders = Array.isArray(createFoldersInput)
    ? createFoldersInput.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  const folderTargets = new Map<string, string>()
  for (const relativeFolder of createFolders) {
    const target = resolveRelativeFolderInsideRoot(relativeFolder, auth)
    if (!target.ok) {
      conflicts.push({ kind: 'folder_invalid', message: target.error })
      continue
    }
    const existing = await stat(target.path).catch(() => null)
    if (existing && !existing.isDirectory()) {
      conflicts.push({ kind: 'folder_target_is_file', targetPath: target.path, message: 'folder target exists as a file' })
    }
    folderTargets.set(target.path, target.relativePath)
  }

  const operations: OrganizeOperation[] = []
  const targetPaths = new Set<string>()
  for (const op of parseOrganizeOperations(operationsInput)) {
    const source = await resolveExistingPathInsideRoot(op.path, auth)
    if (!source.ok) {
      conflicts.push({ kind: 'source_invalid', path: op.path, message: source.error })
      continue
    }
    const sourceStat = await stat(source.realPath).catch(() => null)
    if (!sourceStat?.isFile()) {
      conflicts.push({ kind: 'source_not_file', path: source.path, message: 'source must be a file' })
      continue
    }
    const dest = resolvePlannedPathInsideRoot(op.destDir, auth)
    if (!dest.ok) {
      conflicts.push({ kind: 'dest_invalid', path: op.destDir, message: dest.error })
      continue
    }
    const destStat = await stat(dest.path).catch(() => null)
    if (destStat && !destStat.isDirectory()) {
      conflicts.push({ kind: 'dest_not_directory', path: dest.path, message: 'destDir is not a directory' })
      continue
    }
    if (!destStat && !folderTargets.has(dest.path)) {
      conflicts.push({ kind: 'dest_missing', path: dest.path, message: 'destDir does not exist and is not listed in createFolders' })
      continue
    }
    const name = op.newName?.trim() || basename(source.path)
    if (!name || name.includes('/') || name.includes('\\')) {
      conflicts.push({ kind: 'new_name_invalid', path: source.path, message: 'newName must be a file name without path separators' })
      continue
    }
    const targetPath = join(dest.path, name)
    const target = resolvePlannedPathInsideRoot(targetPath, auth)
    if (!target.ok) {
      conflicts.push({ kind: 'target_invalid', path: source.path, targetPath, message: target.error })
      continue
    }
    if (target.path === source.path) {
      conflicts.push({ kind: 'noop', path: source.path, targetPath: target.path, message: 'source and target are the same path' })
      continue
    }
    if (targetPaths.has(target.path)) {
      conflicts.push({ kind: 'duplicate_target', path: source.path, targetPath: target.path, message: 'multiple operations target the same path' })
      continue
    }
    const existingTarget = await stat(target.path).catch(() => null)
    if (existingTarget) {
      conflicts.push({ kind: 'target_exists', path: source.path, targetPath: target.path, message: 'target already exists' })
      continue
    }
    targetPaths.add(target.path)
    operations.push({ path: source.path, destDir: dest.path, newName: op.newName, targetPath: target.path })
  }

  const now = new Date()
  return {
    ok: true,
    plan: {
      planId: `file-plan-${randomUUID()}`,
      rootPath: auth.rootPath,
      workspaceRoot: auth.workspaceRoot,
      createFolders,
      operations,
      conflicts,
      confirmed: false,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ORGANIZE_PLAN_TTL_MS).toISOString(),
    },
  }
}

async function runFileOrganizePreview(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const rootPath = typeof args.rootPath === 'string' ? args.rootPath : ''
  const validated = await validateOrganizePlan(rootPath, args.createFolders, args.operations, engine, context)
  if (!validated.ok) return toJsonString(validated.output)
  const plan = validated.plan
  const storeDir = await getFileManagementStoreDir(context)
  await writeJsonFile(planPath(storeDir, plan.planId), plan)
  return toJsonString({
    ok: plan.conflicts.length === 0,
    planId: plan.planId,
    rootPath: plan.rootPath,
    operations: plan.operations,
    createFolders: plan.createFolders,
    conflicts: plan.conflicts,
    impact: {
      createFolderCount: plan.createFolders.length,
      moveCount: plan.operations.length,
    },
    confirmed: false,
    expiresAt: plan.expiresAt,
    requiresConfirmation: true,
  })
}

function deleteIndexedPath(engine: SearchEngine, workspaceRoot: string, path: string): void {
  try {
    const repo = engine.getRepository()
    const workspaceId = repo.ensureWorkspace(workspaceRoot)
    repo.deletePath(workspaceId, path)
  } catch {
    // silent-catch: best-effort index cleanup; the filesystem operation already succeeded.
  }
}

async function indexPathIfPossible(engine: SearchEngine, workspaceRoot: string, path: string): Promise<void> {
  try {
    await engine.indexDocument(workspaceRoot, path)
  } catch {
    // silent-catch: best-effort eager index sync; watcher/reindex can reconcile later.
  }
}

async function runFileOrganizeApply(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const planId = typeof args.planId === 'string' ? args.planId : ''
  const confirmed = args.confirmed === true
  const confirmedVia = typeof args.confirmedVia === 'string' ? args.confirmedVia : ''
  if (!planId) return toJsonString({ ok: false, error: 'planId is required' })
  if (!confirmed || (confirmedVia !== 'ask_user_questions' && confirmedVia !== 'ui_action')) {
    return toJsonString({ ok: false, planId, error: 'file_organize_apply requires explicit user confirmation' })
  }
  const storeDir = await getFileManagementStoreDir(context)
  const plan = await readJsonFile<OrganizePlan & { appliedJournalId?: string }>(planPath(storeDir, planId))
  if (!plan) return toJsonString({ ok: false, planId, error: 'plan not found' })
  if (plan.appliedJournalId) return toJsonString({ ok: false, planId, error: 'plan already applied', journalId: plan.appliedJournalId })
  if (new Date(plan.expiresAt).getTime() < Date.now()) return toJsonString({ ok: false, planId, error: 'plan expired' })
  if (plan.conflicts.length > 0) return toJsonString({ ok: false, planId, error: 'plan has conflicts', conflicts: plan.conflicts })
  const auth = await authorizeRoot(plan.rootPath, engine, context?.workspaceRoots)
  if (!auth.ok) return toJsonString(auth.output)

  const journal: OrganizeJournal = {
    journalId: `file-journal-${randomUUID()}`,
    planId,
    rootPath: plan.rootPath,
    workspaceRoot: plan.workspaceRoot,
    executedAt: new Date().toISOString(),
    undoneAt: null,
    operations: [],
  }
  try {
    for (const relativeFolder of plan.createFolders) {
      const folder = resolveRelativeFolderInsideRoot(relativeFolder, auth)
      if (!folder.ok) throw new Error(folder.error)
      const existed = existsSync(folder.path)
      await mkdir(folder.path, { recursive: true })
      if (!existed) journal.operations.push({ type: 'mkdir', path: folder.path })
    }
    for (const op of plan.operations) {
      const source = await resolveExistingPathInsideRoot(op.path, auth)
      if (!source.ok) throw new Error(`source invalid: ${source.error}`)
      const target = resolvePlannedPathInsideRoot(op.targetPath, auth)
      if (!target.ok) throw new Error(`target invalid: ${target.error}`)
      if (existsSync(target.path)) throw new Error(`target already exists: ${target.path}`)
      await mkdir(dirname(target.path), { recursive: true })
      await rename(source.path, target.path)
      journal.operations.push({ type: 'move', sourcePath: source.path, targetPath: target.path })
      deleteIndexedPath(engine, plan.workspaceRoot, source.path)
      await indexPathIfPossible(engine, plan.workspaceRoot, target.path)
    }
    plan.confirmed = true
    plan.appliedJournalId = journal.journalId
    await writeJsonFile(planPath(storeDir, planId), plan)
    await writeJsonFile(journalPath(storeDir, journal.journalId), journal)
    return toJsonString({ ok: true, planId, journalId: journal.journalId, executed: journal.operations.length })
  } catch (error) {
    // silent-catch: partial apply failures are journaled and returned as structured tool output.
    await writeJsonFile(journalPath(storeDir, journal.journalId), journal)
    return toJsonString({
      ok: false,
      planId,
      journalId: journal.journalId,
      executed: journal.operations.length,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function runFileOrganizeUndo(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const journalId = typeof args.journalId === 'string' ? args.journalId : ''
  if (!journalId) return toJsonString({ ok: false, error: 'journalId is required' })
  const storeDir = await getFileManagementStoreDir(context)
  const journal = await readJsonFile<OrganizeJournal>(journalPath(storeDir, journalId))
  if (!journal) return toJsonString({ ok: false, journalId, error: 'journal not found' })
  if (journal.undoneAt) return toJsonString({ ok: false, journalId, error: 'journal already undone', undoneAt: journal.undoneAt })
  const auth = await authorizeRoot(journal.rootPath, engine, context?.workspaceRoots)
  if (!auth.ok) return toJsonString(auth.output)
  const undone: string[] = []
  try {
    const reverseMoves = journal.operations
      .filter((op): op is JournalMove => op.type === 'move')
      .reverse()
    for (const op of reverseMoves) {
      const source = resolvePlannedPathInsideRoot(op.sourcePath, auth)
      const target = await resolveExistingPathInsideRoot(op.targetPath, auth)
      if (!source.ok) throw new Error(`source restore path invalid: ${source.error}`)
      if (!target.ok) throw new Error(`moved file missing: ${op.targetPath}`)
      if (existsSync(source.path)) throw new Error(`restore target already exists: ${source.path}`)
      await mkdir(dirname(source.path), { recursive: true })
      await rename(target.path, source.path)
      deleteIndexedPath(engine, journal.workspaceRoot, target.path)
      await indexPathIfPossible(engine, journal.workspaceRoot, source.path)
      undone.push(source.path)
    }
    journal.undoneAt = new Date().toISOString()
    await writeJsonFile(journalPath(storeDir, journalId), journal)
    return toJsonString({
      ok: true,
      journalId,
      restored: undone.length,
      restoredPaths: undone,
      note: 'created folders are left in place to avoid deleting user-created content',
    })
  } catch (error) {
    // silent-catch: rollback failures are returned with the best restored-path evidence available.
    return toJsonString({
      ok: false,
      journalId,
      restored: undone.length,
      restoredPaths: undone,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function runFileRename(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  const newName = typeof args.newName === 'string' ? args.newName.trim() : ''
  const overwrite = args.overwrite === true
  if (!path || !newName) return 'Error: path and newName required'
  if (newName.includes('/') || newName.includes('\\')) return 'Error: newName must not contain path separators'

  const guard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
  if (!guard.ok) return `Error: ${guard.error}`
  const newPath = join(dirname(path), newName)
  const newGuard = assertInsideWorkspace(newPath, engine, context?.workspaceRoots)
  if (!newGuard.ok) return `Error: ${newGuard.error}`

  try {
    const exists = await stat(newPath).then(() => true).catch(() => false)
    if (exists && !overwrite) return toJsonString({ ok: false, error: 'target exists; pass overwrite=true to replace' })
    await rename(path, newPath)
    const db = engine.getRepository().getConnection()
    const existing = db.prepare('SELECT workspace_id FROM documents WHERE path = ?').get<{ workspace_id: number }>(path)
    if (existing) db.prepare('DELETE FROM documents WHERE path = ?').run(path)
    await engine.indexDocument(guard.root, newPath)
    return toJsonString({ ok: true, newPath })
  } catch (error) {
    return toJsonString({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
async function runFileCopy(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  const destDir = typeof args.destDir === 'string' ? args.destDir : ''
  const newName = typeof args.newName === 'string' ? args.newName.trim() : ''
  const overwrite = args.overwrite === true
  if (!path || !destDir) return 'Error: path and destDir required'

  const srcGuard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
  if (!srcGuard.ok) return `Error: ${srcGuard.error}`
  const destGuard = assertInsideWorkspace(destDir, engine, context?.workspaceRoots)
  if (!destGuard.ok) return `Error: ${destGuard.error}`
  if (srcGuard.root !== destGuard.root) return 'Error: cross-workspace copy not supported'

  const fileName = newName || path.split(/[\\/]/).pop() || 'file'
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) return 'Error: newName must not contain path separators'
  const newPath = join(destDir, fileName)
  const newGuard = assertInsideWorkspace(newPath, engine, context?.workspaceRoots)
  if (!newGuard.ok) return `Error: ${newGuard.error}`

  try {
    const sourceStat = await stat(path)
    if (!sourceStat.isFile()) return 'Error: source is not a file'
    const destStat = await stat(destDir).catch(() => null)
    if (!destStat || !destStat.isDirectory()) return 'Error: destDir is not a directory'
    const targetLinkStats = await lstat(newPath).catch(() => null)
    if (targetLinkStats?.isSymbolicLink()) return toJsonString({ ok: false, error: 'refusing to overwrite symlink target' })
    await copyFile(path, newPath, overwrite ? 0 : constants.COPYFILE_EXCL)
    await engine.indexDocument(srcGuard.root, newPath)
    return toJsonString({ ok: true, newPath })
  } catch (error) {
    return toJsonString({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function runFileMove(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  const destDir = typeof args.destDir === 'string' ? args.destDir : ''
  const newName = typeof args.newName === 'string' ? args.newName.trim() : ''
  const overwrite = args.overwrite === true
  if (!path || !destDir) return 'Error: path and destDir required'

  const srcGuard = assertInsideWorkspace(path, engine, context?.workspaceRoots)
  if (!srcGuard.ok) return `Error: ${srcGuard.error}`
  const destGuard = assertInsideWorkspace(destDir, engine, context?.workspaceRoots)
  if (!destGuard.ok) return `Error: ${destGuard.error}`
  if (srcGuard.root !== destGuard.root) return 'Error: cross-workspace move not supported'

  const fileName = newName || path.split(/[\\/]/).pop() || 'file'
  const newPath = join(destDir, fileName)
  const newGuard = assertInsideWorkspace(newPath, engine, context?.workspaceRoots)
  if (!newGuard.ok) return `Error: ${newGuard.error}`

  try {
    const destStat = await stat(destDir).catch(() => null)
    if (!destStat || !destStat.isDirectory()) return 'Error: destDir is not a directory'
    const exists = await stat(newPath).then(() => true).catch(() => false)
    if (exists && !overwrite) return toJsonString({ ok: false, error: 'target exists; pass overwrite=true to replace' })
    await rename(path, newPath)
    const db = engine.getRepository().getConnection()
    db.prepare('DELETE FROM documents WHERE path = ?').run(path)
    await engine.indexDocument(srcGuard.root, newPath)
    return toJsonString({ ok: true, newPath })
  } catch (error) {
    return toJsonString({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
