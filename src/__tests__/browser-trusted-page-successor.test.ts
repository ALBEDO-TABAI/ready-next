import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserActionOutcome } from '../shared/browser-action-outcome'
import { resolveTrustedBrowserPageRefFromControlledNavigation } from '../main/modules/browser-engine/browser-workflow-evidence'

const pin = {
  tabId: 'tab-note',
  physicalTargetToken: 'physical-note',
  mainFrameDocumentToken: 'document-note',
}

function outcome(patch: Partial<BrowserActionOutcome> & {
  actionSeq: number
  identity: BrowserActionOutcome['identity']
  successorIdentity: BrowserActionOutcome['successorIdentity']
}): BrowserActionOutcome {
  return {
    actionId: `action-${patch.actionSeq}`,
    taskId: 'browser-task-1',
    ownerRunId: 'run-1',
    operationId: 'click',
    mode: 'mutate',
    dispatch: 'accepted',
    delivery: 'delivered',
    effect: 'observed',
    needsObservation: true,
    mayHaveCommitted: true,
    ...patch,
  }
}

test('controlled same-tab navigation promotes the trusted page without dropping the admission pin identity', () => {
  const promoted = resolveTrustedBrowserPageRefFromControlledNavigation(pin, [
    outcome({
      actionSeq: 1,
      identity: {
        documentState: 'document',
        tabId: 'tab-note',
        physicalTargetToken: 'physical-note',
        frameId: '0',
        frameDocumentToken: 'document-note',
        targetRef: null,
      },
      successorIdentity: {
        documentState: 'document',
        tabId: 'tab-note',
        physicalTargetToken: 'physical-note',
        frameId: '0',
        frameDocumentToken: 'document-image',
        targetRef: null,
      },
    }),
  ])
  assert.deepEqual(promoted, {
    tabId: 'tab-note',
    physicalTargetToken: 'physical-note',
    mainFrameDocumentToken: 'document-image',
  })
  assert.equal(pin.mainFrameDocumentToken, 'document-note')
})

test('a replaced physical page instance on the same tab is not a trusted successor', () => {
  assert.deepEqual(
    resolveTrustedBrowserPageRefFromControlledNavigation(pin, [
      outcome({
        actionSeq: 1,
        identity: {
          documentState: 'document',
          tabId: 'tab-note',
          physicalTargetToken: 'physical-note',
          frameId: '0',
          frameDocumentToken: 'document-note',
          targetRef: null,
        },
        successorIdentity: {
          documentState: 'document',
          tabId: 'tab-note',
          physicalTargetToken: 'physical-replaced-instance',
          frameId: '0',
          frameDocumentToken: 'document-replaced',
          targetRef: null,
        },
      }),
    ]),
    pin,
  )
})

test('unrelated tabs and rejected jumps cannot become the trusted successor page', () => {
  assert.deepEqual(
    resolveTrustedBrowserPageRefFromControlledNavigation(pin, [
      outcome({
        actionSeq: 1,
        dispatch: 'rejected',
        delivery: 'not_delivered',
        identity: {
          documentState: 'document',
          tabId: 'tab-note',
          physicalTargetToken: 'physical-note',
          frameId: '0',
          frameDocumentToken: 'document-note',
          targetRef: null,
        },
        successorIdentity: {
          documentState: 'document',
          tabId: 'tab-note',
          physicalTargetToken: 'physical-note',
          frameId: '0',
          frameDocumentToken: 'document-image',
          targetRef: null,
        },
      }),
      outcome({
        actionSeq: 2,
        identity: {
          documentState: 'document',
          tabId: 'tab-other',
          physicalTargetToken: 'physical-other',
          frameId: '0',
          frameDocumentToken: 'document-other',
          targetRef: null,
        },
        successorIdentity: {
          documentState: 'document',
          tabId: 'tab-other',
          physicalTargetToken: 'physical-other',
          frameId: '0',
          frameDocumentToken: 'document-other-2',
          targetRef: null,
        },
      }),
    ]),
    pin,
  )
})
