import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  CodexProductRunPreparer,
  isPreparedCodexProductRun,
  preparedCodexProductRunMatchesIngress,
} from '../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { textUserInput } from '../main/modules/agent-control/codex-runtime/codex-turn-input-builder'
import { digestCodexUserInput } from '../main/modules/agent-control/codex-runtime/codex-user-input'
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { RSS_READ_TOOL_NAMES, rssResourceVersion } from '../main/modules/agent-control/codex-runtime/codex-rss-resources'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  externalReadResourceReference,
  prepareFeishuExternalReadSlice,
} from '../main/modules/agent-control/codex-runtime/codex-external-read-slice'
import { effectiveCodexFolderOutputToolNames } from '../main/modules/agent-control/codex-runtime/codex-folder-output-activation'
import {
  CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
  createCodexProductBudgetSeed,
  resolveCodexBrowserWorkflowTaskFacts,
  resolveCodexProductCloseoutTaskFacts,
  resolveCodexProductTaskFacts,
} from '../main/modules/agent-control/codex-runtime/codex-product-task-facts'
import { resolveCodexNativeSkillInput } from '../main/modules/agent-control/codex-runtime/codex-thread-instructions'
import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import { disabledReadyMemorySnapshot } from './utils/ready-memory-fixture'

const preparer = new CodexProductRunPreparer()
const documentDigest = 'a'.repeat(64)
const documentAnchor = {
  kind: 'current_document',
  logicalResourceId: 'ready-current-document:scope-1:doc-1',
  tabId: 'doc-1',
  title: 'Current plan',
  pane: 'primary',
  pathDigest: 'b'.repeat(64),
  incarnationKey: 'c'.repeat(64),
  currentVersion: `sha256:${documentDigest}`,
  currentDigest: documentDigest,
  supersedesVersion: null,
  policyEpoch: 2,
  readScope: { operation: 'read_section', maxChars: 30_000 },
} as const
const documentReference = {
  logicalResourceId: documentAnchor.logicalResourceId,
  currentVersion: documentAnchor.currentVersion,
  currentDigest: documentAnchor.currentDigest,
  supersedesVersion: documentAnchor.supersedesVersion,
  policyEpoch: documentAnchor.policyEpoch,
}
const base = {
  taskId: 'task-1',
  runId: 'run-1',
  requestId: 'request-1',
  scopeId: 'scope-1',
  aliasId: 'alias-1',
  aliasGeneration: 1,
  taskOrigin: 'user_root',
  runOrigin: 'initial',
  originUserMessageId: 'message-1',
  reservationSetId: 'reservation-set-1',
  reservationEvidenceDigest: 'reservation-evidence-1',
  currentInput: [textUserInput('hello')],
  explicitResourceEnvelope: { input: [], resourceRefs: [] },
  resourceAdditionalContext: [],
  trustedWorkbenchMode: 'browser',
  actionAdmissionRef: {
    headProjectionDigest: 'f'.repeat(64),
    actionProjectionVersion: {
      scopeEpoch: 0,
      headGeneration: 1,
      actionProjectionSequence: 0,
    },
    actionHeadIdentity: {
      aliasId: 'alias-1',
      aliasGeneration: 1,
      threadBindingId: 'binding-1',
      headRevision: 1,
    },
  },
  uncommittedTailAssignments: [],
  supersededUncommittedItems: [],
  readyMemorySnapshot: disabledReadyMemorySnapshot(),
  ...createCodexToolFixture(),
  authorizationOwnerId: 'owner-1',
  resourceOwnerId: 'resource-owner-1',
  productBudgetSeed: {
    maxIterations: 8,
    maxToolCalls: 4,
    maxParallelToolGroups: 1,
  },
} as const

test('product run preparer produces a neutral user-root payload with no prompt assembly fields', () => {
  const result = preparer.prepare(base)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.prepared.ingress.kind, 'user_ingress')
  assert.equal(result.prepared.actionAuthorizationMode, 'ask')
  assert.equal(result.prepared.neutralProjectionSeed.taskTitle, '正在理解需求')
  for (const forbidden of [
    'systemPrompt',
    'persona',
    'memoryRefs',
    'triggerHits',
    'compression',
    'deliveryMode',
    'parentTaskId',
    'workflow',
    'preparedMessage',
  ]) {
    assert.equal(forbidden in result.prepared, false, forbidden)
  }
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
  assert.equal(preparedCodexProductRunMatchesIngress(result.prepared, {
    scopeId: base.scopeId,
    aliasId: base.aliasId,
    aliasGeneration: base.aliasGeneration,
    requestId: base.requestId,
    originUserMessageId: base.originUserMessageId,
    reservationSetId: base.reservationSetId,
    reservationEvidenceDigest: base.reservationEvidenceDigest,
  }), true)
})

test('legacy e1 prepared rows are audit-only and cannot resume as current ingress', () => {
  const result = preparer.prepare(base)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(isPreparedCodexProductRun({
    ...result.prepared,
    preparationContract: 'codex_product_run_e1',
    recoveredContextDigest: null,
  }), false)
})

test('Codex product task facts distinguish real Tag Forge execution from advisory skill guidance', () => {
  const skillRoot = join(process.cwd(), 'assets', 'embedded-skills')
  const nativeSkill = (skillId: string, authorizedToolNames?: readonly string[]) => {
    const managedPath = join(skillRoot, skillId)
    const compiled = compileSkillDefinition({ folderPath: managedPath, source: 'embedded' })
    return resolveCodexNativeSkillInput({
      skillId,
      authorizedToolNames,
      skills: [{ ...compiled, installed: true, installStatePath: '', managedPath }],
    })
  }
  const tagForge = nativeSkill('tag-forge')
  const academicPaperReview = nativeSkill('academic-paper-review')
  const letsGoRss = nativeSkill('lets-go-rss')
  const studyNotes = nativeSkill('study-notes')
  const contextCompact = nativeSkill('context-compact', ['skill_compact_context'])
  const obsidianPublicUrl = nativeSkill('obsidian-web-clip', ['web_clip_url'])
  const obsidianCurrentPage = nativeSkill('obsidian-web-clip', [])
  const fastNote = nativeSkill('fastnote', ['skill_write_artifact'])
  const scriptExpert = nativeSkill('script-expert-ready', ['skill_write_artifact'])
  const deepResearch = nativeSkill('deep-research', ['web_search_domains', 'web_search', 'web_fetch'])
  const surfPro = nativeSkill('surf-pro', [
    'web_search_domains',
    'web_search',
    'web_fetch',
    'skill_write_artifact',
  ])
  assert.ok(tagForge)
  assert.ok(academicPaperReview)
  assert.ok(letsGoRss)
  assert.ok(studyNotes)
  assert.ok(contextCompact)
  assert.ok(obsidianPublicUrl)
  assert.ok(obsidianCurrentPage)
  assert.ok(fastNote)
  assert.ok(scriptExpert)
  assert.ok(deepResearch)
  assert.ok(surfPro)
  assert.equal(tagForge.completionProfile, 'transaction_confirmed')
  assert.equal(academicPaperReview.completionProfile, 'advisory')
  assert.equal(letsGoRss.completionProfile, 'tool_result')
  assert.equal(studyNotes.completionProfile, 'tool_result')
  assert.equal(contextCompact.completionProfile, 'tool_result')
  assert.equal(obsidianPublicUrl.completionProfile, 'artifact_delivery')
  assert.equal(obsidianCurrentPage.completionProfile, 'advisory')
  assert.equal(fastNote.completionProfile, 'artifact_delivery')
  assert.equal(scriptExpert.completionProfile, 'artifact_delivery')
  assert.equal(deepResearch.completionProfile, 'research_sources')
  assert.equal(surfPro.completionProfile, 'research_artifact_delivery')
  const selectedSkill = {
    skillAuthorization: {
      mode: 'selected' as const,
      completionProfile: tagForge.completionProfile,
    },
    intentClassification: { primaryDomain: 'general' as const },
    hasFolderExportDestination: false,
  }
  assert.deepEqual(resolveCodexProductTaskFacts(selectedSkill), {
    taskType: 'transaction_task',
    module: 'skill',
  })
  assert.equal(
    createCodexProductBudgetSeed(selectedSkill).maxIterations,
    CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
  )
  const advisorySkill = {
    skillAuthorization: {
      mode: 'selected' as const,
      completionProfile: academicPaperReview.completionProfile,
    },
  }
  assert.deepEqual(resolveCodexProductTaskFacts(advisorySkill), {
    taskType: 'direct_answer',
    module: 'skill',
  })
  assert.equal(
    createCodexProductBudgetSeed(advisorySkill).maxIterations,
    CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
  )
  const hybridExecutableSkill = {
    skillAuthorization: {
      mode: 'selected' as const,
      completionProfile: letsGoRss.completionProfile,
    },
  }
  assert.deepEqual(resolveCodexProductTaskFacts(hybridExecutableSkill), {
    taskType: 'short_task',
    module: 'skill',
  })
  assert.equal(
    createCodexProductBudgetSeed(hybridExecutableSkill).maxIterations,
    CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
  )
  assert.deepEqual(resolveCodexProductTaskFacts({
    skillAuthorization: { mode: 'selected', completionProfile: deepResearch.completionProfile },
  }), { taskType: 'research', module: 'skill' })
  assert.deepEqual(resolveCodexProductTaskFacts({
    skillAuthorization: { mode: 'selected', completionProfile: surfPro.completionProfile },
  }), { taskType: 'research_artifact_task', module: 'skill' })
  assert.deepEqual(resolveCodexProductTaskFacts({
    skillAuthorization: { mode: 'none' },
    intentClassification: { primaryDomain: 'general' as const },
    hasFolderExportDestination: false,
  }), {
    taskType: 'direct_answer',
    module: 'system',
  })

  assert.deepEqual(resolveCodexProductTaskFacts({
    skillAuthorization: { mode: 'none' },
    intentClassification: { primaryDomain: 'research' },
  }), {
    taskType: 'research',
    module: 'browser',
  })
  const browserReadFacts = resolveCodexProductTaskFacts({
    skillAuthorization: { mode: 'none' },
    intentClassification: { primaryDomain: 'browser' },
  })
  assert.deepEqual(browserReadFacts, {
    taskType: 'direct_answer',
    module: 'browser',
  })
  const structuralBrowserFacts = resolveCodexProductTaskFacts({
    skillAuthorization: { mode: 'none' },
    intentClassification: { primaryDomain: 'general' },
    hasBrowserToolSurface: true,
  })
  assert.deepEqual(structuralBrowserFacts, {
    taskType: 'direct_answer',
    module: 'browser',
  })
  assert.deepEqual(createCodexProductBudgetSeed({
    skillAuthorization: { mode: 'none' },
    intentClassification: { primaryDomain: 'general' },
    hasBrowserToolSurface: true,
  }), {
    maxIterations: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL + 1,
    maxToolCalls: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL + 1,
    maxParallelToolGroups: 1,
  })
  assert.deepEqual(resolveCodexBrowserWorkflowTaskFacts(browserReadFacts, false), browserReadFacts)
  assert.deepEqual(resolveCodexBrowserWorkflowTaskFacts(browserReadFacts, true), {
    taskType: 'browser_transaction',
    module: 'browser',
  })
  const folderReadFacts = resolveCodexProductTaskFacts({
    skillAuthorization: { mode: 'none' },
    intentClassification: { primaryDomain: 'general' },
    hasFolderExportDestination: true,
  })
  assert.deepEqual(folderReadFacts, {
    taskType: 'direct_answer',
    module: 'system',
  })
  assert.deepEqual(resolveCodexProductCloseoutTaskFacts(folderReadFacts, { kind: 'no_write' }), folderReadFacts)
  assert.deepEqual(resolveCodexProductCloseoutTaskFacts(folderReadFacts, { kind: 'positive' }), {
    taskType: 'short_task',
    module: 'system',
  })
})

test('production task facts are derived from the frozen final tool authorization', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: this pins the cross-boundary wiring between final tool admission and task closeout facts
  const source = readFileSync(new URL('../main/modules/agent-control/codex-runtime/composition/ingress-prepare.ts', import.meta.url), 'utf8')
  assert.match(source, /const selectedSkill = toolSnapshot\.readyTurnToolAuthorization\.skillAuthorization[\s\S]*?const productTaskInput = \{[\s\S]*?completionProfile: selectedNativeSkill!\.completionProfile,[\s\S]*?hasBrowserToolSurface:[\s\S]*?const productTaskFacts = resolveCodexProductTaskFacts\(productTaskInput\)/)
  assert.doesNotMatch(source, /const productTaskFacts = resolveCodexProductTaskFacts\(\{\s*skillAuthorization: authorization,/)
})

test('product run preparer freezes the conversation authorization mode and old rows default closed', () => {
  const result = preparer.prepare({ ...base, actionAuthorizationMode: 'auto' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.prepared.actionAuthorizationMode, 'auto')
  const { actionAuthorizationMode: _omitted, ...oldPreparedRow } = result.prepared
  assert.equal(isPreparedCodexProductRun(oldPreparedRow), true)
  assert.deepEqual(preparer.prepare({
    ...base,
    actionAuthorizationMode: 'invalid',
  }), { ok: false, code: 'invalid_product_ingress' })
})

test('product run preparer persists the exact browser page identity in the resource anchor', () => {
  const browserPageRef = {
    tabId: 'tab-referenced',
    physicalTargetToken: 'physical-target-1',
    mainFrameId: '0',
    mainFrameDocumentToken: 'document-token-1',
    profileId: 'browser',
  }
  const result = preparer.prepare({ ...base, browserPageRef })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.prepared.browserPageRef, browserPageRef)
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
  assert.equal(isPreparedCodexProductRun({
    ...result.prepared,
    browserPageRef: { ...browserPageRef, tabId: 'tab-swapped' },
  }), false)
})

// B12 (W7 T10) gave the trusted page reference its origin; a browser-mode turn whose page carries it must be admitted,
// not rejected as invalid_product_ingress (every browser turn on a web page was refused before this).
test('product run preparer accepts the trusted browser page reference with its origin', () => {
  const browserPageRef = {
    tabId: 'tab-referenced',
    physicalTargetToken: 'physical-target-1',
    mainFrameId: '0',
    mainFrameDocumentToken: 'document-token-1',
    origin: 'https://example.com',
    profileId: null,
  }
  const result = preparer.prepare({ ...base, browserPageRef })
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) return
  assert.deepEqual(result.prepared.browserPageRef, browserPageRef)
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
  assert.equal(isPreparedCodexProductRun({ ...result.prepared, browserPageRef: { ...browserPageRef, origin: 42 } }), false)
})

test('product run preparer persists exact resource authority with matching refs and an authorized consumer', () => {
  const resourceDigest = 'd'.repeat(64)
  const reference = {
    logicalResourceId: 'local-file:notes',
    currentVersion: `sha256:${resourceDigest}`,
    currentDigest: resourceDigest,
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const authority = {
    kind: 'local_file',
    logicalResourceId: reference.logicalResourceId,
    name: 'notes.txt',
    path: '/canonical/notes.txt',
    currentVersion: reference.currentVersion,
    currentDigest: reference.currentDigest,
    policyEpoch: reference.policyEpoch,
    allowedToolNames: ['file_extract_text', 'file_read_excerpt'],
  }
  const resourceInput = {
    ...base,
    explicitResourceEnvelope: {
      input: [{ type: 'mention', name: 'notes.txt', path: '/canonical/notes.txt' }],
      resourceRefs: [reference],
    },
    resourceAdditionalContext: [reference],
    resourceAuthorities: [authority],
    ...createCodexToolFixture(['file_read_excerpt']),
  }
  const result = preparer.prepare(resourceInput)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.prepared.resourceAuthorities, [authority])
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
  assert.deepEqual(preparer.prepare({
    ...resourceInput,
    resourceAuthorities: [{ ...authority, currentDigest: 'e'.repeat(64) }],
  }), { ok: false, code: 'invalid_product_ingress' })
})

test('product run preparer validates a turn that carries both a file authority and an RSS reference', () => {
  const resourceDigest = 'd'.repeat(64)
  const fileReference = {
    logicalResourceId: 'local-file:notes',
    currentVersion: `sha256:${resourceDigest}`,
    currentDigest: resourceDigest,
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const authority = {
    kind: 'local_file',
    logicalResourceId: fileReference.logicalResourceId,
    name: 'notes.txt',
    path: '/canonical/notes.txt',
    currentVersion: fileReference.currentVersion,
    currentDigest: fileReference.currentDigest,
    policyEpoch: fileReference.policyEpoch,
    allowedToolNames: ['file_extract_text', 'file_read_excerpt'],
  }
  const rssReference = {
    id: '6f1c2c0e-3d3a-4a51-9a51-2a8b9b3f4e10',
    name: '当前筛选',
    reference: { kind: 'article' as const, read: { itemId: 'item-1', expectedRevision: 'revision-1', offset: 0, length: 12000 } },
  }
  const rssVersion = rssResourceVersion(rssReference)
  const result = preparer.prepare({
    ...base,
    explicitResourceEnvelope: {
      input: [{ type: 'mention', name: 'notes.txt', path: '/canonical/notes.txt' }],
      resourceRefs: [fileReference, rssVersion],
    },
    resourceAdditionalContext: [fileReference, rssVersion],
    resourceAuthorities: [authority],
    rssReferences: [rssReference],
    trustedWorkbenchMode: 'rss',
    ...createCodexToolFixture(['file_read_excerpt', ...RSS_READ_TOOL_NAMES]),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  // Prepare and validation must build the anchor digest identically; a restored row must stay valid.
  assert.equal(isPreparedCodexProductRun(JSON.parse(JSON.stringify(result.prepared))), true)
})

test('product run preparer accepts the controlled Tag Forge consumer for a selected folder', () => {
  const resourceDigest = 'f'.repeat(64)
  const reference = {
    logicalResourceId: 'local-directory:notes',
    currentVersion: `sha256:${resourceDigest}`,
    currentDigest: resourceDigest,
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const result = preparer.prepare({
    ...base,
    explicitResourceEnvelope: {
      input: [{ type: 'mention', name: 'notes', path: '/canonical/notes' }],
      resourceRefs: [reference],
    },
    resourceAdditionalContext: [reference],
    resourceAuthorities: [{
      kind: 'local_directory',
      logicalResourceId: reference.logicalResourceId,
      name: 'notes',
      path: '/canonical/notes',
      currentVersion: reference.currentVersion,
      currentDigest: reference.currentDigest,
      policyEpoch: reference.policyEpoch,
      directoryIdentity: { device: '1', inode: '2', mode: 16_896, mtimeMs: 1 },
      allowedToolNames: ['file_inventory'],
    }],
    ...createCodexToolFixture(['tag_forge_prepare_batch']),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
})

test('product run preparer rejects retired background ingress, handoff, workflow child, and unknown extensions', () => {
  assert.deepEqual(preparer.prepare({ ...base, taskOrigin: 'system_background', runOrigin: 'scheduled_task' }), {
    ok: false,
    code: 'invalid_product_ingress',
  })
  assert.deepEqual(preparer.prepare({ ...base, runOrigin: 'handoff_takeover' }), {
    ok: false,
    code: 'unsupported_product_ingress',
  })
  assert.deepEqual(preparer.prepare({ ...base, taskOrigin: 'workflow_child' }), {
    ok: false,
    code: 'unsupported_product_ingress',
  })
  assert.deepEqual(preparer.prepare({ ...base, systemPrompt: 'forbidden' }), {
    ok: false,
    code: 'invalid_product_ingress',
  })
})

test('product run preparer rejects conflicting resource versions before persistence', () => {
  const currentResource = {
    logicalResourceId: 'document-1',
    currentVersion: 'v2',
    currentDigest: 'digest-v2',
    supersedesVersion: 'v1',
    policyEpoch: 2,
  }
  assert.deepEqual(preparer.prepare({
    ...base,
    explicitResourceEnvelope: {
      input: [],
      resourceRefs: [currentResource],
    },
    resourceAdditionalContext: [{
      ...currentResource,
      currentDigest: 'conflicting-digest-v2',
    }],
  }), {
    ok: false,
    code: 'invalid_product_ingress',
  })

  assert.deepEqual(preparer.prepare({
    ...base,
    explicitResourceEnvelope: {
      input: [],
      resourceRefs: [currentResource, {
        ...currentResource,
        currentVersion: 'v3',
        currentDigest: 'digest-v3',
        supersedesVersion: 'v2',
        policyEpoch: 3,
      }],
    },
    resourceAdditionalContext: [currentResource],
  }), {
    ok: false,
    code: 'invalid_product_ingress',
  })
})

test('product run preparer binds a body-free current-document anchor to the exact thin reference', () => {
  const result = preparer.prepare({
    ...base,
    explicitResourceEnvelope: { input: [], resourceRefs: [documentReference] },
    resourceAdditionalContext: [documentReference],
    currentDocumentAnchor: documentAnchor,
  })
  assert.equal(result.ok, true)
  if (!result.ok || result.prepared.ingress.kind !== 'user_ingress') return
  assert.deepEqual(result.prepared.ingress.currentDocumentAnchor, documentAnchor)
  assert.equal(JSON.stringify(result.prepared).includes('RESOURCE_BODY'), false)

  assert.deepEqual(preparer.prepare({
    ...base,
    explicitResourceEnvelope: { input: [], resourceRefs: [] },
    resourceAdditionalContext: [],
    currentDocumentAnchor: documentAnchor,
  }), { ok: false, code: 'invalid_product_ingress' })
})

test('product run preparer persists an external read slice only with its exact resource and tool authority', () => {
  const externalReadSlice = prepareFeishuExternalReadSlice({
    request: {
      kind: 'feishu_typed_read',
      channelId: 'channel-1',
      docToken: 'doc-token',
      docType: 'docx',
      logicalResourceId: 'feishu:doc-token',
      currentVersion: 'v1',
      currentDigest: 'd'.repeat(64),
      policyEpoch: 1,
    },
    sidecarRunning: true,
    channelIdentityDigest: 'b'.repeat(64),
  })
  const reference = externalReadResourceReference(externalReadSlice)
  const externalBase = {
    ...base,
    ...createCodexToolFixture(['feishu_doc_read']),
    explicitResourceEnvelope: { input: [], resourceRefs: [reference] },
    resourceAdditionalContext: [reference],
    externalReadSlice,
  }
  const result = preparer.prepare(externalBase)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.prepared.externalReadSlice, externalReadSlice)
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
  assert.equal(JSON.stringify(result.prepared).includes('accessToken'), false)

  assert.deepEqual(preparer.prepare({
    ...externalBase,
    resourceAdditionalContext: [{ ...reference, currentVersion: 'v2' }],
  }), { ok: false, code: 'invalid_product_ingress' })
  assert.deepEqual(preparer.prepare({
    ...externalBase,
    ...createCodexToolFixture(['ready_read']),
  }), { ok: false, code: 'invalid_product_ingress' })
  assert.deepEqual(preparer.prepare({
    ...externalBase,
    currentDocumentAnchor: documentAnchor,
  }), { ok: false, code: 'invalid_product_ingress' })
})

test('product run preparer rejects authorization outside the frozen thread surface', () => {
  const unsigned = {
    authorizationId: base.readyTurnToolAuthorization.authorizationId,
    allowedToolNames: ['forged_tool'],
    skillAuthorization: base.readyTurnToolAuthorization.skillAuthorization,
  }
  assert.deepEqual(preparer.prepare({
    ...base,
    readyTurnToolAuthorization: {
      ...unsigned,
      authorizationDigest: digestCanonicalJson(unsigned),
    },
  }), { ok: false, code: 'invalid_product_ingress' })
})

test('prepared product run binding rejects every other send identity', () => {
  const result = preparer.prepare(base)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const expected = {
    scopeId: base.scopeId,
    aliasId: base.aliasId,
    aliasGeneration: base.aliasGeneration,
    requestId: base.requestId,
    originUserMessageId: base.originUserMessageId,
    reservationSetId: base.reservationSetId,
    reservationEvidenceDigest: base.reservationEvidenceDigest,
  }
  for (const mismatch of [
    { scopeId: 'scope-other' },
    { aliasId: 'alias-other' },
    { aliasGeneration: 2 },
    { requestId: 'request-other' },
    { originUserMessageId: 'message-other' },
    { reservationSetId: 'reservation-other' },
    { reservationEvidenceDigest: 'reservation-evidence-other' },
  ]) {
    assert.equal(preparedCodexProductRunMatchesIngress(result.prepared, {
      ...expected,
      ...mismatch,
    }), false)
  }
})

test('product run freezes exactly one typed output directory and derives separate delivery lanes', () => {
  const resourceDigest = 'f'.repeat(64)
  const reference = {
    logicalResourceId: 'local-directory:output',
    currentVersion: `sha256:${resourceDigest}`,
    currentDigest: resourceDigest,
    supersedesVersion: null,
    policyEpoch: 1,
  }
  const authority = {
    kind: 'local_directory' as const,
    logicalResourceId: reference.logicalResourceId,
    name: 'output',
    path: '/canonical/output',
    currentVersion: reference.currentVersion,
    currentDigest: reference.currentDigest,
    policyEpoch: 1,
    directoryIdentity: { device: '1', inode: '2', mode: 16877, mtimeMs: 1 },
    allowedToolNames: ['file_inventory' as const],
  }
  const result = preparer.prepare({
    ...base,
    ...createCodexToolFixture(['file_inventory']),
    explicitResourceEnvelope: {
      input: [{ type: 'mention', name: 'output', path: '/canonical/output' }],
      resourceRefs: [reference],
    },
    resourceAdditionalContext: [reference],
    resourceAuthorities: [authority],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.prepared.outputContract?.destination.logicalResourceId, reference.logicalResourceId)
  assert.equal(result.prepared.productBudgetSeed.lanes.delivery.maxIterations, 18)
  assert.equal(result.prepared.productBudgetSeed.lanes.final.maxIterations, 1)

  const secondReference = {
    ...reference,
    logicalResourceId: 'local-directory:other',
    currentDigest: 'e'.repeat(64),
    currentVersion: `sha256:${'e'.repeat(64)}`,
  }
  const ambiguous = preparer.prepare({
    ...base,
    ...createCodexToolFixture(['file_inventory']),
    explicitResourceEnvelope: {
      input: [],
      resourceRefs: [reference, secondReference],
    },
    resourceAdditionalContext: [reference, secondReference],
    resourceAuthorities: [
      authority,
      {
        ...authority,
        logicalResourceId: secondReference.logicalResourceId,
        path: '/canonical/other',
        currentVersion: secondReference.currentVersion,
        currentDigest: secondReference.currentDigest,
        directoryIdentity: { ...authority.directoryIdentity, inode: '3' },
      },
    ],
  })
  assert.equal(ambiguous.ok, true)
  if (!ambiguous.ok) return
  assert.equal(ambiguous.prepared.outputContract, undefined)
  assert.equal(ambiguous.prepared.productBudgetSeed.lanes.delivery.maxIterations, 0)
  assert.deepEqual(effectiveCodexFolderOutputToolNames([
    'ask_user_questions',
    'declare_completion_criteria',
    'skill_write_artifact',
    'skill_export_artifact',
  ], { kind: 'selection_required' }), ['ask_user_questions'])
})

test('explicit retry freezes control, stable root, current seed, and no prior artifacts', () => {
  const taskRootInput = JSON.parse('[{"text":"原始任务","text_elements":[],"type":"text"}]')
  const result = preparer.prepare({
    ...base,
    runId: 'run-retry',
    requestId: 'request-retry',
    originUserMessageId: 'message-retry',
    currentInput: [textUserInput('再试一次')],
    actionAdmissionRef: undefined,
    uncommittedUserTail: [{
      originUserMessageId: 'message-root',
      input: taskRootInput,
      inputDigest: digestCodexUserInput(taskRootInput),
      policy: 'untrusted_text_history' as const,
    }],
    uncommittedTailAssignments: [{
      originUserMessageId: 'message-root',
      inputDigest: digestCodexUserInput(taskRootInput),
      plan: 'replace_with_explicit_retry' as const,
    }],
    explicitRetry: {
      predecessorRunId: 'run-previous',
      predecessorPresentationRef: {
        readyRunId: 'run-previous', presentationDigest: 'e'.repeat(64),
      },
      controlAuditMessageRef: {
        messageId: 'message-retry',
        inputDigest: digestCodexUserInput([textUserInput('再试一次')]),
      },
      modelVisibleRootOriginRef: {
        sourceReadyRunId: 'run-root', sourceIngressContractDigest: 'd'.repeat(64),
        originUserMessageId: 'message-root', inputDigest: digestCodexUserInput(taskRootInput),
      },
      selectedHistorySeedItemRef: {
        threadBindingId: 'binding-child', historySeedDigest: 'c'.repeat(64),
        originUserMessageId: 'message-root', inputDigest: digestCodexUserInput(taskRootInput),
      },
      currentTrustedEnvironmentRef: {
        requestedWorkbenchMode: 'browser', trustedWorkbenchMode: 'browser',
        modeDigest: digestCanonicalJson({
          requestedWorkbenchMode: 'browser', trustedWorkbenchMode: 'browser',
        }),
      },
      sourceTrustedEnvironmentRef: {
        workbenchMode: 'browser', environmentDigest: '9'.repeat(64),
      },
      historyParityEvidenceDigest: 'parity',
      currentThreadReadEvidenceDigest: 'thread-read',
      continuationContractDigest: 'continuation',
      taskRootInput,
      taskRootInputDigest: digestCodexUserInput(taskRootInput),
      artifactSources: [],
    },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.prepared.ingress.attemptKind, 'explicit_retry')
  assert.equal(result.prepared.ingress.predecessorRunId, 'run-previous')
  assert.deepEqual(result.prepared.ingress.taskRootInput, taskRootInput)
  assert.deepEqual(result.prepared.ingress.artifactSources, [])
  assert.equal(result.prepared.ingress.canonicalCurrentInputRef.messageId, 'message-root')
  assert.notEqual(result.prepared.ingress.originUserMessageId, 'message-root')
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
})

test('M7 prepared turns retain and validate exact library grants across serialization', async () => {
  const { libraryResourceVersion, libraryGrantSchema, libraryTools } = await import('../main/modules/agent-control/codex-runtime/library-read-resources')
  const grant = libraryGrantSchema.parse({ selection: { kind: 'board_selection', id: 'selected-board', name: 'Board', libraryId: 'a'.repeat(64), uri: 'ready://canvas/board', version: 'b'.repeat(64), nodeIds: ['one'] }, version: 'b'.repeat(64) })
  const reference = libraryResourceVersion(grant)
  const input = { ...base, libraryResources: [grant], resourceAdditionalContext: [reference], explicitResourceEnvelope: { input: [textUserInput(JSON.stringify({ resource: grant.selection, version: grant.version, readWith: libraryTools(grant.selection) }))], resourceRefs: [reference] }, ...createCodexToolFixture(['library_read_board']) }
  const result = preparer.prepare(input)
  assert.equal(result.ok, true)
  if (!result.ok) assert.fail('prepare failed')
  const restored = JSON.parse(JSON.stringify(result.prepared))
  assert.equal(isPreparedCodexProductRun(restored), true)
  assert.deepEqual(restored.libraryResources, [grant])
  restored.libraryResources[0].selection.nodeIds.push('outside')
  assert.equal(isPreparedCodexProductRun(restored), false)
  assert.equal(preparer.prepare({ ...input, ...createCodexToolFixture(['ask_user_questions']) }).ok, false)
})


test('M7 library preparation failures ask for attachment reselection or a new context, never automatic service retry', async () => {
  const { classifyCodexIngressPreparationError } = await import('../main/modules/agent-control/codex-runtime/codex-ingress-preparation-error')
  const { mapBackendErrorToFriendly } = await import('../renderer/modules/agent/error-message-mapping')
  for (const [message, kind] of [['library_resource_unavailable', 'attachment_unavailable'], ['library_read_tool_surface_missing', 'native_tool_surface_extension_required']]) {
    const result = classifyCodexIngressPreparationError(new Error(message))
    assert.equal(result.code, kind)
    assert.notEqual(mapBackendErrorToFriendly({ errorKind: result.code }).retryStrategy, 'auto')
  }
})
