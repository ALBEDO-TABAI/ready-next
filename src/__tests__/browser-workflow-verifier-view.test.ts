import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  BrowserResearchAssessment,
  BrowserWorkflowObservationResource,
  VerifiedBrowserWorkflowEvidence,
} from '../main/modules/browser-engine/browser-workflow-evidence'
import { buildBrowserWorkflowVerifierEvidenceView } from '../main/modules/browser-engine/browser-workflow-verifier-view'

function resource(content: unknown): BrowserWorkflowObservationResource {
  return {
    resourceId: 'resource-1',
    taskId: 'task-1',
    operationId: 'snapshot',
    ownerRunId: 'run-1',
    identity: {
      documentState: 'document',
      tabId: 'tab-1',
      physicalTargetToken: 'physical-secret',
      frameId: 'frame-1',
      frameDocumentToken: 'document-secret',
      targetRef: null,
    },
    mediaType: 'application/json',
    content: JSON.stringify(content),
    contentDigest: 'content-digest',
    provenanceDigest: 'provenance-digest',
    truncated: false,
    createdAt: '2026-07-19T00:00:00.000Z',
  }
}

function evidence(
  observationResource: BrowserWorkflowObservationResource,
  researchAssessment: BrowserResearchAssessment | null = null,
): VerifiedBrowserWorkflowEvidence {
  return {
    journal: {
      nextActionSeq: 2,
      nextObservationSeq: 2,
      activeAction: null,
      settledOutcomes: [{
        receiptId: 'action-receipt-1',
        actionId: 'action-1',
        actionSeq: 1,
        settledAt: '2026-07-19T00:00:00.000Z',
        outcome: {
          actionId: 'action-1',
          actionSeq: 1,
          taskId: 'task-1',
          ownerRunId: 'run-1',
          operationId: 'click',
          mode: 'mutate',
          dispatch: 'accepted',
          delivery: 'delivered',
          effect: 'observed',
          needsObservation: true,
          mayHaveCommitted: true,
          identity: observationResource.identity,
          successorIdentity: observationResource.identity,
        },
      }],
      observationReceipts: [{
        receiptId: 'observation-receipt-1',
        observationSeq: 1,
        operationId: observationResource.operationId,
        ownerRunId: 'run-1',
        observedAfterActionSeq: 1,
        identity: observationResource.identity,
        searchActionId: null,
        queryDigest: null,
        causalActions: [{
          actionId: 'action-1',
          actionSeq: 1,
          predecessorIdentity: observationResource.identity,
          successorIdentity: observationResource.identity,
          searchActionId: null,
          queryDigest: null,
        }],
        resultDigest: 'result-digest',
        resourceId: observationResource.resourceId,
        observedAt: '2026-07-19T00:00:00.000Z',
      }],
    },
    resources: [observationResource],
    researchState: researchAssessment ? 'satisfied' : 'not_requested',
    researchAssessment,
    unresolvedActions: [],
  }
}

test('verifier view keeps page facts while omitting interaction-only snapshot state', () => {
  const original = resource({
    operationId: 'snapshot',
    result: {
      pageIdentity: {
        url: 'https://example.test/result',
        title: 'Result',
        tabId: 'tab-1',
        documentEpoch: 7,
        generation: 9,
      },
      summary: { targetCount: 2 },
      pageMap: {
        generation: 9,
        viewport: { width: 800, height: 600 },
        text: [
          '- heading "Result"',
          '  - StaticText "Result"',
          '    - InlineTextBox "Result"',
          '- definition',
          '  - StaticText "READY-123"',
          '    - InlineTextBox "READY-"',
          '    - InlineTextBox "123"',
        ].join('\n'),
        targets: [{ targetId: 'opaque-target', role: 'button', name: 'Go' }],
        structureHints: { hiddenLoaded: [] },
        targetDefaults: { visible: true },
        nextCursor: 'cursor-secret',
        totalTargets: 2,
        returnedTargets: 2,
      },
      evidence: { targetSource: 'cdp_accessibility_dom' },
      riskFlags: { passwordInputCount: 0 },
      observationFresh: true,
      interactionReadiness: { directText: { physicalTargetToken: 'physical-secret' } },
      nextAllowedActions: ['click'],
      ambiguityGroups: [{ targetIds: ['opaque-target'] }],
      ok: true,
    },
  })

  const view = buildBrowserWorkflowVerifierEvidenceView(evidence(original))
  const excerpt = JSON.parse(view.resources[0].excerpt) as Record<string, any>

  assert.deepEqual(excerpt.result.pageIdentity, {
    url: 'https://example.test/result',
    title: 'Result',
  })
  assert.equal(excerpt.result.pageMap.text.includes('READY-123'), true)
  assert.equal(excerpt.result.pageMap.text.includes('InlineTextBox'), false)
  assert.equal(excerpt.result.pageMap.text.includes('StaticText "Result"'), false)
  assert.equal(excerpt.result.pageMap.targets, undefined)
  assert.equal(excerpt.result.pageMap.viewport, undefined)
  assert.equal(excerpt.result.interactionReadiness, undefined)
  assert.equal(excerpt.result.nextAllowedActions, undefined)
  assert.deepEqual(excerpt.result.evidence, { targetSource: 'cdp_accessibility_dom' })
  assert.deepEqual(excerpt.result.riskFlags, { passwordInputCount: 0 })
  assert.equal(original.content.includes('physical-secret'), true)
})

test('verifier view preserves unknown semantic observation fields', () => {
  const view = buildBrowserWorkflowVerifierEvidenceView(evidence(resource({
    operationId: 'read',
    result: {
      content: { rows: [{ name: 'Ivory', score: 322 }] },
      evidence: ['visible_row'],
      customFutureField: { accepted: true },
      ok: true,
    },
  })))
  assert.deepEqual(JSON.parse(view.resources[0].excerpt), {
    operationId: 'read',
    result: {
      content: { rows: [{ name: 'Ivory', score: 322 }] },
      evidence: ['visible_row'],
      customFutureField: { accepted: true },
      ok: true,
    },
  })
})

test('verifier journal keeps outcomes and causal bindings without transport identities', () => {
  const assessment: BrowserResearchAssessment = {
    taskId: 'task-1',
    satisfied: true,
    missingWorkItemIds: [],
    workItems: [{
      workItemId: 'work-1',
      goalRefs: ['goal-1'],
      requirement: 'Find the current value',
      query: 'current value',
      url: null,
      fieldGoals: ['value'],
      required: true,
      evidenceRefIds: ['evidence-1'],
      createdAt: '2026-07-19T00:00:00.000Z',
      childPayloadDigest: 'child-payload',
      childEvidenceDigest: 'child-evidence',
    }],
    evidenceRefs: [{
      evidenceRefId: 'evidence-1',
      workItemId: 'work-1',
      observationReceiptId: 'observation-receipt-1',
      actionReceiptId: 'action-receipt-1',
      observationSeq: 1,
      actionSeq: 1,
      operationId: 'snapshot',
      resultDigest: 'result-digest',
      resourceId: 'resource-1',
      contentDigest: 'content-digest',
      provenanceDigest: 'provenance-digest',
      identity: {
        documentState: 'document',
        tabId: 'tab-1',
        physicalTargetToken: 'physical-secret',
        frameId: 'frame-1',
        frameDocumentToken: 'document-secret',
        targetRef: null,
      },
      createdAt: '2026-07-19T00:00:00.000Z',
    }],
  }
  const view = buildBrowserWorkflowVerifierEvidenceView(evidence(resource({
    operationId: 'snapshot',
    result: { ok: true },
  }), assessment))

  const journal = JSON.parse(view.journalExcerpt) as Record<string, any>
  assert.equal(journal.settledOutcomes[0].outcome.operationId, 'click')
  assert.equal(journal.settledOutcomes[0].outcome.effect, 'observed')
  assert.deepEqual(journal.observationReceipts[0].causalActions, [{
    actionId: 'action-1',
    actionSeq: 1,
    searchActionId: null,
    queryDigest: null,
  }])
  assert.equal(journal.researchAssessment.workItems[0].requirement, 'Find the current value')
  assert.equal(view.journalExcerpt.includes('physical-secret'), false)
  assert.equal(view.journalExcerpt.includes('document-secret'), false)
})

test('verifier view rejects malformed resource content instead of silently dropping proof', () => {
  const malformed = resource({ ok: true })
  malformed.content = '{'
  assert.throws(
    () => buildBrowserWorkflowVerifierEvidenceView(evidence(malformed)),
    /browser_verifier_observation_content_invalid:resource-1/,
  )
})
