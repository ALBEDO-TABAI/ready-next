import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCodexProductRequestEnvelope,
  buildExplicitResourceReadToolSnapshot,
  readCodexPreparedActionAuthorizationEnvelope,
  toCodexInput,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import type { RequestEnvelopeResource } from '../main/modules/agent-control/contracts/request-envelope'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import {
  parseSendScopedRequest,
  type SendScopedRequest,
} from '../shared/ipc-contracts/agent-runtime'
import { createCodexToolFixtureFromDefinitions } from './utils/codex-tool-fixture'

const request: SendScopedRequest = {
  scopeId: 'scope-1',
  requestId: 'request-1',
  expectedAliasGeneration: 1,
  expectedMessageVisibilityEpoch: 1,
  message: '读取这些资源',
  resources: [{
    kind: 'local_file', id: 'renderer-file', name: 'notes.txt', path: '/forged/renderer/path',
    size: 1, ext: '.fake', rendererType: 'image',
  }],
  userMessage: {
    id: 'message-1',
    content: '读取这些资源',
    timestamp: '2026-08-11T00:00:00.000Z',
    meta: {},
    attachmentConfirmation: {
      selectedCount: 1, metadataCount: 1, inputIncludedCount: 1, inputFailedCount: 0,
    },
  },
}

const trustedResources: RequestEnvelopeResource[] = [
  {
    id: 'local-file:trusted', kind: 'attachment', source: 'user_attachment',
    name: 'notes.txt', path: '/canonical/notes.txt', text: '', summary: null,
    order: 0, canRead: true, canWrite: false,
  },
  {
    id: 'local-directory:trusted', kind: 'folder_reference', source: 'folder_reference',
    name: '资料', path: '/canonical/资料', text: '', summary: null,
    order: 1, canRead: true, canWrite: false,
  },
]

test('product envelope consumes only Main-trusted body-free resources', () => {
  const envelope = buildCodexProductRequestEnvelope(request, 'auto', {}, trustedResources)
  assert.deepEqual(envelope.resources, trustedResources)
  assert.equal(envelope.environmentHints.hasAttachments, true)
  assert.deepEqual(envelope.environmentHints.workspaceRoots, ['/canonical/资料'])
  assert.equal(JSON.stringify(envelope).includes('/forged/renderer/path'), false)
})

test('sendScoped accepts only the narrow resource selection boundary', () => {
  assert.deepEqual(parseSendScopedRequest(request).resources, request.resources)
  assert.throws(() => parseSendScopedRequest({
    ...request,
    resources: [{ ...request.resources?.[0], body: 'must stay in Main-owned storage' }],
  }), /unrecognized_keys/)
})

test('an attachment-only send retains an empty canonical text anchor for the resource turn', () => {
  const attachmentOnly = {
    ...request,
    message: '',
    userMessage: { ...request.userMessage, content: '' },
  }
  assert.deepEqual(toCodexInput(attachmentOnly), [
    { type: 'text', text: '', text_elements: [] },
  ])
})

test('prepared resource authority reconstructs a narrow tool envelope after persistence', () => {
  const digest = 'a'.repeat(64)
  const envelope = readCodexPreparedActionAuthorizationEnvelope({
    prepared: {
      actionAuthorizationMode: 'full',
      ingress: { attemptKind: 'user_ingress' },
      resourceAuthorities: [
        {
          kind: 'local_file', logicalResourceId: 'local-file:trusted', name: 'notes.txt',
          path: '/canonical/notes.txt', currentVersion: `sha256:${digest}`,
          currentDigest: digest, policyEpoch: 1,
          allowedToolNames: ['file_extract_text', 'file_read_excerpt'],
        },
        {
          kind: 'local_directory', logicalResourceId: 'local-directory:trusted', name: '资料',
          path: '/canonical/资料', currentVersion: `sha256:${digest}`,
          currentDigest: digest, policyEpoch: 1, allowedToolNames: ['file_inventory'],
        },
      ],
    },
  } as never)
  assert.equal(envelope.actionAuthorizationMode, 'full')
  assert.deepEqual(envelope.resources?.map((resource) => ({
    kind: resource.kind,
    path: resource.path,
    text: resource.text,
    summary: resource.summary,
    canRead: resource.canRead,
    canWrite: resource.canWrite,
  })), [
    {
      kind: 'attachment', path: '/canonical/notes.txt', text: '', summary: null,
      canRead: true, canWrite: false,
    },
    {
      kind: 'folder_reference', path: '/canonical/资料', text: '', summary: null,
      canRead: true, canWrite: false,
    },
  ])
  assert.deepEqual(envelope.environmentHints?.workspaceRoots, ['/canonical/资料'])
})

test('explicit read-only resources cannot inherit unrelated file mutation authority', () => {
  const definition = (name: string, domain: 'file' | 'browser'): ToolDefinition => ({
    name,
    groupId: domain === 'file' ? 'file_management' : 'browser',
    domain,
    kind: domain === 'file' && name === 'file_move' ? 'write' : 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: null,
    description: name,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    executionVisibility: 'model',
    resultShape: 'json',
  })
  const fixture = createCodexToolFixtureFromDefinitions([
    definition('file_inventory', 'file'),
    definition('file_move', 'file'),
    definition('browser_navigate', 'browser'),
  ])
  const snapshot = buildExplicitResourceReadToolSnapshot({
    resolved: fixture,
    authorizationId: 'authorization-explicit-read',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    allowedResourceToolNames: ['file_inventory'],
  })
  assert.deepEqual(snapshot.readyTurnToolAuthorization.allowedToolNames, [
    'browser_navigate',
    'file_inventory',
  ])
})
