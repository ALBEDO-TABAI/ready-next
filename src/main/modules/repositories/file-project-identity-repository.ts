import type { DatabaseConnection } from '../database/connection'
import { randomUUID } from 'crypto'
import { isAbsolute, relative } from 'path'
import { ObjectRegistry, canonicalObjectPath, type ObjectRecord } from '../object-service/registry'



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

  requireFile(input: {workspaceRoot:string;path:string;observedAt?:number}):FileIdentityRecord {
    const file=this.findFileByCurrentPath(input.workspaceRoot,input.path)
    if(!file)throw new Error('Object has not been verified: '+input.path)
    return file
  }

  getFile(fileKey:string):FileIdentityRecord|null {
    const row=new ObjectRegistry(this.db).get(fileKey)
    return row?.status==='present' && row.identity_state!=='conflict' ? this.fileRecord(row) : null
  }

  findFileByCurrentPath(workspaceRoot:string,path:string):FileIdentityRecord|null {
    assertPathInWorkspace(path,workspaceRoot)
    const row=new ObjectRegistry(this.db).find(path)
    return row && row.identity_state!=='conflict' ? this.fileRecord(row) : null
  }

  private fileRecord(row:ObjectRecord):FileIdentityRecord {
    const root=row.workspace_id===null ? '' : this.db.prepare('SELECT root FROM workspaces WHERE id=?').get<{root:string}>(row.workspace_id)?.root??''
    return {fileKey:row.id,workspaceRoot:root,currentPath:row.current_path!,status:'present',contentHash:row.content_hash,observedSince:row.observed_since,lastVerifiedAt:row.last_verified_at!}
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
    const files = input.filePaths.map((path) => this.requireFile({
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
      SELECT f.* FROM objects f
      JOIN project_identity_members m ON m.object_id = f.id
      WHERE m.project_key = ? AND f.status='present' AND f.identity_state<>'conflict'
      ORDER BY f.current_path
    `).all<ObjectRecord>(projectKey).map(row=>this.fileRecord(row))
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
    const file = this.requireFile({ workspaceRoot: input.workspaceRoot, path: input.path, observedAt: input.updatedAt })
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
    const file = this.requireFile({ workspaceRoot: input.workspaceRoot, path: input.path, observedAt: now })
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
    this.db.prepare('DELETE FROM project_identity_members WHERE object_id = ? AND project_key <> ?')
      .run(input.fileKey, input.projectKey)
    this.db.prepare(`
      INSERT INTO project_identity_members (
        project_key, object_id, source, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key, object_id) DO UPDATE SET
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
      WHERE m.object_id IN (${placeholders}) AND p.status <> 'merged'
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
  const rel = relative(canonicalObjectPath(workspaceRoot), canonicalObjectPath(path))
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('identity path is outside workspace')
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
