import { createHash } from 'crypto'
import { parseDocumentGraph } from '../../../shared/document-graph-parse'
import { writeFrontmatter } from '../../../shared/document-graph-parse-frontmatter-writer'
import { tagOverlayId } from '../repositories/tag-forge-repository'
import { evidenceOccursInContent, selectEvidenceBackedAdmissions } from './tag-forge-admission'
import { resolveActiveTagEntry, TAG_FACETS, validateTagProposals, type TagForgePolicy, type TagLexiconEntry, type TagProposal, type ValidatedTag } from './tag-forge-policy'

type ActiveOverlayEntry = Omit<TagLexiconEntry, 'status'> & { status: 'active' }

export type TagForgeCreationValidation =
  | {
      ok: true
      tags: ValidatedTag[]
      admittedEntries: ActiveOverlayEntry[]
      bodyRevision: string
      preservedManualTagIds: string[]
    }
  | {
      ok: false
      errorKind: 'tag_evidence_missing' | 'insufficient_content_tags'
      missingContentFacets: Array<'form' | 'topic'>
      rejectedLabels: string[]
    }

export function validateTagForgeCreationProposals(
  policy: TagForgePolicy,
  proposals: readonly TagProposal[],
  content: string,
  overlay: readonly TagLexiconEntry[] = [],
): TagForgeCreationValidation {
  const parsed = parseDocumentGraph(content)
  const body = parsed.body
  const preservedLabels = Array.isArray(parsed.frontmatter?.tags) ? parsed.frontmatter.tags.map(String) : []
  const entries = [...policy.entries, ...overlay]
  const preservedLabelSet = new Set(preservedLabels.map(normalizeLabel))
  const preservedKnownTagIds = new Set(preservedLabels
    .map((label) => resolveActiveTagEntry(entries, label)?.id)
    .filter((id): id is string => Boolean(id)))
  const submitted = proposals.filter((proposal): proposal is TagProposal => Boolean(proposal && typeof proposal === 'object'))
  const evidenceRejected = submitted.filter((proposal) => !evidenceOccursInContent(proposal.evidenceExcerpt, body))
  const verified = submitted.filter((proposal) => evidenceOccursInContent(proposal.evidenceExcerpt, body))
  const isPreservedProposal = (proposal: TagProposal): boolean => (
    preservedLabelSet.has(normalizeLabel(proposal.label))
    || preservedKnownTagIds.has(resolveActiveTagEntry(entries, proposal.label)?.id ?? '')
  )
  const localManualProposals = verified.filter(isPreservedProposal)
  const manualTags = collectManualTags(policy, entries, preservedLabels, localManualProposals)
  const hasManualForm = manualTags.some((tag) => tag.facet === 'form')
  const automaticProposals = verified.filter((proposal) => (
    !isPreservedProposal(proposal)
    && !(hasManualForm && proposal.facet === 'form')
  ))
  const initial = validateTagProposals(policy, automaticProposals, 'automatic', overlay)
  const missingBeforeAdmission = missingContentFacets([...initial.active, ...manualTags])
  const contentCount = initial.active.filter((tag) => tag.facet !== 'state').length
  const documentCapacity = Math.max(0, policy.tagsPerDoc[1] - contentCount)
  const admissionCandidates = selectEvidenceBackedAdmissions(policy, initial.pending, body, documentCapacity, {
    minimumConfidence: policy.explicitReviewConfidence,
    perDocumentLimit: documentCapacity,
    requiredTopic: missingBeforeAdmission.includes('topic'),
  })
  const validated = admissionCandidates.length
    ? validateTagProposals(policy, automaticProposals, 'automatic', [...overlay, ...admissionCandidates])
    : initial
  const activeTagIds = new Set(validated.active.map((tag) => tag.tagId))
  const admittedEntries = admissionCandidates.filter((entry) => activeTagIds.has(entry.id))
  const selectedManualTags = selectManualCoverageTags(validated.active, manualTags)
  const missing = missingContentFacets([...validated.active, ...selectedManualTags])
  if (missing.length > 0) {
    return {
      ok: false,
      errorKind: evidenceRejected.length > 0 ? 'tag_evidence_missing' : 'insufficient_content_tags',
      missingContentFacets: missing,
      rejectedLabels: [...evidenceRejected.map((proposal) => proposal.label), ...validated.rejected.map((item) => item.proposal.label)],
    }
  }
  const contentTags = [...validated.active.filter((tag) => tag.facet !== 'state'), ...selectedManualTags]
    .sort((left, right) => TAG_FACETS.indexOf(left.facet) - TAG_FACETS.indexOf(right.facet))
  const workflowState = resolveCreationWorkflowState(entries, parsed.frontmatter, validated.active.find((tag) => tag.facet === 'state'))
  return {
    ok: true,
    tags: [...contentTags, ...(workflowState ? [workflowState] : [])],
    admittedEntries,
    bodyRevision: createHash('sha256').update(body).digest('hex'),
    preservedManualTagIds: manualTags.map((tag) => tag.tagId),
  }
}

export function verifyTagForgeCreationFinalContent(
  policy: TagForgePolicy,
  content: string,
  tags: readonly ValidatedTag[],
  expectedBodyRevision: string,
  overlay: readonly TagLexiconEntry[] = [],
): { ok: true; diskTags: string[]; workflowState: string | null } | { ok: false; errorKind: 'creation_body_revision_mismatch' | 'frontmatter_readback_mismatch' } {
  const parsed = parseDocumentGraph(content)
  const bodyRevision = createHash('sha256').update(parsed.body).digest('hex')
  if (bodyRevision !== expectedBodyRevision) return { ok: false, errorKind: 'creation_body_revision_mismatch' }
  const diskTags = Array.isArray(parsed.frontmatter?.tags) ? parsed.frontmatter.tags.map(String) : []
  const contentTags = tags.filter((tag) => tag.facet !== 'state')
  const contentLabels = contentTags.map((tag) => tag.label)
  const workflowState = tags.find((tag) => tag.facet === 'state')?.label ?? null
  const formCount = new Set(contentTags.filter((tag) => tag.facet === 'form').map((tag) => tag.tagId)).size
  const hasTopic = contentTags.some((tag) => tag.facet === 'domain' || tag.facet === 'entity')
  const stateLabels = workflowStateLabels([...policy.entries, ...overlay])
  if (!containsAllLabels(diskTags, contentLabels) || diskTags.some((label) => stateLabels.has(normalizeLabel(label))) || hasDuplicateLabels(contentLabels) || hasDuplicateRequiredLabels(diskTags, contentLabels) || formCount !== 1 || !hasTopic || (workflowState && parsed.frontmatter?.ready_state !== workflowState)) {
    return { ok: false, errorKind: 'frontmatter_readback_mismatch' }
  }
  return { ok: true, diskTags, workflowState }
}

export function creationFrontmatterRevision(content: string): string {
  const frontmatter = parseDocumentGraph(content).frontmatter
  const tags = Array.isArray(frontmatter?.tags) ? frontmatter.tags.map(String).map(normalizeLabel).sort() : []
  const workflowState = typeof frontmatter?.ready_state === 'string' ? normalizeLabel(frontmatter.ready_state) : ''
  return createHash('sha256').update(JSON.stringify({ tags, workflowState })).digest('hex')
}

export function matchesTagForgeCreationContent(
  snapshot: { bodyRevision: string; frontmatterRevision?: string },
  content: string,
): boolean {
  const parsed = parseDocumentGraph(content)
  return createHash('sha256').update(parsed.body).digest('hex') === snapshot.bodyRevision
    && typeof snapshot.frontmatterRevision === 'string'
    && creationFrontmatterRevision(content) === snapshot.frontmatterRevision
}

function collectManualTags(
  policy: TagForgePolicy,
  entries: readonly TagLexiconEntry[],
  preservedLabels: readonly string[],
  proposals: readonly TagProposal[],
): ValidatedTag[] {
  const tags = new Map<string, ValidatedTag>()
  for (const label of preservedLabels) {
    const entry = resolveActiveTagEntry(entries, label)
    if (!entry || entry.facet === 'state') continue
    tags.set(entry.id, {
      tagId: entry.id,
      facet: entry.facet,
      label,
      confidence: 1,
      evidenceCode: 'preserved_manual_tag',
      resolution: sameLabel(entry.label, label) ? 'exact' : 'alias',
    })
  }
  for (const proposal of proposals) {
    if (proposal.facet === 'state' || policy.broadLabelBlacklist.some((label) => sameLabel(label, proposal.label))) continue
    const entry = resolveActiveTagEntry(entries, proposal.label)
    if (entry) continue
    const label = preservedLabels.find((item) => sameLabel(item, proposal.label)) ?? proposal.label
    const tagId = tagOverlayId(proposal.facet, label)
    if (!tags.has(tagId)) {
      tags.set(tagId, {
        tagId,
        facet: proposal.facet,
        label,
        confidence: proposal.confidence,
        evidenceCode: proposal.evidenceCode,
        resolution: 'exact',
      })
    }
  }
  return [...tags.values()]
}

function selectManualCoverageTags(automatic: readonly ValidatedTag[], manual: readonly ValidatedTag[]): ValidatedTag[] {
  return [
    ...(!automatic.some((tag) => tag.facet === 'form') ? manual.filter((tag) => tag.facet === 'form').slice(0, 1) : []),
    ...(!automatic.some((tag) => tag.facet === 'domain' || tag.facet === 'entity') ? manual.filter((tag) => tag.facet === 'domain' || tag.facet === 'entity').slice(0, 1) : []),
  ]
}

function missingContentFacets(tags: readonly { facet: TagProposal['facet'] }[]): Array<'form' | 'topic'> {
  const missing: Array<'form' | 'topic'> = []
  if (!tags.some((tag) => tag.facet === 'form')) missing.push('form')
  if (!tags.some((tag) => tag.facet === 'domain' || tag.facet === 'entity')) missing.push('topic')
  return missing
}

export function buildTagForgeCreationContent(
  policy: TagForgePolicy,
  content: string,
  tags: readonly ValidatedTag[],
  overlay: readonly TagLexiconEntry[] = [],
  previousAutomaticTags: readonly ValidatedTag[] = [],
): string {
  const parsed = parseDocumentGraph(content)
  const frontmatter = { ...(parsed.frontmatter ?? {}) }
  const existingTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : []
  const automaticTags = tags.filter((tag) => tag.facet !== 'state').map((tag) => tag.label)
  const workflowState = tags.find((tag) => tag.facet === 'state')?.label
  const stateLabels = workflowStateLabels([...policy.entries, ...overlay])
  const currentById = new Map(tags.filter((tag) => tag.facet !== 'state').map((tag) => [tag.tagId, tag]))
  const replacedAutomaticLabels = new Set(previousAutomaticTags
    .filter((tag) => currentById.has(tag.tagId) && !sameLabel(currentById.get(tag.tagId)!.label, tag.label))
    .map((tag) => normalizeLabel(tag.label)))
  const contentLabels = uniqueLabels([
    ...existingTags.filter((label) => !stateLabels.has(normalizeLabel(label)) && !replacedAutomaticLabels.has(normalizeLabel(label))),
    ...automaticTags,
  ])
  if (contentLabels.length > 0) frontmatter.tags = contentLabels
  else delete frontmatter.tags
  if (workflowState) frontmatter.ready_state = workflowState
  else delete frontmatter.ready_state
  return writeFrontmatter(parsed.body, frontmatter)
}

function resolveCreationWorkflowState(
  entries: readonly TagLexiconEntry[],
  frontmatter: Record<string, unknown> | null | undefined,
  fallback: ValidatedTag | undefined,
): ValidatedTag | undefined {
  const visibleTags = Array.isArray(frontmatter?.tags) ? frontmatter.tags.map(String) : []
  const candidates = [typeof frontmatter?.ready_state === 'string' ? frontmatter.ready_state : '', ...visibleTags]
  for (const label of candidates) {
    const entry = resolveActiveTagEntry(entries, label)
    if (entry?.facet !== 'state') continue
    return {
      tagId: entry.id,
      facet: 'state',
      label: entry.label,
      confidence: 1,
      evidenceCode: 'preserved_workflow_state',
      resolution: sameLabel(entry.label, label) ? 'exact' : 'alias',
    }
  }
  return fallback
}

function workflowStateLabels(entries: readonly TagLexiconEntry[]): Set<string> {
  return new Set(entries
    .filter((entry) => entry.status === 'active' && entry.facet === 'state')
    .flatMap((entry) => [entry.label, ...entry.aliases])
    .map(normalizeLabel))
}

function containsAllLabels(actual: string[], required: string[]): boolean {
  const normalized = new Set(actual.map(normalizeLabel))
  return required.every((label) => normalized.has(normalizeLabel(label)))
}

function hasDuplicateLabels(labels: string[]): boolean {
  return new Set(labels.map(normalizeLabel)).size !== labels.length
}

function hasDuplicateRequiredLabels(actual: string[], required: string[]): boolean {
  const requiredLabels = new Set(required.map(normalizeLabel))
  const seen = new Set<string>()
  for (const label of actual.map(normalizeLabel)) {
    if (!requiredLabels.has(label)) continue
    if (seen.has(label)) return true
    seen.add(label)
  }
  return false
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Map(labels.map((label) => [normalizeLabel(label), label])).values()]
}

function sameLabel(left: string, right: string): boolean {
  return normalizeLabel(left) === normalizeLabel(right)
}

function normalizeLabel(label: string): string {
  return label.trim().toLocaleLowerCase()
}
