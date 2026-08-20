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
import { createCodexToolFixture } from './utils/codex-tool-fixture'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  externalReadResourceReference,
  prepareFeishuExternalReadSlice,
} from '../main/modules/agent-control/codex-runtime/codex-external-read-slice'
import { effectiveCodexFolderOutputToolNames } from '../main/modules/agent-control/codex-runtime/codex-folder-output-activation'
import {
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
    40,
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
  assert.equal(createCodexProductBudgetSeed(advisorySkill).maxIterations, 8)
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
  assert.equal(createCodexProductBudgetSeed(hybridExecutableSkill).maxIterations, 40)
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
  const source = readFileSync(new URL('../main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts', import.meta.url), 'utf8')
  assert.match(source, /const selectedSkill = toolSnapshot\.readyTurnToolAuthorization\.skillAuthorization[\s\S]*?const productTaskInput = \{[\s\S]*?completionProfile: selectedNativeSkill!\.completionProfile,[\s\S]*?const productTaskFacts = resolveCodexProductTaskFacts\(productTaskInput\)/)
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

test('explicit retry freezes predecessor evidence and read-only staged sources on a new user run', () => {
  const result = preparer.prepare({
    ...base,
    runId: 'run-retry',
    requestId: 'request-retry',
    originUserMessageId: 'message-retry',
    currentInput: [textUserInput('再试一次')],
    explicitRetry: {
      predecessorRunId: 'run-previous',
      historyParityEvidenceDigest: 'parity',
      currentThreadReadEvidenceDigest: 'thread-read',
      continuationContractDigest: 'continuation',
      artifactSources: [{
        sourceReadyRunId: 'run-previous',
        relativePath: 'report.md',
        logicalArtifactRef: 'artifact:previous',
        version: `sha256:${'a'.repeat(64)}`,
        sha256: 'b'.repeat(64),
        state: 'staged',
      }],
    },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.prepared.ingress.attemptKind, 'explicit_retry')
  assert.equal(result.prepared.ingress.predecessorRunId, 'run-previous')
  assert.equal(result.prepared.ingress.artifactSources?.[0].sourceReadyRunId, 'run-previous')
  assert.equal(isPreparedCodexProductRun(result.prepared), true)
})
