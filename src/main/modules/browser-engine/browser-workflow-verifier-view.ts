import {
  browserObservationResourceUsableAsResearchEvidence,
  type BrowserResearchAssessment,
  type BrowserWorkflowActionJournal,
  type BrowserWorkflowObservationResource,
  type VerifiedBrowserWorkflowEvidence,
} from './browser-workflow-evidence'

interface BrowserWorkflowVerifierResourceView {
  resource: BrowserWorkflowObservationResource
  excerpt: string
}

export interface BrowserWorkflowVerifierEvidenceView {
  journalExcerpt: string
  resources: BrowserWorkflowVerifierResourceView[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function quotedAccessibilityName(line: string): string | null {
  const match = line.trim().match(/^-\s+\S+\s+"((?:[^"\\]|\\.)*)"/)
  return match?.[1] || null
}

function accessibilityRole(line: string): string | null {
  return line.trim().match(/^-\s+(\S+)/)?.[1] || null
}

function accessibilityIndent(line: string): number {
  return line.length - line.trimStart().length
}

/** Remove accessibility implementation nodes only when their text is already
 * carried by an ancestor. Unique page text and hierarchy remain intact. */
function compactAccessibilityText(text: string): string {
  const ancestors: Array<{ indent: number; name: string | null }> = []
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const indent = accessibilityIndent(line)
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].indent >= indent) {
      ancestors.pop()
    }
    const role = accessibilityRole(line)
    const name = quotedAccessibilityName(line)
    const namedAncestor = [...ancestors].reverse().find((item) => item.name)?.name || null
    const duplicateStaticText = role === 'StaticText' && Boolean(name) && name === namedAncestor
    const duplicateInlineText = role === 'InlineTextBox'
      && Boolean(name)
      && Boolean(namedAncestor?.includes(name as string))
    if (!duplicateStaticText && !duplicateInlineText) lines.push(line)
    ancestors.push({ indent, name })
  }
  return lines.join('\n')
}

function projectPageIdentity(value: unknown): unknown {
  const pageIdentity = asRecord(value)
  if (!pageIdentity) return value
  return {
    ...(typeof pageIdentity.url === 'string' ? { url: pageIdentity.url } : {}),
    ...(typeof pageIdentity.title === 'string' ? { title: pageIdentity.title } : {}),
  }
}

function projectPageMap(value: unknown): unknown {
  const pageMap = asRecord(value)
  if (!pageMap) return value
  const semanticPageMap = { ...pageMap }
  for (const field of ['targets', 'viewport', 'structureHints', 'targetDefaults', 'nextCursor', 'generation']) {
    delete semanticPageMap[field]
  }
  return {
    ...semanticPageMap,
    ...(typeof semanticPageMap.text === 'string'
      ? { text: compactAccessibilityText(semanticPageMap.text) }
      : {}),
  }
}

function projectObservationResult(value: unknown): unknown {
  const result = asRecord(value)
  if (!result) return value
  const semanticResult = { ...result }
  for (const field of ['interactionReadiness', 'nextAllowedActions', 'ambiguityGroups', 'summary']) {
    delete semanticResult[field]
  }
  return {
    ...semanticResult,
    ...(Object.hasOwn(semanticResult, 'pageIdentity')
      ? { pageIdentity: projectPageIdentity(semanticResult.pageIdentity) }
      : {}),
    ...(Object.hasOwn(semanticResult, 'pageMap')
      ? { pageMap: projectPageMap(semanticResult.pageMap) }
      : {}),
  }
}

function projectObservationContent(resource: BrowserWorkflowObservationResource): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(resource.content) as unknown
  } catch {
    throw new Error(`browser_verifier_observation_content_invalid:${resource.resourceId}`)
  }
  const content = asRecord(parsed)
  if (!content) throw new Error(`browser_verifier_observation_content_invalid:${resource.resourceId}`)
  return JSON.stringify({
    ...content,
    ...(Object.hasOwn(content, 'result')
      ? { result: projectObservationResult(content.result) }
      : {}),
  })
}

function projectSettledOutcomes(journal: BrowserWorkflowActionJournal): unknown[] {
  return journal.settledOutcomes.map((receipt) => ({
    receiptId: receipt.receiptId,
    actionId: receipt.actionId,
    actionSeq: receipt.actionSeq,
    settledAt: receipt.settledAt,
    outcome: {
      operationId: receipt.outcome.operationId,
      mode: receipt.outcome.mode,
      dispatch: receipt.outcome.dispatch,
      delivery: receipt.outcome.delivery,
      effect: receipt.outcome.effect,
      needsObservation: receipt.outcome.needsObservation,
      mayHaveCommitted: receipt.outcome.mayHaveCommitted,
      ...(receipt.outcome.search ? { search: receipt.outcome.search } : {}),
    },
  }))
}

function projectObservationReceipts(journal: BrowserWorkflowActionJournal): unknown[] {
  return journal.observationReceipts.map((receipt) => ({
    receiptId: receipt.receiptId,
    observationSeq: receipt.observationSeq,
    operationId: receipt.operationId,
    observedAfterActionSeq: receipt.observedAfterActionSeq,
    searchActionId: receipt.searchActionId,
    queryDigest: receipt.queryDigest,
    causalActions: receipt.causalActions.map((action) => ({
      actionId: action.actionId,
      actionSeq: action.actionSeq,
      searchActionId: action.searchActionId,
      queryDigest: action.queryDigest,
    })),
    resultDigest: receipt.resultDigest,
    resourceId: receipt.resourceId,
    observedAt: receipt.observedAt,
  }))
}

function projectResearchAssessment(assessment: BrowserResearchAssessment | null): unknown {
  if (!assessment) return null
  return {
    satisfied: assessment.satisfied,
    missingWorkItemIds: assessment.missingWorkItemIds,
    workItems: assessment.workItems.map((item) => ({
      workItemId: item.workItemId,
      goalRefs: item.goalRefs,
      requirement: item.requirement,
      query: item.query,
      url: item.url,
      fieldGoals: item.fieldGoals,
      required: item.required,
      evidenceRefIds: item.evidenceRefIds,
    })),
    evidenceRefs: assessment.evidenceRefs.map((ref) => ({
      evidenceRefId: ref.evidenceRefId,
      workItemId: ref.workItemId,
      resourceId: ref.resourceId,
      observationReceiptId: ref.observationReceiptId,
      actionReceiptId: ref.actionReceiptId,
    })),
  }
}

/** Build the semantic read-only view supplied to the completion verifier.
 * Durable resources and receipts remain untouched and digest-verified before
 * this projection is created. */
export function buildBrowserWorkflowVerifierEvidenceView(
  evidence: VerifiedBrowserWorkflowEvidence,
): BrowserWorkflowVerifierEvidenceView {
  return {
    journalExcerpt: JSON.stringify({
      settledOutcomes: projectSettledOutcomes(evidence.journal),
      observationReceipts: projectObservationReceipts(evidence.journal),
      researchState: evidence.researchState,
      researchAssessment: projectResearchAssessment(evidence.researchAssessment),
    }),
    resources: evidence.resources.flatMap((resource) => {
      const excerpt = projectObservationContent(resource)
      return browserObservationResourceUsableAsResearchEvidence(resource)
        ? [{ resource, excerpt }]
        : []
    }),
  }
}
