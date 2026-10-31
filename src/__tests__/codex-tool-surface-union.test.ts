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

test('without a current document no document tool is offered, while file and folder tools stay', () => {
  const documentTools = [
    'document_new_tab', 'document_open_tab', 'document_switch_tab', 'document_rename_tab', 'document_set_content',
    'document_append_content', 'document_insert_widget', 'document_update_widget', 'document_remove_widget',
    'document_replace_text', 'document_replace_exact', 'document_format_section', 'document_rewrite_section',
    'document_save_tab', 'document_read_section', 'document_list_widgets',
  ]
  // A message that only mentions "文档" with an attached file: every document action would fail for lack of an anchor.
  const composed = composeCodexTurnToolSnapshot({
    resolved: workbenchTestSnapshot([...documentTools, 'file_read_excerpt', 'file_inventory', 'skill_write_artifact',
      'skill_export_artifact', 'declare_completion_criteria']),
    authorizationId: 'auth-no-document',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    explicitResourceAllowedToolNames: ['file_read_excerpt', 'file_inventory'],
    folderExport: { present: true, allowWrite: true },
  })
  const allowed = composed.readyTurnToolAuthorization.allowedToolNames
  assert.deepEqual(allowed.filter((name) => name.startsWith('document_')), [])
  for (const name of ['file_read_excerpt', 'file_inventory', 'skill_write_artifact', 'skill_export_artifact']) {
    assert.ok(allowed.includes(name), name)
  }
})

test('M7 resources add only their exact read floor and reject missing or exclusive surfaces', async () => {
  const { LIBRARY_READ_TOOL_NAMES } = await import('../main/modules/agent-control/codex-runtime/library-read-tools')
  const base = { resolved: workbenchTestSnapshot([...LIBRARY_READ_TOOL_NAMES, 'web_search']), authorizationId: 'library-auth', authorization: buildExplicitNoSkillAuthorization('no_skill_signal') }
  const selected = composeCodexTurnToolSnapshot({ ...base, libraryReadTools: ['library_read_board'] })
  assert.equal(selected.readyTurnToolAuthorization.allowedToolNames.includes('library_read_board'), true)
  assert.equal(selected.readyTurnToolAuthorization.allowedToolNames.includes('library_read_page'), false)
  assert.equal(selected.readyTurnToolAuthorization.allowedToolNames.includes('web_search'), true)
  assert.throws(() => composeCodexTurnToolSnapshot({ ...base, resolved: workbenchTestSnapshot(['web_search']), libraryReadTools: ['library_read_board'] }), /library_read_tool_surface_missing/)
  const { classifyCodexIngressPreparationError } = await import('../main/modules/agent-control/codex-runtime/codex-ingress-preparation-error')
  assert.throws(() => composeCodexTurnToolSnapshot({ ...base, exclusiveAllowSet: TAG_FORGE_EXCLUSIVE_TOOL_NAMES, libraryReadTools: ['library_read_board'] }), error => {
    assert.deepEqual(classifyCodexIngressPreparationError(error), { code: 'native_tool_surface_extension_required', retryableByUser: false, error: 'library_read_tool_surface_missing' })
    return true
  })
  assert.equal(composeCodexTurnToolSnapshot(base).readyTurnToolAuthorization.allowedToolNames.some(name => LIBRARY_READ_TOOL_NAMES.some(tool => tool === name)), false)
})

test('M7 actual registry definitions freeze real read-only schemas', async () => {
  const { defaultToolRegistry } = await import('../main/modules/agent-control/tools-runtime/tool-registry')
  const { buildReadyToolSurface } = await import('../main/modules/agent-control/codex-runtime/codex-tool-surface')
  const { LIBRARY_READ_TOOL_NAMES } = await import('../main/modules/agent-control/codex-runtime/library-read-tools')
  const definitions = defaultToolRegistry.getToolDefinitionsForGroup('document', undefined, buildExplicitNoSkillAuthorization('no_skill_signal')).filter(d => LIBRARY_READ_TOOL_NAMES.some(name => name === d.name))
  assert.equal(definitions.length, 9)
  const surface = buildReadyToolSurface({ surfaceId: 'actual-library', toolDefinitions: definitions })
  for (const entry of surface.entries) {
    assert.equal(entry.effectProfile.domain, 'document'); assert.equal(entry.effectProfile.kind, 'read')
    assert.equal(entry.inputSchema.additionalProperties, false)
    assert.deepEqual((entry.inputSchema.required as string[]).slice(0, 2), ['resourceId', 'expectedVersion'])
  }
})


test('M7 turns without library resources preserve the pre-M7 frozen surface', async () => {
  const { listLiveCodexThreadToolDefinitions } = await import('../main/modules/agent-control/runtime-core/agent-sdk-tool-executor')
  const { buildReadyToolSurface, resolveReadyToolTurnSnapshot, selectCodexRootToolDefinitions } = await import('../main/modules/agent-control/codex-runtime/codex-tool-surface')
  const { isLibraryReadTool } = await import('../main/modules/agent-control/codex-runtime/library-read-tools')
  const all = listLiveCodexThreadToolDefinitions()
  const before = buildReadyToolSurface({ surfaceId: 'pre-m7', toolDefinitions: selectCodexRootToolDefinitions(all.filter(d => !isLibraryReadTool(d.name))) })
  const current = all.filter(d => d.groupId === 'document')
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  const result = resolveReadyToolTurnSnapshot({ surfaceId: 'next', authorizationId: 'turn', authorization,
    frozenToolSurface: before, source: { listDefaultToolDefinitionsForTurn: () => current, listCodexThreadToolDefinitions: () => all },
    resolutionInput: { message: { text: 'hello' }, config: {} as never, browserHostAvailable: false, feishuConnected: false, authorization },
  })
  assert.equal(result.readyToolSurface.toolSurfaceDigest, before.toolSurfaceDigest)
  assert.equal(result.readyToolSurface.toolNames.some(isLibraryReadTool), false)
})

test('M7 one session switches no resource, library resource, no resource without resetting ordinary turns', async () => {
  const { listLiveCodexThreadToolDefinitions } = await import('../main/modules/agent-control/runtime-core/agent-sdk-tool-executor')
  const { resolveReadyToolTurnSnapshot, CodexToolSurfaceError } = await import('../main/modules/agent-control/codex-runtime/codex-tool-surface')
  const { isLibraryReadTool, LIBRARY_READ_TOOL_NAMES } = await import('../main/modules/agent-control/codex-runtime/library-read-tools')
  const all = listLiveCodexThreadToolDefinitions()
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  const base = {
    surfaceId: 'session-m7', authorizationId: 'turn-1', authorization,
    source: { listDefaultToolDefinitionsForTurn: () => all.filter(d => d.groupId === 'document'), listCodexThreadToolDefinitions: () => all },
    resolutionInput: { sessionId: 'session-m7', scopeId: 'session-m7', message: { text: 'hello' }, config: {} as never, browserHostAvailable: false, feishuConnected: false, authorization },
  }
  const first = resolveReadyToolTurnSnapshot(base)
  assert.equal(first.readyToolSurface.toolNames.some(isLibraryReadTool), false)
  assert.equal(first.readyTurnToolAuthorization.allowedToolNames.some(isLibraryReadTool), false)
  assert.ok(first.readyToolSurface.toolNames.length > 0)
  const withResource = {
    ...base, authorizationId: 'turn-2',
    resolutionInput: { ...base.resolutionInput, requestEnvelope: { resources: [{ kind: 'library_resource', canRead: true }] } },
  }
  assert.throws(() => resolveReadyToolTurnSnapshot({ ...withResource, frozenToolSurface: first.readyToolSurface }), error =>
    error instanceof CodexToolSurfaceError && error.code === 'native_tool_surface_extension_required')
  // A new context may register the floor; a running native thread may not expand itself.
  const second = composeCodexTurnToolSnapshot({
    resolved: resolveReadyToolTurnSnapshot(withResource), authorizationId: 'turn-2', authorization,
    libraryReadTools: ['library_read_board'],
  })
  assert.deepEqual(second.readyToolSurface.toolNames.filter(isLibraryReadTool).sort(), [...LIBRARY_READ_TOOL_NAMES].sort())
  assert.deepEqual(second.readyTurnToolAuthorization.allowedToolNames.filter(isLibraryReadTool), ['library_read_board'])
  for (const frozenToolSurface of [first.readyToolSurface, second.readyToolSurface]) {
    const third = resolveReadyToolTurnSnapshot({ ...base, authorizationId: 'turn-3', frozenToolSurface })
    assert.equal(third.readyToolSurface, frozenToolSurface)
    assert.deepEqual(third.readyTurnToolAuthorization.allowedToolNames, first.readyTurnToolAuthorization.allowedToolNames)
    assert.equal(third.readyTurnToolAuthorization.allowedToolNames.some(isLibraryReadTool), false)
  }
  const unavailable = resolveReadyToolTurnSnapshot({
    ...base, frozenToolSurface: first.readyToolSurface,
    resolutionInput: { ...base.resolutionInput, requestEnvelope: { resources: [{ kind: 'library_resource', canRead: false }] } },
  })
  assert.equal(unavailable.readyToolSurface, first.readyToolSurface)
  assert.deepEqual(unavailable.readyTurnToolAuthorization.allowedToolNames, first.readyTurnToolAuthorization.allowedToolNames)
})
