import { createHash } from 'crypto'
import { ipcMain } from 'electron'
import { getDatabase } from '../database'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { ObjectRegistry } from '../object-service/registry'
import { TagForgeRepository } from '../repositories/tag-forge-repository'
import { getSearchEngine } from '../search-engine/ipc-handler'
import {
  TAG_FORGE_AUTO_SETTING_KEY,
  type TagForgeFinalizeCreationPayload,
  type TagForgePrepareCreationPayload,
} from '../../../shared/tag-forge'
import { loadTagForgePolicy } from './tag-forge-policy'
import {
  buildTagForgeCreationContent,
  creationFrontmatterRevision,
  matchesTagForgeCreationContent,
  validateTagForgeCreationProposals,
} from './tag-forge-creation-validation'
import {
  finalizeTagForgeCreation,
  parseCreationValidationSnapshot,
  resolveSafeMarkdownPath,
  type CreationValidationSnapshot,
} from './tag-forge-creation-finalizer'

export function setupTagForgeIPC(): void {
  for (const channel of [
    'tagForge:prepareCreation',
    'tagForge:finalizeCreation',
  ]) ipcMain.removeHandler(channel)

  ipcMain.handle('tagForge:prepareCreation', async (_event, payload: TagForgePrepareCreationPayload) => {
    let receiptId = ''
    try {
      const runId = String(payload?.sourceRunId || '').trim()
      if (!runId) return { success: false, errorKind: 'run_id_required' }
      if (new AppSettingsRepository().getSetting(TAG_FORGE_AUTO_SETTING_KEY) === 'false') return { success: true, data: null }
      const checked = await resolveSafeMarkdownPath(String(payload?.path || ''), Array.isArray(payload?.workspaceRoots) ? payload.workspaceRoots : [])
      if (!checked) return { success: false, errorKind: 'invalid_path' }
      const db = getDatabase().getRawDb()
      if (!db) return { success: false, errorKind: 'database_unavailable' }

      const identity = new ObjectRegistry(db).reserve(checked.path)
      const repo = new TagForgeRepository(db)
      const current = repo.findOpenCreationReceipt(runId, identity.id)
      const recoverable = current ?? repo.findRecoverableCreationReceipt(identity.id)
      if (!current && !payload.creationPending && !recoverable) return { success: true, data: null }
      receiptId = current?.receiptId ?? repo.mintCreationReceipt({ sourceRunId: runId, fileKey: identity.id })

      const content = String(payload?.content || '')
      const proposals = Array.isArray(payload?.proposals) ? payload.proposals : []
      const previous = parseCreationValidationSnapshot(current?.validationJson ?? recoverable?.validationJson ?? null)
      const previousManualTagIds = new Set(previous?.preservedManualTagIds ?? [])
      const previousAutomaticTags = previous?.tags.filter((tag) => tag.facet !== 'state' && !previousManualTagIds.has(tag.tagId)) ?? []
      const policy = loadTagForgePolicy()
      const overlay = repo.listOverlay()
      let snapshot: CreationValidationSnapshot | null = null
      let missingContentFacets: Array<'form' | 'topic'> = ['form', 'topic']
      let rejectedLabels: string[] = []
      let errorKind: 'tag_evidence_missing' | 'insufficient_content_tags' = 'insufficient_content_tags'

      if (proposals.length === 0 && previous && matchesTagForgeCreationContent(previous, content)) {
        snapshot = previous
      } else {
        const stagedEntries = proposals.length === 0 && previous
          ? previous.admittedEntries.filter((entry) => !overlay.some((currentEntry) => currentEntry.id === entry.id))
          : []
        const result = validateTagForgeCreationProposals(
          policy,
          proposals,
          content,
          [...overlay, ...stagedEntries],
        )
        if (result.ok) {
          snapshot = {
            tags: result.tags,
            admittedEntries: result.admittedEntries,
            bodyRevision: result.bodyRevision,
            preservedManualTagIds: result.preservedManualTagIds,
          }
        } else {
          missingContentFacets = result.missingContentFacets
          rejectedLabels = result.rejectedLabels
          errorKind = result.errorKind
        }
      }

      if (!snapshot) {
        repo.markReceipt(receiptId, 'failed_retryable', errorKind)
        return {
          success: false,
          data: { receiptId },
          errorKind,
          error: errorKind === 'tag_evidence_missing' ? '标签证据未在最终正文中找到' : '缺少完整的形态与主题标签',
          missingContentFacets,
          rejectedLabels,
        }
      }

      const finalContent = buildTagForgeCreationContent(policy, content, snapshot.tags, [...overlay, ...snapshot.admittedEntries], previousAutomaticTags)
      snapshot.frontmatterRevision = creationFrontmatterRevision(finalContent)
      const revision = hash(finalContent)
      repo.storeCreationValidation(receiptId, revision, JSON.stringify(snapshot))
      if (recoverable && recoverable.receiptId !== receiptId) repo.supersedeCreationReceipt(recoverable.receiptId)
      return {
        success: true,
        data: {
          receiptId,
          content: finalContent,
          tags: snapshot.tags.filter((tag) => tag.facet !== 'state').map((tag) => tag.label),
          workflowState: snapshot.tags.find((tag) => tag.facet === 'state')?.label ?? null,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, data: receiptId ? { receiptId } : undefined, errorKind: 'creation_prepare_failed', error: message }
    }
  })

  ipcMain.handle('tagForge:finalizeCreation', async (_event, payload: TagForgeFinalizeCreationPayload) => {
    const db = getDatabase().getRawDb()
    if (!db) return { success: false, errorKind: 'database_unavailable' }
    return finalizeTagForgeCreation(payload, { db, searchEngine: getSearchEngine() })
  })
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
