import { tagOverlayId } from '../repositories/tag-forge-repository'
import type { TagForgePolicy, TagLexiconEntry, TagProposal } from './tag-forge-policy'

export function evidenceOccursInContent(excerpt: string | null | undefined, content: string): boolean {
  const needle = normalizeEvidence(excerpt || '')
  return needle.length >= 2 && /[\p{L}\p{N}]/u.test(needle) && normalizeEvidence(content).includes(needle)
}

export function selectEvidenceBackedAdmissions(
  policy: TagForgePolicy,
  pending: readonly TagProposal[],
  content: string,
  budget: number,
  options?: { minimumConfidence?: number; perDocumentLimit?: number; requiredTopic?: boolean },
): Array<Omit<TagLexiconEntry, 'status'> & { status: 'active' }> {
  const minimumConfidence = options?.minimumConfidence ?? policy.explicitAutoAdmitConfidence
  const perDocumentLimit = options?.perDocumentLimit ?? budget
  const eligible = pending
    .filter((proposal) => policy.explicitAutoAdmitFacets.includes(proposal.facet))
    .filter((proposal) => proposal.confidence >= minimumConfidence)
    .filter((proposal) => evidenceSupportsNewLabel(policy, proposal, content))
  const requiredTopic = options?.requiredTopic
    ? eligible.find((proposal) => proposal.facet === 'domain' || proposal.facet === 'entity')
    : undefined
  const limit = Math.max(requiredTopic ? 1 : 0, Math.min(budget, perDocumentLimit))
  if (limit <= 0) return []
  const selected = requiredTopic
    ? [requiredTopic, ...eligible.filter((proposal) => proposal !== requiredTopic)].slice(0, limit)
    : eligible.slice(0, limit)
  return selected
    .map((proposal) => ({
      id: tagOverlayId(proposal.facet, proposal.label),
      facet: proposal.facet,
      label: proposal.label,
      aliases: [],
      status: 'active' as const,
    }))
}

function evidenceSupportsNewLabel(policy: TagForgePolicy, proposal: TagProposal, content: string): boolean {
  if (!evidenceOccursInContent(proposal.evidenceExcerpt, content)) return false
  const excerpt = compactEvidence(proposal.evidenceExcerpt || '')
  const label = compactEvidence(proposal.label)
  return label.length >= 2 && (excerpt.includes(label) || proposal.confidence >= policy.explicitAutoAdmitConfidence)
}

function normalizeEvidence(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function compactEvidence(value: string): string {
  return normalizeEvidence(value).replace(/[\s#_\-/]+/g, '')
}
