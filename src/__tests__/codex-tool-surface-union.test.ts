import assert from 'node:assert/strict'
import test from 'node:test'

import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { TAG_FORGE_EXCLUSIVE_TOOL_NAMES } from '../main/modules/agent-control/codex-runtime/codex-product-action-map'
import { effectiveCodexFolderOutputToolNames } from '../main/modules/agent-control/codex-runtime/codex-folder-output-activation'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'

test('document visible plus RSS request keeps document read and RSS tools, without document writes', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([
      'document_read_section',
      'document_insert_widget',
      'rss_fetch_updates',
      'rss_capture_session',
      'file_search',
    ]),
    authorizationId: 'auth-doc-rss',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    currentDocument: { present: true, allowWrite: false },
    workbenchMode: 'document',
  })
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('document_read_section'))
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('rss_fetch_updates'))
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('document_insert_widget'), false)
})

test('current document and external read floors compose instead of replacing each other', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([
      'document_read_section',
      'document_save_tab',
      'web_search',
      'file_search',
      'feishu_doc_read',
    ]),
    authorizationId: 'auth-union-external',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    currentDocument: { present: true, allowWrite: false },
    externalReadAllowedToolNames: ['feishu_doc_read'],
  })
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('document_read_section'))
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('feishu_doc_read'))
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('document_save_tab'), false)
})

test('typed folder plus output intent grants host write/export without selecting a skill', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([
      'file_inventory',
      'web_search',
      'skill_write_artifact',
      'skill_export_artifact',
    ], [
      'file_inventory',
      'web_search',
    ]),
    authorizationId: 'auth-folder-export',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    explicitResourceAllowedToolNames: ['file_inventory'],
    folderExport: { present: true, allowWrite: true },
  })
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('file_inventory'))
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('skill_write_artifact'))
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('skill_export_artifact'))
  assert.deepEqual(
    effectiveCodexFolderOutputToolNames(
      composed.readyTurnToolAuthorization.allowedToolNames,
      { kind: 'pending' },
    ).filter((name) => name.startsWith('skill_')),
    [],
  )
  assert.deepEqual(
    effectiveCodexFolderOutputToolNames(
      composed.readyTurnToolAuthorization.allowedToolNames,
      {
        kind: 'positive',
        destinationResourceId: 'local-directory:output',
        expectedOutputs: ['report.md'],
        declarationActionId: 'action-1',
        declarationReceiptId: 'receipt-1',
        declarationResultDigest: 'digest-1',
        deliveryAttemptId: 'delivery-1',
      },
    ).filter((name) => name.startsWith('skill_')),
    ['skill_export_artifact', 'skill_write_artifact'],
  )
})

test('typed folder without output intent stays read-only', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([
      'file_inventory',
      'web_search',
      'skill_write_artifact',
      'skill_export_artifact',
    ], [
      'file_inventory',
      'web_search',
    ]),
    authorizationId: 'auth-folder-read',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    explicitResourceAllowedToolNames: ['file_inventory'],
    folderExport: { present: true, allowWrite: false },
  })
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('file_inventory'))
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('skill_write_artifact'), false)
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('skill_export_artifact'), false)
})

test('explicit folder does not strip a selected skill floor', () => {
  const authorization = {
    mode: 'selected' as const,
    skillId: 'social-media-ops',
    allowedTypedActions: ['skill_read_artifact'],
    allowedPrimitives: ['file_locate'],
    source: 'explicit' as const,
    reason: 'typed_ref',
  }
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([
      'skill_read_artifact',
      'file_locate',
      'file_inventory',
      'file_move',
      'file_search',
    ]),
    authorizationId: 'auth-skill-folder',
    authorization,
    explicitResourceAllowedToolNames: ['file_inventory'],
  })
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('skill_read_artifact'))
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('file_locate'))
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('file_inventory'))
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('file_move'), false)
})

test('idle chat without typed file authority has no write, organize or tag forge tools', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([
      'file_search',
      'file_locate',
      'file_move',
      'file_organize_apply',
      'tag_forge_prepare_batch',
    ]),
    authorizationId: 'auth-idle',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
  })
  assert.ok(composed.readyTurnToolAuthorization.allowedToolNames.includes('file_search'))
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('file_move'), false)
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('file_organize_apply'), false)
  assert.equal(composed.readyTurnToolAuthorization.allowedToolNames.includes('tag_forge_prepare_batch'), false)
})

test('Tag Forge exclusive set replaces the composed allow-set', () => {
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([
      ...TAG_FORGE_EXCLUSIVE_TOOL_NAMES,
      'file_inventory',
      'file_move',
      'ask_user_questions',
    ]),
    authorizationId: 'auth-tag-forge',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    explicitResourceAllowedToolNames: ['file_inventory'],
    exclusiveAllowSet: TAG_FORGE_EXCLUSIVE_TOOL_NAMES,
  })
  assert.deepEqual(composed.readyTurnToolAuthorization.allowedToolNames, [...TAG_FORGE_EXCLUSIVE_TOOL_NAMES].sort())
})
