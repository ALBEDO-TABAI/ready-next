import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertBrowserExplicitReadOperationsAreObserve,
  BROWSER_CURRENT_PAGE_TOOL_NAMES,
  BROWSER_EXPLICIT_READ_TOOL_NAMES,
  buildBrowserAdmissionAuthoritySnapshot,
  composeBrowserAdmissionToolNames,
  resolveBrowserExecutionPageRef,
} from '../main/modules/agent-control/codex-runtime/codex-browser-admission'
import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { TAG_FORGE_EXCLUSIVE_TOOL_NAMES } from '../main/modules/agent-control/codex-runtime/codex-product-action-map'
import { buildCodexProductRequestEnvelope } from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'
import type { SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'

const pageRef = {
  tabId: 'tab-current',
  physicalTargetToken: 'physical-current',
  mainFrameId: '0',
  mainFrameDocumentToken: 'document-current',
}

const surface = [...new Set([
  'web_search',
  'web_fetch',
  'document_read_section',
  'document_save_tab',
  ...BROWSER_CURRENT_PAGE_TOOL_NAMES,
  ...BROWSER_EXPLICIT_READ_TOOL_NAMES,
  'browser_upload',
  'browser_download',
  'use_browser',
])]

function snapshotWith(admission: ReturnType<typeof buildBrowserAdmissionAuthoritySnapshot>) {
  return composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(surface, surface),
    authorizationId: 'auth-browser',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    browserAdmission: admission,
  })
}

test('explicit read tools are observe-only and never include tabs', () => {
  assertBrowserExplicitReadOperationsAreObserve()
  assert.equal(BROWSER_EXPLICIT_READ_TOOL_NAMES.includes('browser_tabs' as never), false)
})

test('document weather has research and no browser tools', () => {
  const composed = snapshotWith(buildBrowserAdmissionAuthoritySnapshot({
    authorityId: 'weather-document',
    activeWorkbenchMode: 'document',
  }))
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('web_search'))
  assert.equal(
    composed.readyTurnToolAuthorization.allowedToolNames.some((name) => name.startsWith('browser_')),
    false,
  )
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('use_browser'), false)
})

test('browser host without pageRef grants no browser tools', () => {
  const composed = snapshotWith(buildBrowserAdmissionAuthoritySnapshot({
    authorityId: 'host-only',
    activeWorkbenchMode: 'browser',
  }))
  assert.deepEqual(
    composed.readyTurnToolAuthorization.allowedToolNames.filter((name) => name.startsWith('browser_')),
    [],
  )
})

test('document plus explicit browser ref keeps document floor and observe-only browser set', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(surface, surface),
    authorizationId: 'auth-browser',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    currentDocument: { present: true, allowWrite: false },
    browserAdmission: buildBrowserAdmissionAuthoritySnapshot({
      authorityId: 'doc-plus-ref',
      activeWorkbenchMode: 'document',
      explicitBrowserReadRefs: [pageRef],
    }),
  })
  const names = composed.readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('document_read_section'))
  assert.equal(names.includes('document_save_tab'), false)
  assert.deepEqual(
    names.filter((name) => name.startsWith('browser_')).sort(),
    [...BROWSER_EXPLICIT_READ_TOOL_NAMES].sort(),
  )
  assert.equal(names.includes('browser_tabs'), false)
  assert.equal(names.includes('browser_click'), false)
})

test('current browser page plus document anchor keeps browser work set', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot(surface, surface),
    authorizationId: 'auth-browser',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    currentDocument: { present: true, allowWrite: false },
    workbenchMode: 'browser',
    browserAdmission: buildBrowserAdmissionAuthoritySnapshot({
      authorityId: 'browser-plus-doc',
      activeWorkbenchMode: 'browser',
      currentBrowserPageRef: pageRef,
    }),
  })
  const names = composed.readyTurnToolAuthorization.allowedToolNames
  assert.ok(names.includes('document_read_section'))
  assert.ok(names.includes('browser_click'))
  assert.equal(names.includes('browser_tabs'), false)
  assert.equal(names.includes('browser_download'), false)
})

test('tag forge exclusive removes every browser tool', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([...surface, ...TAG_FORGE_EXCLUSIVE_TOOL_NAMES], surface),
    authorizationId: 'auth-browser',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    exclusiveAllowSet: TAG_FORGE_EXCLUSIVE_TOOL_NAMES,
    browserAdmission: buildBrowserAdmissionAuthoritySnapshot({
      authorityId: 'tag-forge',
      activeWorkbenchMode: 'browser',
      currentBrowserPageRef: pageRef,
      tagForgeExclusive: true,
    }),
  })
  assert.deepEqual(
    composed.readyTurnToolAuthorization.allowedToolNames,
    [...TAG_FORGE_EXCLUSIVE_TOOL_NAMES].sort(),
  )
})

test('document anchor does not rewrite a browser workbench in the product envelope', () => {
  const request: SendScopedRequest = {
    scopeId: 'scope-1',
    requestId: 'request-1',
    message: 'read this page and the document',
    currentDocumentAnchor: {
      kind: 'current_document',
      logicalResourceId: 'doc-1',
      tabId: 'doc-1',
      title: 'Note',
      pane: 'primary',
      pathDigest: 'a'.repeat(64),
      incarnationKey: 'b'.repeat(64),
      currentVersion: `sha256:${'c'.repeat(64)}`,
      currentDigest: 'c'.repeat(64),
      supersedesVersion: null,
      policyEpoch: 1,
      readScope: { operation: 'read_section', maxChars: 1000 },
    },
    userMessage: {
      id: 'message-1',
      content: 'read this page and the document',
      timestamp: '2026-08-14T00:00:00.000Z',
      meta: { actionAuthorizationMode: 'full' },
      attachmentConfirmation: {
        selectedCount: 0,
        metadataCount: 0,
        inputIncludedCount: 0,
        inputFailedCount: 0,
      },
    },
  }
  const envelope = buildCodexProductRequestEnvelope(request, 'full', {
    workbenchMode: 'browser',
    browserPageRef: pageRef,
  })
  assert.equal(envelope.environmentHints.workbenchMode, 'browser')
  assert.equal(envelope.environmentHints.browserPageRef?.tabId, 'tab-current')
  assert.ok(envelope.resources.some((resource) => resource.kind === 'document_context'))
})

test('current page admission hides mixed browser_tabs until successor authority exists', () => {
  const names = composeBrowserAdmissionToolNames(buildBrowserAdmissionAuthoritySnapshot({
    authorityId: 'no-tabs',
    activeWorkbenchMode: 'browser',
    currentBrowserPageRef: pageRef,
  }))
  assert.equal(names.includes('browser_tabs'), false)
  assert.ok(names.includes('browser_click'))
})

test('skill cannot reopen browser tools without a page identity', () => {
  const names = composeBrowserAdmissionToolNames(buildBrowserAdmissionAuthoritySnapshot({
    authorityId: 'skill-no-page',
    activeWorkbenchMode: 'document',
    selectedSkillToolNames: ['browser_status', 'browser_eval', 'browser_upload', 'browser_archive'],
  }))
  assert.deepEqual(names, [])
})

test('skill cannot add upload or archive without the matching resource conditions', () => {
  const names = composeBrowserAdmissionToolNames(buildBrowserAdmissionAuthoritySnapshot({
    authorityId: 'skill-bypass',
    activeWorkbenchMode: 'browser',
    currentBrowserPageRef: pageRef,
    selectedSkillToolNames: ['browser_status', 'browser_upload', 'browser_archive', 'browser_eval'],
  }))
  assert.ok(names.includes('browser_eval'))
  assert.ok(names.includes('browser_status'))
  assert.equal(names.includes('browser_upload'), false)
  assert.equal(names.includes('browser_archive'), false)
})

test('document workbench plus explicit page pins execution to the referenced tab', () => {
  const referenced = {
    tabId: 'tab-background',
    physicalTargetToken: 'physical-background',
    mainFrameId: '0',
    mainFrameDocumentToken: 'document-background',
  }
  const snapshot = buildBrowserAdmissionAuthoritySnapshot({
    authorityId: 'doc-exec-pin',
    activeWorkbenchMode: 'document',
    currentBrowserPageRef: pageRef,
    explicitBrowserReadRefs: [referenced],
  })
  assert.equal(snapshot.currentBrowserRoot, null)
  assert.equal(resolveBrowserExecutionPageRef(snapshot)?.tabId, 'tab-background')
  const envelope = buildCodexProductRequestEnvelope({
    scopeId: 'scope-1',
    requestId: 'request-doc-ref',
    expectedAliasGeneration: 0,
    expectedMessageVisibilityEpoch: 0,
    message: 'read the cited page',
    userMessage: {
      id: 'message-doc-ref',
      content: 'read the cited page',
      timestamp: '2026-08-14T00:00:00.000Z',
      meta: { actionAuthorizationMode: 'full' },
      attachmentConfirmation: {
        selectedCount: 0,
        metadataCount: 0,
        inputIncludedCount: 0,
        inputFailedCount: 0,
      },
    },
  }, 'full', {
    workbenchMode: 'document',
    browserPageRef: resolveBrowserExecutionPageRef(snapshot)!,
  })
  assert.equal(envelope.environmentHints.workbenchMode, 'document')
  assert.equal(envelope.environmentHints.browserPageRef?.tabId, 'tab-background')
})

test('same facts produce one admission digest regardless of explicit-ref order', () => {
  const first = buildBrowserAdmissionAuthoritySnapshot({
    authorityId: 'same',
    activeWorkbenchMode: 'browser',
    currentBrowserPageRef: pageRef,
    explicitBrowserReadRefs: [pageRef, { ...pageRef, tabId: 'tab-other', physicalTargetToken: 'p2', mainFrameDocumentToken: 'd2' }],
    selectedSkillToolNames: ['browser_eval', 'browser_status'],
  })
  const second = buildBrowserAdmissionAuthoritySnapshot({
    authorityId: 'same',
    activeWorkbenchMode: 'browser',
    currentBrowserPageRef: pageRef,
    explicitBrowserReadRefs: [
      { ...pageRef, tabId: 'tab-other', physicalTargetToken: 'p2', mainFrameDocumentToken: 'd2' },
      pageRef,
    ],
    selectedSkillToolNames: ['browser_status', 'browser_eval'],
  })
  assert.equal(first.authorityDigest, second.authorityDigest)
  assert.ok(composeBrowserAdmissionToolNames(first).includes('browser_eval'))
})
