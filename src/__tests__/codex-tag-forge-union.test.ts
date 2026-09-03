import assert from 'node:assert/strict'
import test from 'node:test'

import { isCodexFolderTagForgeAlias } from '../main/modules/agent-control/codex-runtime/codex-folder-tag-forge-alias'
import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { TAG_FORGE_EXCLUSIVE_TOOL_NAMES } from '../main/modules/agent-control/codex-runtime/codex-product-action-map'
import { resolveCodexProductTurnAuthorization } from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { RequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'

test('folder tagging alias requires a typed folder and an explicit folder-tag action', () => {
  assert.equal(isCodexFolderTagForgeAlias({
    userText: '给这个文件夹打标',
    hasTypedFolder: true,
  }), true)
  assert.equal(isCodexFolderTagForgeAlias({
    userText: '给这个文件夹打标',
    hasTypedFolder: false,
  }), false)
  assert.equal(isCodexFolderTagForgeAlias({
    userText: '研究标签体系',
    hasTypedFolder: true,
  }), false)
})

test('selected tag-forge plus folder yields the exclusive five-tool surface', () => {
  const authorization = buildSelectedSkillToolAuthorization({
    skillId: 'tag-forge',
    allowedTypedActions: [],
    allowedPrimitives: [...TAG_FORGE_EXCLUSIVE_TOOL_NAMES],
    source: 'explicit',
    reason: 'typed_ref',
  })
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([
      ...TAG_FORGE_EXCLUSIVE_TOOL_NAMES,
      'file_inventory',
      'file_move',
      'skill_run_shell',
      'skill_write_artifact',
      'ask_user_questions',
    ]),
    authorizationId: 'tf-auth',
    authorization,
    explicitResourceAllowedToolNames: ['file_inventory'],
    exclusiveAllowSet: TAG_FORGE_EXCLUSIVE_TOOL_NAMES,
  })
  assert.deepEqual(composed.readyTurnToolAuthorization.allowedToolNames, [...TAG_FORGE_EXCLUSIVE_TOOL_NAMES].sort())
  for (const banned of ['file_inventory', 'file_move', 'skill_run_shell', 'skill_write_artifact', 'ask_user_questions']) {
    assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes(banned), false)
  }
})

test('folder tagging alias becomes a selected tag-forge authorization, not a second regex grant', () => {
  const resolved = resolveCodexProductTurnAuthorization({
    mode: 'commit',
    host: {
      getScope: () => ({
        id: 'scope-tf',
        aliasGeneration: 1,
        messageVisibilityEpoch: 1,
        agent: 'butler',
        activeAgentId: 'butler',
        handoffGeneration: 0,
        title: 't',
        sourceKind: 'local',
        sourceId: 'local',
        threadKey: 'thread',
        meta: {},
        createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:00:00.000Z',
      }),
      resolveSkillAuthorizationForTurn: (input) => {
        const envelope = input.requestEnvelope as RequestEnvelope
        if (envelope.resources.some((resource) => resource.kind === 'skill_reference' && resource.name === 'tag-forge')) {
          return buildSelectedSkillToolAuthorization({
            skillId: 'tag-forge',
            allowedTypedActions: [],
            allowedPrimitives: [...TAG_FORGE_EXCLUSIVE_TOOL_NAMES],
            source: 'explicit',
            reason: 'typed_ref:explicit_user_mention',
          })
        }
        return buildExplicitNoSkillAuthorization('no_skill_signal')
      },
    },
    request: {
      scopeId: 'scope-tf',
      requestId: 'req-tf',
      expectedAliasGeneration: 1,
      expectedMessageVisibilityEpoch: 1,
      message: '给这个文件夹打标',
      userMessage: {
        id: 'msg-tf',
        content: '给这个文件夹打标',
        timestamp: '2026-08-14T00:00:00.000Z',
        meta: {},
        attachmentConfirmation: {
          selectedCount: 0,
          metadataCount: 0,
          inputIncludedCount: 0,
          inputFailedCount: 0,
        },
      },
    },
    scopeId: 'scope-tf',
    externalReadSlice: null,
    trustedResources: [{
      id: 'folder',
      kind: 'folder_reference',
      source: 'folder_reference',
      name: '工作内容',
      path: '/tmp/工作内容',
      text: '',
      summary: null,
      order: 0,
      canRead: true,
      canWrite: false,
    }],
  })
  assert.equal(resolved.authorization.mode, 'selected')
  assert.equal(resolved.authorization.mode === 'selected' ? resolved.authorization.skillId : '', 'tag-forge')
  assert.equal(
    resolved.requestEnvelope.resources.some((resource) => resource.kind === 'skill_reference' && resource.name === 'tag-forge'),
    true,
  )
})
