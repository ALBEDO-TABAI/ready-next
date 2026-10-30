import { ObjectRegistry } from '../object-service/registry'
import type { DatabaseConnection } from '../database/connection'
import { createHash } from 'crypto'
import { lstat, readFile, realpath } from 'fs/promises'
import { isAbsolute, relative, resolve } from 'path'

import { FileProjectIdentityRepository } from '../repositories/file-project-identity-repository'
import { TagForgeRepository } from '../repositories/tag-forge-repository'
import { buildSearchIndexContentHash } from '../search-engine/adapters'
import type { SearchEngine } from '../search-engine/indexer'
import type { TagForgeCreationReceipt, TagForgeFinalizeCreationPayload } from '../../../shared/tag-forge'
import { loadTagForgePolicy, type TagLexiconEntry, type ValidatedTag } from './tag-forge-policy'
import { verifyTagForgeCreationFinalContent } from './tag-forge-creation-validation'

type ActiveOverlayEntry = Omit<TagLexiconEntry, 'status'> & { status: 'active' }

export interface CreationValidationSnapshot {
  tags: ValidatedTag[]
  admittedEntries: ActiveOverlayEntry[]
  bodyRevision: string
  frontmatterRevision?: string
  preservedManualTagIds?: string[]
}

export interface TagForgeCreationFinalizeDeps {
  db: DatabaseConnection
  searchEngine: Pick<SearchEngine, 'indexDocument'> | null
}

interface FinalizeSuccess {
  success: true
  data: TagForgeCreationReceipt & { status: 'completed' }
}

interface FinalizeFailure {
  success: false
  errorKind: string
  error?: string
}

export type TagForgeCreationFinalizeResult = FinalizeSuccess | FinalizeFailure

const finalizeInFlight = new Map<string, Promise<TagForgeCreationFinalizeResult>>()

export function finalizeTagForgeCreation(
  payload: TagForgeFinalizeCreationPayload,
  deps: TagForgeCreationFinalizeDeps,
): Promise<TagForgeCreationFinalizeResult> {
  const runId = String(payload?.sourceRunId || '').trim()
  const receiptId = String(payload?.receiptId || '').trim()
  if (!runId || !receiptId) return Promise.resolve({ success: false, errorKind: 'creation_receipt_required' })
  const key = `${runId}:${receiptId}`
  const current = finalizeInFlight.get(key)
  const task = current
    ? current.catch(() => undefined).then(() => runFinalizeTagForgeCreation(payload, deps))
    : runFinalizeTagForgeCreation(payload, deps)
  finalizeInFlight.set(key, task)
  return task.finally(() => {
    if (finalizeInFlight.get(key) === task) finalizeInFlight.delete(key)
  })
}

async function runFinalizeTagForgeCreation(
  payload: TagForgeFinalizeCreationPayload,
  deps: TagForgeCreationFinalizeDeps,
): Promise<TagForgeCreationFinalizeResult> {
  const runId = String(payload.sourceRunId).trim()
  const receiptId = String(payload.receiptId).trim()
  const checked = await resolveSafeMarkdownPath(String(payload.path || ''), Array.isArray(payload.workspaceRoots) ? payload.workspaceRoots : [])
  if (!checked) return { success: false, errorKind: 'invalid_path' }

  const repo = new TagForgeRepository(deps.db)
  const durable = repo.getCreationReceipt(receiptId, runId)
  const identity = new FileProjectIdentityRepository(deps.db).findFileByCurrentPath(checked.root, checked.path)
  if (!durable || !identity || durable.fileKey !== identity.fileKey || !durable.finalSaveHash) {
    return { success: false, errorKind: 'creation_finalize_failed', error: 'creation_receipt_mismatch' }
  }
  if (durable.status === 'completed') {
    return { success: true, data: { receiptId, revision: durable.finalSaveHash, path: checked.path, status: 'completed' } }
  }
  if (durable.status !== 'pending' && durable.status !== 'failed_retryable') {
    return { success: false, errorKind: 'creation_finalize_failed', error: 'creation_receipt_mismatch' }
  }
  const snapshot = parseCreationValidationSnapshot(durable.validationJson)
  if (!snapshot) return { success: false, errorKind: 'creation_finalize_failed', error: 'creation_receipt_mismatch' }
  if (!deps.searchEngine) return { success: false, errorKind: 'creation_finalize_failed', error: 'search_engine_unavailable' }

  let rollback: { assignments: ReturnType<TagForgeRepository['snapshotAssignments']>; overlayIds: string[] } | null = null
  let indexStarted = false
  try {
    const beforeIndex = await readFile(checked.path, 'utf8')
    const revision = hash(beforeIndex)
    if (revision !== durable.finalSaveHash) throw new Error('creation_final_save_mismatch')
    const policy = loadTagForgePolicy()
    const overlay = repo.listOverlay()
    const readback = verifyTagForgeCreationFinalContent(policy, beforeIndex, snapshot.tags, snapshot.bodyRevision, [...overlay, ...snapshot.admittedEntries])
    if (!readback.ok) throw new Error(readback.errorKind)

    const existingOverlayIds = new Set(overlay.map((entry) => entry.id))
    rollback = {
      assignments: repo.snapshotAssignments(identity.fileKey),
      overlayIds: snapshot.admittedEntries.filter((entry) => !existingOverlayIds.has(entry.id)).map((entry) => entry.id),
    }
    for (const entry of snapshot.admittedEntries) repo.upsertOverlay(entry)
    repo.replaceAutomaticAssignments(
      identity.fileKey,
      snapshot.tags,
      'tag_forge_auto',
      policy.version,
      Date.now(),
      snapshot.preservedManualTagIds ? new Set(snapshot.preservedManualTagIds) : undefined,
    )

    indexStarted = true
    const indexed = await deps.searchEngine.indexDocument(checked.root, checked.path, beforeIndex)
    if (!indexed?.ok) throw new Error('index_readback_failed')
    const afterIndex = await readFile(checked.path, 'utf8')
    if (hash(afterIndex) !== revision) throw new Error('post_index_disk_mismatch')
    const finalReadback = verifyTagForgeCreationFinalContent(policy, afterIndex, snapshot.tags, snapshot.bodyRevision, repo.listOverlay())
    if (!finalReadback.ok) throw new Error(finalReadback.errorKind)

    const indexedRow = readIndexedDocument(deps.db, checked.root, checked.path)
    if (indexedRow.contentHash !== buildSearchIndexContentHash(afterIndex)
      || JSON.stringify(indexedRow.frontmatter.tags) !== JSON.stringify(finalReadback.diskTags)
      || indexedRow.frontmatter.ready_state !== finalReadback.workflowState) {
      throw new Error('index_readback_mismatch')
    }

    repo.markReadback(identity.fileKey)
    repo.markReceipt(receiptId, 'completed')
    rollback = null
    return { success: true, data: { receiptId, revision, path: checked.path, status: 'completed' } }
  } catch (error) {
    if (rollback) {
      repo.restoreAssignments(identity.fileKey, rollback.assignments)
      for (const id of rollback.overlayIds) repo.removeOverlayIfUnassigned(id)
    }
    let errorCode = error instanceof Error ? error.message : String(error)
    if (indexStarted) {
      const restored = await restoreIndexToDiskTruth(deps.db, deps.searchEngine, checked.root, checked.path)
      if (!restored) errorCode = 'index_recovery_failed'
    }
    repo.markReceipt(receiptId, 'failed_retryable', errorCode)
    return { success: false, errorKind: 'creation_finalize_failed', error: errorCode }
  }
}

export function parseCreationValidationSnapshot(raw: string | null): CreationValidationSnapshot | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as CreationValidationSnapshot
    if (!Array.isArray(value.tags) || !Array.isArray(value.admittedEntries) || typeof value.bodyRevision !== 'string') return null
    if (value.frontmatterRevision !== undefined && typeof value.frontmatterRevision !== 'string') return null
    if (value.preservedManualTagIds !== undefined && (!Array.isArray(value.preservedManualTagIds) || value.preservedManualTagIds.some((id) => typeof id !== 'string'))) return null
    return value
  } catch {
    return null
  }
}

export async function resolveSafeMarkdownPath(raw: string, roots: string[]): Promise<{ path: string; root: string } | null> {
  if (!isAbsolute(raw) || !raw.toLowerCase().endsWith('.md')) return null
  const path = resolve(raw)
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) return null
  const real = await realpath(path).catch(() => null)
  if (!real) return null
  for (const rawRoot of roots) {
    if (!isAbsolute(rawRoot)) continue
    const root = await realpath(resolve(rawRoot)).catch(() => null)
    if (!root) continue
    const rel = relative(root, real)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return { path: real, root }
  }
  return null
}

async function restoreIndexToDiskTruth(
  db: DatabaseConnection,
  engine: Pick<SearchEngine, 'indexDocument'>,
  root: string,
  path: string,
): Promise<boolean> {
  try {
    const content = await readFile(path, 'utf8')
    const indexed = await engine.indexDocument(root, path, content)
    if (!indexed?.ok) return false
    return readIndexedDocument(db, root, path).contentHash === buildSearchIndexContentHash(content)
  } catch {
    return false
  }
}

function readIndexedDocument(db: DatabaseConnection, _root: string, path: string): { contentHash: string | null; frontmatter: Record<string, unknown> } {
  const row = db.prepare(`SELECT d.frontmatter_json AS frontmatter,d.content_hash AS contentHash FROM documents d WHERE d.object_id=?`).get<{ frontmatter: string | null; contentHash: string | null }>(new ObjectRegistry(db).find(path)?.id ?? null)
  let frontmatter: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row?.frontmatter || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>
  } catch {
    // A malformed indexed row fails the caller's readback comparison.
  }
  return { contentHash: row?.contentHash ?? null, frontmatter }
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
