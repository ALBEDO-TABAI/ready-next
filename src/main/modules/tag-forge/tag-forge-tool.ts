import { readFile } from 'fs/promises'
import { realpathSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import type { SearchEngine } from '../search-engine/indexer'
import { buildSearchIndexContentHash } from '../search-engine/adapters'
import { FileProjectIdentityRepository } from '../repositories/file-project-identity-repository'
import { TagForgeRepository } from '../repositories/tag-forge-repository'
import {
  evaluateControlledContentLabels,
  loadTagForgePolicy,
  resolveActiveTagEntry,
  validateTagProposals,
  type TagForgePolicy,
  type TagLexiconEntry,
  type TagProposal,
} from './tag-forge-policy'
import { revisionOf, rollbackControlledWrite, writeControlledTags, type TagForgeWriteResult } from './tag-forge-writer'
import { evidenceOccursInContent, selectEvidenceBackedAdmissions } from './tag-forge-admission'
import { parseDocumentGraph } from '../../../shared/document-graph-parse'
import { extractDocumentTagLabels } from './tag-forge-content-tags'

export interface TagForgeToolContext {
  workspaceRoots?: string[] | null
  runId?: string | null
  scopeId?: string | null
  batchId?: string | null
  itemId?: string | null
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export async function executeTagForgeApply(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: TagForgeToolContext,
): Promise<string> {
  const path = typeof args.path === 'string' ? args.path : ''
  const expectedRevision = typeof args.expectedRevision === 'string' ? args.expectedRevision : ''
  const rawProposals = Array.isArray(args.proposals) ? args.proposals : []
  if (!path || !expectedRevision || rawProposals.length === 0) {
    return json({ ok: false, errorKind: 'invalid_tag_forge_input' })
  }

  const root = workspaceRootFor(path, engine, context?.workspaceRoots)
  if (!root) return json({ ok: false, errorKind: 'workspace_boundary_rejected', error: 'path is outside any known workspace' })
  const db = engine.getRepository().getConnection()
  const identities = new FileProjectIdentityRepository(db)
  const file = identities.ensureFile({ workspaceRoot: root, path })
  const repo = new TagForgeRepository(db)
  if (context?.requestModuleToolAction) {
    const lease = await context.requestModuleToolAction('tagForge.checkRevision', { path, expectedRevision })
    if (lease.ok === false) {
      return json({ ok: false, status: 'failed_terminal', errorKind: 'open_tab_revision_conflict' })
    }
  }

  const runId = context?.runId ?? ''
  const content = await readFile(path, 'utf8').catch(() => null)
  if (content === null) return json({ ok: false, status: 'failed_terminal', errorKind: 'tag_read_failed' })
  if (revisionOf(content) !== expectedRevision) return json({ ok: false, status: 'failed_terminal', errorKind: 'revision_conflict' })
  const body = parseDocumentGraph(content).body

  const policy = loadTagForgePolicy()
  const overlay = repo.listOverlay()
  const pendingIdentity = {
    sourceRunId: runId || null,
    batchId: context?.batchId || (runId ? `run:${runId}` : 'unscoped'),
    itemId: context?.itemId || file.fileKey,
    scopeId: context?.scopeId || null,
  }
  const submittedProposals = rawProposals.filter((item): item is TagProposal => Boolean(item && typeof item === 'object'))
  const evidenceRejected = submittedProposals.filter((proposal) => !evidenceOccursInContent(proposal.evidenceExcerpt, body))
  const proposals = submittedProposals.filter((proposal) => evidenceOccursInContent(proposal.evidenceExcerpt, body))
  const reviewedRejections = repo.listRejected(pendingIdentity)
  const before = repo.listAssignments(file.fileKey)
  const automaticLabels = new Set(before.filter((item) => item.ownership === 'automatic' && !item.suppressed).map((item) => normalizedLabel(item.label)))
  const workflowLabels = new Set([...policy.entries, ...overlay]
    .filter((entry) => entry.status === 'active' && entry.facet === 'state')
    .flatMap((entry) => [entry.label, ...entry.aliases])
    .map(normalizedLabel))
  const preservedLabels = extractDocumentTagLabels(content)
    .filter((label) => !automaticLabels.has(normalizedLabel(label)) && !workflowLabels.has(normalizedLabel(label)))
  const preservedLabelSet = new Set(preservedLabels.map(normalizedLabel))
  const existingEntries = [...policy.entries, ...overlay]
  const preservedKnownTagIds = new Set(preservedLabels
    .map((label) => resolveActiveTagEntry(existingEntries, label)?.id)
    .filter((id): id is string => Boolean(id)))
  const isPreservedProposal = (proposal: TagProposal): boolean => (
    preservedLabelSet.has(normalizedLabel(proposal.label))
    || preservedKnownTagIds.has(resolveActiveTagEntry(existingEntries, proposal.label)?.id ?? '')
  )
  const localManualProposals = proposals.filter(isPreservedProposal)
  const hasManualForm = preservedLabels.some((label) => resolveActiveTagEntry(existingEntries, label)?.facet === 'form')
    || localManualProposals.some((proposal) => proposal.facet === 'form')
  const automaticProposals = proposals.filter((proposal) => (
    !isPreservedProposal(proposal)
    && !(hasManualForm && proposal.facet === 'form')
  ))
  const initial = validateTagProposals(policy, automaticProposals, 'explicit', overlay, reviewedRejections)
  const localCoverageBeforeAdmission = [
    ...preservedLabels.flatMap((label) => {
      const entry = resolveActiveTagEntry(existingEntries, label)
      return entry && entry.facet !== 'state' ? [{ facet: entry.facet }] : []
    }),
    ...localManualProposals,
  ]
  const missingBeforeAdmission = resolveMissingContentFacets(initial.active, [], localCoverageBeforeAdmission)
  const automaticContentCount = initial.active
    .filter((tag) => tag.facet !== 'state' && !preservedKnownTagIds.has(tag.tagId))
    .length
  const documentCapacity = Math.max(0, policy.tagsPerDoc[1] - automaticContentCount)
  const admissionCandidates = selectEvidenceBackedAdmissions(
    policy,
    initial.pending,
    body,
    documentCapacity,
    { requiredTopic: missingBeforeAdmission.includes('topic') },
  )
  const validated = admissionCandidates.length
    ? validateTagProposals(policy, automaticProposals, 'explicit', [...overlay, ...admissionCandidates], reviewedRejections)
    : initial
  const activeTagIds = new Set(validated.active.map((tag) => tag.tagId))
  const admittedEntries = admissionCandidates.filter((entry) => activeTagIds.has(entry.id))
  const preservedManualTagIds = new Set(before
    .filter((item) => item.ownership === 'manual')
    .map((item) => item.tagId))
  const knownEntries = [...existingEntries, ...admittedEntries]
  const locallySatisfiedManualTags: Array<{ facet: TagProposal['facet'] }> = []
  for (const label of preservedLabels) {
    const entry = resolveActiveTagEntry(knownEntries, label)
    if (entry) {
      preservedManualTagIds.add(entry.id)
      if (entry.facet !== 'state') locallySatisfiedManualTags.push({ facet: entry.facet })
    }
  }
  const activeHasForm = validated.active.some((tag) => tag.facet === 'form')
  const locallySatisfiedTags = [
    ...locallySatisfiedManualTags,
    ...localManualProposals,
  ]
  const reviewCandidates = validated.pending.filter((proposal) => (
    !(proposal.facet === 'form' && activeHasForm)
    && !preservedLabelSet.has(normalizedLabel(proposal.label))
  ))
  const automaticSelectedCount = validated.active
    .filter((tag) => tag.facet !== 'state' && !preservedManualTagIds.has(tag.tagId))
    .length
  const reviewCapacity = Math.max(0, policy.tagsPerDoc[1] - automaticSelectedCount)
  const missingBeforeReview = resolveMissingContentFacets(validated.active, [], locallySatisfiedTags)
  const requiredReviewProposals = [
    ...(missingBeforeReview.includes('form') ? reviewCandidates.filter((proposal) => proposal.facet === 'form').slice(0, 1) : []),
    ...(missingBeforeReview.includes('topic') ? reviewCandidates.filter((proposal) => proposal.facet === 'domain' || proposal.facet === 'entity').slice(0, 1) : []),
  ]
  const requiredReviewKeys = new Set(requiredReviewProposals.map((proposal) => `${proposal.facet}:${normalizedLabel(proposal.label)}`))
  const reviewProposals = [
    ...requiredReviewProposals,
    ...reviewCandidates
      .filter((proposal) => !requiredReviewKeys.has(`${proposal.facet}:${normalizedLabel(proposal.label)}`))
      .slice(0, Math.max(0, reviewCapacity - requiredReviewProposals.length)),
  ]
  const pending = reviewProposals.map((item) => ({ facet: item.facet, label: item.label }))
  const rejected = [
    ...evidenceRejected.map((proposal) => ({ label: String(proposal.label || ''), reason: 'evidence_not_found_in_document' })),
    ...validated.rejected.map((item) => ({ label: item.proposal.label, reason: item.reason })),
  ]
  if (!canSatisfyContentCoverage(validated.active, reviewProposals, locallySatisfiedTags)) {
    return json({
      ok: false,
      status: 'failed_terminal',
      errorKind: 'insufficient_content_tags',
      path,
      missingContentFacets: resolveMissingContentFacets(validated.active, reviewProposals, locallySatisfiedTags),
      pending,
      rejected,
    })
  }

  const assignmentSnapshot = repo.snapshotAssignments(file.fileKey)
  const previousAuto = before.filter((item) => item.ownership === 'automatic').map((item) => item.label)
  const suppressed = before.filter((item) => item.ownership === 'automatic' && item.suppressed).map((item) => item.label)
  const workflowStates = [...policy.entries, ...overlay]
    .filter((entry) => entry.status === 'active' && entry.facet === 'state')
    .map((entry) => ({ label: entry.label, aliases: entry.aliases }))
  let written: TagForgeWriteResult | null = null
  let openTabSynced = false
  let assignmentsStaged = false
  try {
    written = await writeControlledTags({
      path,
      workspaceRoot: root,
      expectedRevision,
      selectedTags: validated.active.filter((tag) => tag.facet === 'state' || !preservedManualTagIds.has(tag.tagId)),
      previousAutomaticLabels: previousAuto,
      suppressedAutomaticLabels: suppressed,
      workflowStates,
      defaultWorkflowState: policy.automaticState,
    })
    if (context?.requestModuleToolAction) {
      const sync = await context.requestModuleToolAction('tagForge.applyContent', { path, content: written.content, revision: written.revision })
      if (sync.ok === false) {
        throw Object.assign(new Error('open_tab_revision_conflict'), { code: 'open_tab_revision_conflict' })
      }
      openTabSynced = true
    }
    const writtenWorkflowState = written.workflowState
    const workflowStateEntry = writtenWorkflowState
      ? [...policy.entries, ...overlay, ...admittedEntries].find((entry) => entry.facet === 'state' && same(entry.label, writtenWorkflowState))
      : null
    const assignmentTags = [...validated.active]
    if (workflowStateEntry && !assignmentTags.some((tag) => tag.facet === 'state')) {
      assignmentTags.push({
        tagId: workflowStateEntry.id,
        facet: 'state',
        label: workflowStateEntry.label,
        confidence: 1,
        evidenceCode: 'code_owned_workflow_state',
        resolution: 'exact',
      })
    }
    engine.getRepository().transaction(() => {
      repo.replaceAutomaticAssignments(file.fileKey, assignmentTags, 'tag_forge_explicit', policy.version, Date.now(), preservedManualTagIds)
    })
    assignmentsStaged = true
    const indexResult = await engine.indexDocument(root, path, written.content)
    if (!indexResult.ok) throw Object.assign(new Error(indexResult.error || 'index_write_failed'), { code: 'index_write_failed' })
    const diskReadback = await readFile(written.path, 'utf8').catch(() => null)
    if (diskReadback === null) throw Object.assign(new Error('post_index_read_failed'), { code: 'post_index_read_failed' })
    if (revisionOf(diskReadback) !== written.revision) {
      throw Object.assign(new Error('post_index_revision_conflict'), { code: 'post_index_revision_conflict' })
    }
    const indexed = db.prepare(`SELECT d.frontmatter_json AS frontmatter,d.content_hash AS contentHash FROM documents d JOIN workspaces w ON w.id=d.workspace_id WHERE w.root=? AND d.path=?`).get<{ frontmatter: string | null; contentHash: string | null }>(root, path)
    const indexedFrontmatter = parseFrontmatter(indexed?.frontmatter)
    const indexedTags = Array.isArray(indexedFrontmatter.tags) ? indexedFrontmatter.tags.map(String) : []
    const indexedWorkflowState = typeof indexedFrontmatter.ready_state === 'string' ? indexedFrontmatter.ready_state : null
    if (indexed?.contentHash !== buildSearchIndexContentHash(diskReadback) || JSON.stringify(indexedTags) !== JSON.stringify(written.tags) || indexedWorkflowState !== written.workflowState) {
      throw Object.assign(new Error('index_readback_mismatch'), { code: 'index_readback_mismatch' })
    }
    const selectedContentLabels = validated.active.filter((tag) => tag.facet !== 'state').map((tag) => tag.label)
    const finalCoverage = evaluateControlledContentLabels(policy, selectedContentLabels, [...overlay, ...admittedEntries])
    const finalReviewProposals = reviewProposals.filter((proposal) => !(proposal.facet === 'form' && finalCoverage.formCount === 1))
    if (!finalCoverage.complete && !canSatisfyFinalCoverage(finalCoverage, finalReviewProposals, locallySatisfiedTags)) {
      throw Object.assign(new Error('post_write_content_incomplete'), { code: 'post_write_content_incomplete' })
    }
    let pendingRows: ReturnType<TagForgeRepository['listPending']> = []
    engine.getRepository().transaction(() => {
      for (const entry of admittedEntries) repo.upsertOverlay(entry)
      pendingRows = repo.addPending(finalReviewProposals, pendingIdentity)
      repo.markReadback(file.fileKey)
    })
    const waitingReview = pendingRows.length > 0
    return json({
      ok: true,
      status: waitingReview ? 'waiting_review' : 'completed',
      reviewRequired: waitingReview,
      partialApplied: waitingReview && written.content !== written.originalContent,
      path,
      tags: written.tags,
      workflowState: written.workflowState,
      pending: pendingRows.map((row) => ({ proposalId: row.proposalId, facet: row.facet, label: row.label })),
      rejected,
      autoAdmitted: admittedEntries.map((entry) => ({ facet: entry.facet, label: entry.label })),
      revision: written.revision,
    })
  } catch (error) {
    let code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'tag_write_failed'
    if (written) {
      let rollbackFailed = false
      if (assignmentsStaged) {
        try {
          engine.getRepository().transaction(() => repo.restoreAssignments(file.fileKey, assignmentSnapshot))
        } catch {
          rollbackFailed = true
        }
      }
      let rollbackContent: string | null = null
      try {
        const current = await readFile(written.path, 'utf8')
        if (revisionOf(current) === written.revision) {
          await rollbackControlledWrite(written.path, written.revision, written.originalContent)
          rollbackContent = written.originalContent
        } else {
          rollbackContent = current
        }
      } catch {
        rollbackFailed = true
      }
      if (rollbackContent !== null) {
        try {
          const rollbackIndex = await engine.indexDocument(root, path, rollbackContent)
          if (!rollbackIndex.ok) throw new Error(rollbackIndex.error || 'rollback index failed')
        } catch {
          rollbackFailed = true
        }
      }
      if (rollbackContent !== null && openTabSynced && context?.requestModuleToolAction) {
        try {
          const rollbackSync = await context.requestModuleToolAction('tagForge.applyContent', {
            path,
            content: rollbackContent,
            revision: revisionOf(rollbackContent),
          })
          if (rollbackSync.ok === false) throw new Error('rollback open tab sync failed')
        } catch {
          rollbackFailed = true
        }
      }
      if (rollbackFailed) code = 'tag_write_rollback_failed'
    }
    return json({ ok: false, status: 'failed_terminal', errorKind: code, path })
  }
}

export function buildTagForgeLexiconSnapshot(policy: TagForgePolicy, overlay: readonly TagLexiconEntry[]): Record<string, unknown> {
  const active = [...policy.entries, ...overlay].filter((entry) => entry.status === 'active' && entry.facet !== 'state')
  return {
    version: policy.version,
    targetContentTags: policy.tagsPerDoc,
    requiredCoverage: ['form', 'domain_or_entity'],
    active: Object.fromEntries(['form', 'domain', 'entity', 'use'].map((facet) => [
      facet,
      active.filter((entry) => entry.facet === facet).map((entry) => ({ label: entry.label, aliases: entry.aliases, definition: entry.definition || undefined })),
    ])),
    guidance: 'Use tags only for listed active labels or aliases. Submit unknown reusable terms as structured proposals with an exact evidenceExcerpt; never use workflow state as a content tag.',
  }
}

function workspaceRootFor(path: string, engine: SearchEngine, roots: string[] | null | undefined): string | null {
  if (!isAbsolute(path)) return null
  const resolvedTarget = resolve(path)
  let targetRealPath: string
  try {
    targetRealPath = realpathSync(resolvedTarget)
  } catch {
    return null
  }
  const candidates = Array.isArray(roots)
    ? roots.flatMap((root) => {
        try {
          const resolvedRoot = resolve(root)
          return [{ root: resolvedRoot, realPath: realpathSync(resolvedRoot) }]
        } catch {
          return []
        }
      })
    : []
  if (candidates.length) {
    return candidates.find((root) => inside(targetRealPath, root.realPath))?.root ?? null
  }
  const indexedRoot = engine.findWorkspaceRootForPath(resolvedTarget)
  if (!indexedRoot) return null
  try {
    return inside(targetRealPath, realpathSync(indexedRoot)) ? indexedRoot : null
  } catch {
    return null
  }
}

function inside(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function parseFrontmatter(raw: string | null | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function same(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
}

function normalizedLabel(label: string): string {
  return label.trim().replace(/^#/, '').toLocaleLowerCase()
}

function canSatisfyContentCoverage(
  active: readonly { facet: TagProposal['facet'] }[],
  pending: readonly TagProposal[],
  local: readonly { facet: TagProposal['facet'] }[],
): boolean {
  return resolveMissingContentFacets(active, pending, local).length === 0
}

function resolveMissingContentFacets(
  active: readonly { facet: TagProposal['facet'] }[],
  pending: readonly TagProposal[],
  local: readonly { facet: TagProposal['facet'] }[],
): Array<'form' | 'topic'> {
  const formCount = active.filter((tag) => tag.facet === 'form').length
  const hasForm = formCount === 1 || (formCount === 0 && [...pending, ...local].some((proposal) => proposal.facet === 'form'))
  const hasTopic = active.some((tag) => tag.facet === 'domain' || tag.facet === 'entity')
    || [...pending, ...local].some((proposal) => proposal.facet === 'domain' || proposal.facet === 'entity')
  return [...(!hasForm ? ['form' as const] : []), ...(!hasTopic ? ['topic' as const] : [])]
}

function canSatisfyFinalCoverage(
  current: ReturnType<typeof evaluateControlledContentLabels>,
  pending: readonly TagProposal[],
  local: readonly { facet: TagProposal['facet'] }[],
): boolean {
  const hasForm = current.formCount === 1 || (current.formCount === 0 && [...pending, ...local].some((proposal) => proposal.facet === 'form'))
  const hasTopic = current.facets.includes('domain') || current.facets.includes('entity')
    || [...pending, ...local].some((proposal) => proposal.facet === 'domain' || proposal.facet === 'entity')
  return hasForm && hasTopic
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
