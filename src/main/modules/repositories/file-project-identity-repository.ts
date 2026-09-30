import type { DatabaseConnection } from '../database/connection'
import { randomUUID } from 'crypto'
import { isAbsolute, relative } from 'path'



export type FileIdentityStatus = 'present' | 'missing' | 'deleted'
export type ProjectIdentityStatus = 'active' | 'snoozed' | 'hidden' | 'merged'
export type ProjectIdentitySource =
  | 'user'
  | 'frontmatter'
  | 'tab_group'
  | 'task'
  | 'attachment'
  | 'directory_consensus'
  | 'fallback'

export interface FileIdentityRecord {
  fileKey: string
  workspaceRoot: string
  currentPath: string
  status: FileIdentityStatus
  contentHash: string | null
  observedSince: number
  lastVerifiedAt: number
}

export interface ProjectIdentityRecord {
  projectKey: string
  workspaceRoot: string
  displayName: string
  source: ProjectIdentitySource
  confidence: number
  status: ProjectIdentityStatus
  anchorPath: string | null
  aliases: string[]
  evidence: Array<Record<string, unknown>>
  createdAt: number
  updatedAt: number
}

interface FileIdentityRow {
  file_key: string
  workspace_root: string
  current_path: string
  status: FileIdentityStatus
  content_hash: string | null
  observed_since: number
  last_verified_at: number
}

interface ProjectIdentityRow {
  project_key: string
  workspace_root: string
  display_name: string
  source: ProjectIdentitySource
  confidence: number
  status: ProjectIdentityStatus
  anchor_path: string | null
  aliases_json: string
  evidence_json: string
  created_at: number
  updated_at: number
}

const SOURCE_PRIORITY: Record<ProjectIdentitySource, number> = {
  user: 100,
  frontmatter: 80,
  tab_group: 70,
  task: 60,
  attachment: 55,
  directory_consensus: 40,
  fallback: 10,
}

export class FileProjectIdentityRepository {
  constructor(private readonly db: DatabaseConnection) {}

  ensureFile(input: {
    workspaceRoot: string
    path: string
    contentHash?: string | null
    observedAt?: number
  }): FileIdentityRecord {
    assertPathInWorkspace(input.path, input.workspaceRoot)
    const now = input.observedAt ?? Date.now()
    const existing = this.findFileByCurrentPath(input.workspaceRoot, input.path)
    if (existing) {
      this.db.prepare(`
        UPDATE file_identities
        SET status = 'present', content_hash = COALESCE(?, content_hash), last_verified_at = ?
        WHERE file_key = ?
      `).run(input.contentHash ?? null, now, existing.fileKey)
      return this.getFile(existing.fileKey)!
    }
    const fileKey = randomUUID()
    this.db.prepare(`
      INSERT INTO file_identities (
        file_key, workspace_root, current_path, status, content_hash, observed_since, last_verified_at
      ) VALUES (?, ?, ?, 'present', ?, ?, ?)
    `).run(fileKey, input.workspaceRoot, input.path, input.contentHash ?? null, now, now)
    return this.getFile(fileKey)!
  }

  getFile(fileKey: string): FileIdentityRecord | null {
    const row = this.db.prepare('SELECT * FROM file_identities WHERE file_key = ?')
      .get<FileIdentityRow>(fileKey)
    return row ? fileRow(row) : null
  }

  findFileByCurrentPath(workspaceRoot: string, path: string): FileIdentityRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM file_identities WHERE workspace_root = ? AND current_path = ? LIMIT 1
    `).get<FileIdentityRow>(workspaceRoot, path)
    return row ? fileRow(row) : null
  }

  resolveFileByObservedPath(workspaceRoot: string, path: string): FileIdentityRecord | null {
    const current = this.findFileByCurrentPath(workspaceRoot, path)
    if (current) return current
    const receipt = this.db.prepare(`
      SELECT file_key FROM file_move_receipts
      WHERE workspace_root = ? AND old_path = ?
      ORDER BY moved_at DESC LIMIT 1
    `).get<{ file_key: string }>(workspaceRoot, path)
    return receipt ? this.getFile(receipt.file_key) : null
  }

  findWorkspaceRootForMove(oldPath: string): string | null {
    const row = this.db.prepare(`
      SELECT workspace_root FROM file_identities
      WHERE current_path = ? OR current_path LIKE ? ESCAPE '\\'
      ORDER BY length(current_path) ASC LIMIT 1
    `).get<{ workspace_root: string }>(oldPath, `${escapeLike(oldPath)}/%`)
    if (row?.workspace_root) return row.workspace_root
    const project = this.db.prepare(`
      SELECT workspace_root FROM project_identities
      WHERE anchor_path = ? OR anchor_path LIKE ? ESCAPE '\\'
      ORDER BY length(anchor_path) ASC LIMIT 1
    `).get<{ workspace_root: string }>(oldPath, `${escapeLike(oldPath)}/%`)
    return project?.workspace_root || null
  }

  recordInternalMove(input: {
    workspaceRoot: string
    oldPath: string
    newPath: string
    kind: 'file' | 'directory'
    movedAt?: number
  }): FileIdentityRecord[] {
    assertPathInWorkspace(input.oldPath, input.workspaceRoot)
    assertPathInWorkspace(input.newPath, input.workspaceRoot)
    const movedAt = input.movedAt ?? Date.now()
    let identities = this.listFilesUnder(input.workspaceRoot, input.oldPath, input.kind === 'directory')
    if (identities.length === 0) {
      const receipts = input.kind === 'directory'
        ? this.db.prepare(`
            SELECT file_key FROM file_move_receipts
            WHERE workspace_root = ? AND old_path LIKE ? ESCAPE '\\' AND new_path LIKE ? ESCAPE '\\'
            ORDER BY moved_at DESC
          `).all<{ file_key: string }>(input.workspaceRoot, `${escapeLike(input.oldPath)}/%`, `${escapeLike(input.newPath)}/%`)
        : this.db.prepare(`
            SELECT file_key FROM file_move_receipts
            WHERE workspace_root = ? AND old_path = ? AND new_path = ?
            ORDER BY moved_at DESC
          `).all<{ file_key: string }>(input.workspaceRoot, input.oldPath, input.newPath)
      if (receipts.length > 0) {
        return uniqueStrings(receipts.map((receipt) => receipt.file_key))
          .map((fileKey) => this.getFile(fileKey))
          .filter((file): file is FileIdentityRecord => Boolean(file))
      }
    }
    if (identities.length === 0 && input.kind === 'file') {
      identities = [this.ensureFile({ workspaceRoot: input.workspaceRoot, path: input.oldPath, observedAt: movedAt })]
    }

    this.db.exec('BEGIN')
    try {
      for (const identity of identities) {
        const nextPath = replacePathPrefix(identity.currentPath, input.oldPath, input.newPath)
        const conflict = this.findFileByCurrentPath(input.workspaceRoot, nextPath)
        if (conflict && conflict.fileKey !== identity.fileKey) {
          throw new Error(`file identity target already exists: ${nextPath}`)
        }
        this.db.prepare(`
          UPDATE file_identities
          SET current_path = ?, status = 'present', last_verified_at = ?
          WHERE file_key = ?
        `).run(nextPath, movedAt, identity.fileKey)
        this.db.prepare(`
          INSERT OR IGNORE INTO file_move_receipts (
            receipt_id, file_key, workspace_root, old_path, new_path, move_kind, moved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), identity.fileKey, input.workspaceRoot, identity.currentPath, nextPath, input.kind, movedAt)
      }
      this.db.prepare(`
        UPDATE project_identities
        SET anchor_path = CASE
          WHEN anchor_path = ? THEN ?
          WHEN anchor_path LIKE ? THEN ? || substr(anchor_path, length(?) + 1)
          ELSE anchor_path
        END,
        updated_at = ?
        WHERE workspace_root = ? AND (anchor_path = ? OR anchor_path LIKE ? ESCAPE '\\')
      `).run(
        input.oldPath,
        input.newPath,
        `${escapeLike(input.oldPath)}/%`,
        input.newPath,
        input.oldPath,
        movedAt,
        input.workspaceRoot,
        input.oldPath,
        `${escapeLike(input.oldPath)}/%`,
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return identities.map((identity) => this.getFile(identity.fileKey)!).filter(Boolean)
  }

  resolveOrCreateProject(input: {
    workspaceRoot: string
    displayName: string
    source: ProjectIdentitySource
    confidence: number
    anchorPath?: string | null
    filePaths: readonly string[]
    evidence?: Array<Record<string, unknown>>
    observedAt?: number
  }): ProjectIdentityRecord {
    const now = input.observedAt ?? Date.now()
    const files = input.filePaths.map((path) => this.ensureFile({
      workspaceRoot: input.workspaceRoot,
      path,
      observedAt: now,
    }))
    const existing = this.findProjectForFiles(files.map((file) => file.fileKey)) ||
      this.findProjectByAnchor(input.workspaceRoot, input.anchorPath ?? null)
    const project = existing || this.createProject({ ...input, observedAt: now })

    if (project.source !== 'user' && SOURCE_PRIORITY[input.source] >= SOURCE_PRIORITY[project.source]) {
      const aliases = uniqueStrings([
        ...project.aliases,
        ...(project.displayName !== input.displayName ? [project.displayName] : []),
      ])
      this.db.prepare(`
        UPDATE project_identities
        SET display_name = ?, source = ?, confidence = ?, anchor_path = COALESCE(?, anchor_path),
            aliases_json = ?, evidence_json = ?, updated_at = ?
        WHERE project_key = ?
      `).run(
        input.displayName,
        input.source,
        clamp01(input.confidence),
        input.anchorPath ?? null,
        JSON.stringify(aliases),
        JSON.stringify(input.evidence ?? project.evidence),
        now,
        project.projectKey,
      )
    }
    for (const file of files) {
      this.assignFile({
        projectKey: project.projectKey,
        fileKey: file.fileKey,
        source: input.source,
        confidence: input.confidence,
        updatedAt: now,
      })
    }
    return this.getProject(project.projectKey)!
  }

  getProject(projectKey: string): ProjectIdentityRecord | null {
    const row = this.db.prepare('SELECT * FROM project_identities WHERE project_key = ?')
      .get<ProjectIdentityRow>(projectKey)
    return row ? projectRow(row) : null
  }

  listProjects(workspaceRoots: readonly string[]): ProjectIdentityRecord[] {
    const roots = uniqueStrings(workspaceRoots)
    if (roots.length === 0) return []
    const placeholders = roots.map(() => '?').join(',')
    return this.db.prepare(`
      SELECT * FROM project_identities
      WHERE workspace_root IN (${placeholders}) AND status = 'active'
      ORDER BY updated_at DESC
    `).all<ProjectIdentityRow>(...roots).map(projectRow)
  }

  listProjectFiles(projectKey: string): FileIdentityRecord[] {
    return this.db.prepare(`
      SELECT f.* FROM file_identities f
      JOIN project_identity_members m ON m.file_key = f.file_key
      WHERE m.project_key = ?
      ORDER BY f.current_path
    `).all<FileIdentityRow>(projectKey).map(fileRow)
  }

  renameProject(projectKey: string, displayName: string, updatedAt = Date.now()): ProjectIdentityRecord {
    const project = this.getProject(projectKey)
    if (!project) throw new Error('project identity not found')
    const name = validateDisplayName(displayName)
    const aliases = uniqueStrings([...project.aliases, project.displayName])
    this.db.prepare(`
      UPDATE project_identities
      SET display_name = ?, source = 'user', confidence = 1, aliases_json = ?, updated_at = ?
      WHERE project_key = ?
    `).run(name, JSON.stringify(aliases), updatedAt, projectKey)
    return this.getProject(projectKey)!
  }

  assignPathToProject(input: {
    projectKey: string
    workspaceRoot: string
    path: string
    updatedAt?: number
  }): ProjectIdentityRecord {
    const project = this.getProject(input.projectKey)
    if (!project) throw new Error('project identity not found')
    if (project.workspaceRoot !== input.workspaceRoot) throw new Error('project and file workspace differ')
    const file = this.ensureFile({ workspaceRoot: input.workspaceRoot, path: input.path, observedAt: input.updatedAt })
    this.assignFile({ projectKey: project.projectKey, fileKey: file.fileKey, source: 'user', confidence: 1, updatedAt: input.updatedAt })
    return this.getProject(project.projectKey)!
  }

  createUserProjectForPath(input: {
    workspaceRoot: string
    path: string
    displayName: string
    updatedAt?: number
  }): ProjectIdentityRecord {
    const now = input.updatedAt ?? Date.now()
    const file = this.ensureFile({ workspaceRoot: input.workspaceRoot, path: input.path, observedAt: now })
    const project = this.createProject({
      workspaceRoot: input.workspaceRoot,
      displayName: input.displayName,
      source: 'user',
      confidence: 1,
      anchorPath: input.path,
      evidence: [{ source: 'user', path: input.path }],
      observedAt: now,
    })
    this.assignFile({ projectKey: project.projectKey, fileKey: file.fileKey, source: 'user', confidence: 1, updatedAt: now })
    return this.getProject(project.projectKey)!
  }

  private createProject(input: {
    workspaceRoot: string
    displayName: string
    source: ProjectIdentitySource
    confidence: number
    anchorPath?: string | null
    evidence?: Array<Record<string, unknown>>
    observedAt: number
  }): ProjectIdentityRecord {
    const projectKey = randomUUID()
    const displayName = validateDisplayName(input.displayName)
    if (input.anchorPath) assertPathInWorkspace(input.anchorPath, input.workspaceRoot)
    this.db.prepare(`
      INSERT INTO project_identities (
        project_key, workspace_root, display_name, source, confidence, status, anchor_path,
        aliases_json, evidence_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, '[]', ?, ?, ?)
    `).run(
      projectKey,
      input.workspaceRoot,
      displayName,
      input.source,
      clamp01(input.confidence),
      input.anchorPath ?? null,
      JSON.stringify(input.evidence ?? []),
      input.observedAt,
      input.observedAt,
    )
    return this.getProject(projectKey)!
  }

  private assignFile(input: {
    projectKey: string
    fileKey: string
    source: ProjectIdentitySource
    confidence: number
    updatedAt?: number
  }): void {
    const now = input.updatedAt ?? Date.now()
    this.db.prepare('DELETE FROM project_identity_members WHERE file_key = ? AND project_key <> ?')
      .run(input.fileKey, input.projectKey)
    this.db.prepare(`
      INSERT INTO project_identity_members (
        project_key, file_key, source, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key, file_key) DO UPDATE SET
        source = CASE WHEN project_identity_members.source = 'user' THEN 'user' ELSE excluded.source END,
        confidence = CASE WHEN project_identity_members.source = 'user' THEN 1 ELSE excluded.confidence END,
        updated_at = excluded.updated_at
    `).run(input.projectKey, input.fileKey, input.source, clamp01(input.confidence), now, now)
  }

  private findProjectForFiles(fileKeys: readonly string[]): ProjectIdentityRecord | null {
    const keys = uniqueStrings(fileKeys)
    if (keys.length === 0) return null
    const placeholders = keys.map(() => '?').join(',')
    const row = this.db.prepare(`
      SELECT p.*, COUNT(*) AS support
      FROM project_identities p
      JOIN project_identity_members m ON m.project_key = p.project_key
      WHERE m.file_key IN (${placeholders}) AND p.status <> 'merged'
      GROUP BY p.project_key
      ORDER BY support DESC, p.updated_at DESC
      LIMIT 1
    `).get<ProjectIdentityRow>(...keys)
    return row ? projectRow(row) : null
  }

  private findProjectByAnchor(workspaceRoot: string, anchorPath: string | null): ProjectIdentityRecord | null {
    if (!anchorPath) return null
    const row = this.db.prepare(`
      SELECT * FROM project_identities
      WHERE workspace_root = ? AND anchor_path = ? AND status <> 'merged'
      ORDER BY updated_at DESC LIMIT 1
    `).get<ProjectIdentityRow>(workspaceRoot, anchorPath)
    return row ? projectRow(row) : null
  }

  private listFilesUnder(workspaceRoot: string, path: string, includeDescendants: boolean): FileIdentityRecord[] {
    if (!includeDescendants) {
      const exact = this.findFileByCurrentPath(workspaceRoot, path)
      return exact ? [exact] : []
    }
    const rows = this.db.prepare(`
      SELECT * FROM file_identities
      WHERE workspace_root = ? AND (current_path = ? OR current_path LIKE ? ESCAPE '\\')
      ORDER BY current_path
    `).all<FileIdentityRow>(workspaceRoot, path, `${escapeLike(path)}/%`)
    return rows.map(fileRow)
  }
}

function fileRow(row: FileIdentityRow): FileIdentityRecord {
  return {
    fileKey: row.file_key,
    workspaceRoot: row.workspace_root,
    currentPath: row.current_path,
    status: row.status,
    contentHash: row.content_hash,
    observedSince: row.observed_since,
    lastVerifiedAt: row.last_verified_at,
  }
}

function projectRow(row: ProjectIdentityRow): ProjectIdentityRecord {
  return {
    projectKey: row.project_key,
    workspaceRoot: row.workspace_root,
    displayName: row.display_name,
    source: row.source,
    confidence: row.confidence,
    status: row.status,
    anchorPath: row.anchor_path,
    aliases: parseStringArray(row.aliases_json),
    evidence: parseRecordArray(row.evidence_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function validateDisplayName(raw: string): string {
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!name) throw new Error('project name is required')
  if (name.length > 64) throw new Error('project name is too long')
  return name
}

function assertPathInWorkspace(path: string, workspaceRoot: string): void {
  if (!isAbsolute(path) || !isAbsolute(workspaceRoot)) throw new Error('identity path must be absolute')
  const rel = relative(workspaceRoot, path)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('identity path is outside workspace')
}

function replacePathPrefix(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath
  if (!path.startsWith(`${oldPath}/`)) throw new Error('path is outside moved prefix')
  return `${newPath}${path.slice(oldPath.length)}`
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseRecordArray(raw: string): Array<Record<string, unknown>> {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      : []
  } catch {
    return []
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
