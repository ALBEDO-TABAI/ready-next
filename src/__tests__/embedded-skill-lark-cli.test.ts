import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { buildEmbeddedSkillManifests } from '../main/modules/skills-runtime/manifest'
import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import {
  __setSkillsRuntimeManagerForTests,
  type SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import { CodexHostOrchestrator } from '../main/modules/agent-control/runtime-core/codex-host-orchestrator'
import {
  buildCodexThreadDeveloperInstructions,
  buildCodexProductRequestEnvelope,
  createCodexProductBudgetSeed,
  createCodexProductUpstreamProfileSnapshot,
  readCodexInstructionContractDigest,
  resolveCodexProductTurnAuthorization,
  resolveCodexThreadInstructionContract,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import { instructionTranscriptDigest } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL } from '../main/modules/agent-control/codex-runtime/codex-product-task-facts'
import {
  CODEX_HOST_OVERLAY,
  resolveCodexNativeSkillInput,
  resolveCodexSelectedSkillMethodology,
} from '../main/modules/agent-control/codex-runtime/codex-thread-instructions'
import { resolveReadyToolTurnSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { composeCodexTurnToolSnapshot } from '../main/modules/agent-control/codex-runtime/codex-tool-surface-composition'
import { workbenchTestSnapshot } from './codex-workbench-surface-test-tools'
import { AgentSdkToolExecutor } from '../main/modules/agent-control/runtime-core/agent-sdk-tool-executor'
import { AgentSdkSessionManager } from '../main/modules/agent-control/runtime-core/agent-sdk-session'
import type { SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'
import type { AIModelConfig } from '../shared/ai-providers'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

const ROOT = join(process.cwd(), 'assets', 'embedded-skills')
const SKILL_ROOT = join(ROOT, 'lark-cli')
const BASE_CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

test.before(() => {
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
  })
})
test.after(() => __setScopeContextEpochDatabaseForTests(null))

test('Ready ships one bounded global Lark CLI skill with in-chat authorization guidance', () => {
  const manifests = buildEmbeddedSkillManifests(ROOT)
  const skill = compileSkillDefinition({ folderPath: SKILL_ROOT, source: 'embedded' })
  const document = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')

  assert.ok(manifests.some((entry) => entry.id === 'lark-cli'))
  assert.equal(skill.executionMode, 'advisory')
  assert.deepEqual(skill.requiredBins, ['lark-cli'])
  assert.deepEqual(skill.capabilitySurface, {
    composition: 'additive',
  })
  assert.equal(skill.actions.find((action) => action.name === 'read_skill')?.visibility, 'internal')
  assert.match(document, /lark-cli skills read lark-shared/)
  assert.match(document, /lark-cli auth status --json --verify/)
  assert.match(document, /lark-cli auth login --scope/)
  assert.match(document, /lark-cli auth login --device-code/)
  assert.match(document, /lark-cli auth qrcode .* --ascii/)
  assert.match(document, /lark-cli skills read lark-drive/)
  assert.match(document, /lark-cli skills read lark-doc/)
  assert.match(document, /lark-cli skills read lark-sheets/)
  assert.match(document, /lark-cli skills read lark-calendar/)
  assert.match(document, /lark-cli calendar \+agenda/)
  assert.match(document, /日历只读/)
  assert.match(document, /--as user/)
  assert.match(document, /回读验证/)
  assert.match(document, /--dry-run/)
  assert.match(document, /Ready 的确认卡/)
  assert.match(document, /不要创建、切换、重命名或删除 CLI profile/)
  assert.doesNotMatch(document, /auth-qr\.png|--output/)
})

test('Codex production ingress freezes six controlled retries into the upstream snapshot', () => {
  const snapshot = createCodexProductUpstreamProfileSnapshot({
    profileId: 'production-retry-policy',
    config: BASE_CONFIG,
  })

  assert.equal(snapshot.snapshot.retryPolicy.maxRetries, 6)
})

test('Codex leaves ordinary task duration to Runtime instead of task-shape quotas', () => {
  const executableSkill = {
    mode: 'selected' as const,
    completionProfile: 'tool_result' as const,
  }
  assert.deepEqual(createCodexProductBudgetSeed({
    skillAuthorization: executableSkill,
  }), {
    maxIterations: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxToolCalls: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxParallelToolGroups: 1,
  })
  assert.deepEqual(createCodexProductBudgetSeed({
    skillAuthorization: { mode: 'none' },
  }), {
    maxIterations: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxToolCalls: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxParallelToolGroups: 1,
  })
  assert.deepEqual(createCodexProductBudgetSeed({
    skillAuthorization: { mode: 'none' },
    intentClassification: { primaryDomain: 'browser' },
  }), {
    maxIterations: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL + 1,
    maxToolCalls: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL + 1,
    maxParallelToolGroups: 1,
  })
  assert.deepEqual(createCodexProductBudgetSeed({
    skillAuthorization: { mode: 'none' },
    intentClassification: { primaryDomain: 'research' },
  }), {
    maxIterations: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxToolCalls: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxParallelToolGroups: 1,
  })
  assert.deepEqual(createCodexProductBudgetSeed({
    skillAuthorization: executableSkill,
    intentClassification: { primaryDomain: 'browser' },
  }), {
    maxIterations: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL + 1,
    maxToolCalls: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL + 1,
    maxParallelToolGroups: 1,
  })
  assert.deepEqual(createCodexProductBudgetSeed({
    skillAuthorization: executableSkill,
    intentClassification: { primaryDomain: 'research' },
  }), {
    maxIterations: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxToolCalls: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxParallelToolGroups: 1,
  })
  assert.deepEqual(createCodexProductBudgetSeed({
    skillAuthorization: executableSkill,
  }), {
    maxIterations: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxToolCalls: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxParallelToolGroups: 1,
  })
  assert.deepEqual(createCodexProductBudgetSeed({
    skillAuthorization: { mode: 'none' },
    hasFolderExportDestination: true,
  }), {
    maxIterations: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxToolCalls: CODEX_RUNTIME_MANAGED_COUNTER_SENTINEL,
    maxParallelToolGroups: 1,
  })
})

test('Codex keeps thread instructions stable and sends the selected Lark CLI as native skill input', () => {
  const compiled = compileSkillDefinition({ folderPath: SKILL_ROOT, source: 'embedded' })
  const methodology = resolveCodexSelectedSkillMethodology({
    skillId: 'lark-cli',
    skills: [{
      ...compiled,
      installed: true,
      installStatePath: '',
      managedPath: SKILL_ROOT,
    }],
  })
  assert.ok(methodology)
  const developerInstructions = buildCodexThreadDeveloperInstructions(methodology)
  assert.equal(developerInstructions, CODEX_HOST_OVERLAY)
  assert.doesNotMatch(developerInstructions, /<external_ready_resources>/)
  assert.deepEqual(resolveCodexNativeSkillInput({
    skillId: 'lark-cli',
    skills: [{
      ...compiled,
      installed: true,
      installStatePath: '',
      managedPath: SKILL_ROOT,
    }],
  }), {
    skillId: 'lark-cli',
    name: 'Lark CLI',
    path: SKILL_ROOT,
    completionProfile: 'tool_result',
  })

  const assetRoot = join(process.cwd(), 'assets', 'codex-runtime')
  const fixture = JSON.parse(readFileSync(
    join(assetRoot, 'fixtures', 'native-protocol-capture.json'),
    'utf8',
  )) as { provider: { requests: Array<{ request: { instructions: unknown } }> } }
  assert.equal(
    readCodexInstructionContractDigest(assetRoot, developerInstructions),
    instructionTranscriptDigest(fixture.provider.requests[0].request.instructions, [{
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: developerInstructions }],
    }]),
  )
  assert.equal(
    readCodexInstructionContractDigest(assetRoot),
    readCodexInstructionContractDigest(assetRoot, developerInstructions),
  )
  const contract = resolveCodexThreadInstructionContract({
    assetRoot,
    host: { resolveSelectedSkillMethodology: () => methodology },
    skillAuthorization: { mode: 'selected', skillId: 'lark-cli' },
  })
  assert.equal(contract.developerInstructions, developerInstructions)
  assert.equal(
    contract.instructionContractDigest,
    readCodexInstructionContractDigest(assetRoot, developerInstructions),
  )
  assert.equal(resolveCodexThreadInstructionContract({
    assetRoot,
    host: null,
    skillAuthorization: { mode: 'selected', skillId: 'lark-cli' },
  }).developerInstructions, CODEX_HOST_OVERLAY)
  assert.equal(buildCodexThreadDeveloperInstructions(null), CODEX_HOST_OVERLAY)
  assert.throws(
    () => resolveCodexSelectedSkillMethodology({ skillId: 'missing', skills: [] }),
    /codex_selected_skill_unavailable/,
  )
})

test('Codex production ingress keeps Feishu wording as a candidate method, not a code-selected exclusive skill', () => {
  const compiled = compileSkillDefinition({ folderPath: SKILL_ROOT, source: 'embedded' })
  const installedSkill = {
    ...compiled,
    installed: true,
    installStatePath: '',
    managedPath: SKILL_ROOT,
  }
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [installedSkill],
  } as unknown as SkillsRuntimeManager)
  try {
    const host = new CodexHostOrchestrator({})
    const message = '用飞书 cli 读一下我名为 测试 0807 的文档，随便新增一列内容并填写一些内容，然后再在我的 第二季度工作总结 文档里润色一下'
    const request: SendScopedRequest = {
      scopeId: 'codex-lark-cli-real-task',
      requestId: 'request-codex-lark-cli-real-task',
      message,
      userMessage: {
        id: 'message-codex-lark-cli-real-task',
        content: message,
        timestamp: '2026-08-09T00:00:00.000Z',
        meta: { actionAuthorizationMode: 'full' },
        attachmentConfirmation: {
          selectedCount: 0,
          metadataCount: 0,
          inputIncludedCount: 0,
          inputFailedCount: 0,
        },
      },
    }
    const productHost = {
      getScope: () => ({
        id: request.scopeId,
        aliasGeneration: 0,
        messageVisibilityEpoch: 0,
        agent: 'butler',
        activeAgentId: 'butler',
        handoffGeneration: 0,
        title: 'Local',
        sourceKind: 'local' as const,
        sourceId: 'app',
        threadKey: request.scopeId,
        meta: { actionAuthorizationMode: 'auto' },
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      }),
      resolveSkillAuthorizationForTurn: (
        input: Parameters<CodexHostOrchestrator['resolveSkillAuthorizationForTurn']>[0],
      ) => host.resolveSkillAuthorizationForTurn(input),
    }
    const { authorization, requestEnvelope } = resolveCodexProductTurnAuthorization({
      mode: 'commit',
      host: productHost,
      request,
      scopeId: request.scopeId,
      externalReadSlice: null,
    })
    assert.equal(requestEnvelope.actionAuthorizationMode, 'auto')
    assert.equal(requestEnvelope.rawUserText, message)
    assert.equal(requestEnvelope.pureUserText, message)
    assert.equal(requestEnvelope.primaryInstruction, message)
    assert.deepEqual(requestEnvelope.resources, [])
    assert.deepEqual(requestEnvelope.referencedResources, [])
    assert.deepEqual(requestEnvelope.environmentHints, {
      hasAttachments: false,
      hasBootstrapContext: false,
      hasDocumentContext: false,
      hasWidgetTargetContext: false,
    })
    const remoteEnvelope = resolveCodexProductTurnAuthorization({
      mode: 'commit',
      host: {
        ...productHost,
        getScope: () => ({
          ...productHost.getScope(),
          sourceKind: 'channel' as const,
          meta: { actionAuthorizationMode: 'full' },
        }),
      },
      request,
      scopeId: request.scopeId,
      externalReadSlice: null,
    }).requestEnvelope
    assert.equal(remoteEnvelope.actionAuthorizationMode, 'ask')
    assert.equal(remoteEnvelope.primaryInstruction, message)
    assert.equal(authorization.mode, 'none')
    if (authorization.mode !== 'none') return
    assert.equal(authorization.candidateSkillPrimitives?.skillId, 'lark-cli')
    assert.deepEqual(
      [...(authorization.candidateSkillPrimitives?.primitives || [])].sort(),
      ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
    )
    const instructionContract = resolveCodexThreadInstructionContract({
      assetRoot: join(process.cwd(), 'assets', 'codex-runtime'),
      host: {
        resolveSelectedSkillMethodology: (skillId) => resolveCodexSelectedSkillMethodology({
          skillId,
          skills: [installedSkill],
        }),
      },
      skillAuthorization: authorization,
    })
    assert.equal(instructionContract.developerInstructions, CODEX_HOST_OVERLAY)
    assert.match(instructionContract.instructionContractDigest, /^[a-f0-9]{64}$/)

    const followupMessage = '好，继续，先读取第二季度工作总结再润色'
    const followupRequest: SendScopedRequest = {
      ...request,
      requestId: 'request-codex-lark-cli-followup',
      message: followupMessage,
      userMessage: {
        ...request.userMessage,
        id: 'message-codex-lark-cli-followup',
        content: followupMessage,
      },
    }
    const followup = resolveCodexProductTurnAuthorization({
      mode: 'commit',
      host: productHost,
      request: followupRequest,
      scopeId: request.scopeId,
      externalReadSlice: null,
    }).authorization
    assert.equal(followup.mode, 'none')
    if (followup.mode !== 'none') return
    assert.equal(followup.candidateSkillPrimitives?.skillId, 'lark-cli')
    assert.deepEqual(
      [...(followup.candidateSkillPrimitives?.primitives || [])].sort(),
      ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
    )

    const source = new AgentSdkToolExecutor({
      executeToolCall: async () => { throw new Error('not_executed') },
      sessionManager: new AgentSdkSessionManager(),
      browserController: {} as never,
      sidecarManager: null,
      runtime: null,
      runCleanupRegistry: null,
      async compactCapturedSession() { throw new Error('not_executed') },
      async resolveMapPlaceAmbiguityIfNeeded() { return false },
    })
    const firstSnapshot = resolveReadyToolTurnSnapshot({
      surfaceId: 'codex-lark-cli-surface',
      authorizationId: 'codex-lark-cli-auth-first',
      authorization,
      source,
      resolutionInput: {
        message,
        sessionId: request.scopeId,
        scopeId: request.scopeId,
        config: BASE_CONFIG,
        browserHostAvailable: true,
        feishuConnected: true,
        channelScopeBound: false,
        authorization,
        requestEnvelope,
        skillCatalogAvailable: true,
      },
    })
    assert.equal(
      firstSnapshot.readyTurnToolAuthorization.allowedToolNames.includes('use_browser'),
      false,
    )
    assert.deepEqual(
      firstSnapshot.readyTurnToolAuthorization.allowedToolNames
        .filter((name) => name.startsWith('skill_'))
        .sort(),
      ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
    )
    assert.equal(
      source.listDefaultToolDefinitionsForTurn({
        message,
        sessionId: request.scopeId,
        scopeId: request.scopeId,
        config: BASE_CONFIG,
        browserHostAvailable: true,
        feishuConnected: true,
        channelScopeBound: false,
        authorization,
        requestEnvelope,
        skillCatalogAvailable: true,
      }).filter((definition) => definition.domain === 'skill')
        .every((definition) => definition.codexExecutionSafe === true),
      true,
    )
    const followupSnapshot = resolveReadyToolTurnSnapshot({
      surfaceId: 'ignored-after-freeze',
      authorizationId: 'codex-lark-cli-auth-followup',
      authorization: followup,
      source,
      frozenToolSurface: firstSnapshot.readyToolSurface,
      resolutionInput: {
        message: followupMessage,
        sessionId: request.scopeId,
        scopeId: request.scopeId,
        config: BASE_CONFIG,
        browserHostAvailable: true,
        feishuConnected: true,
        channelScopeBound: false,
        authorization: followup,
        requestEnvelope: buildCodexProductRequestEnvelope(followupRequest, 'auto'),
        skillCatalogAvailable: true,
      },
    })
    assert.equal(followupSnapshot.readyToolSurface, firstSnapshot.readyToolSurface)
    assert.deepEqual(
      followupSnapshot.readyTurnToolAuthorization.allowedToolNames
        .filter((name) => name.startsWith('skill_'))
        .sort(),
      ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
    )
    assert.ok(followupSnapshot.readyTurnToolAuthorization.allowedToolNames.includes('ask_user_questions'))

    const localUploadMessage = '好，继续，把这个本地附件上传到云盘'
    const localUploadRequest: SendScopedRequest = {
      ...request,
      requestId: 'request-codex-lark-cli-local-upload',
      message: localUploadMessage,
      userMessage: {
        ...request.userMessage,
        id: 'message-codex-lark-cli-local-upload',
        content: localUploadMessage,
      },
    }
    const localUpload = resolveCodexProductTurnAuthorization({
      mode: 'commit',
      host: productHost,
      request: localUploadRequest,
      scopeId: request.scopeId,
      externalReadSlice: null,
    }).authorization
    assert.equal(localUpload.mode, 'none')
  } finally {
    __setSkillsRuntimeManagerForTests(null)
  }
})

test('Codex keeps Ready local calendar and Feishu CLI primitives together for a Feishu-worded calendar request', () => {
  const compiled = compileSkillDefinition({ folderPath: SKILL_ROOT, source: 'embedded' })
  const installedSkill = {
    ...compiled,
    installed: true,
    installStatePath: '',
    managedPath: SKILL_ROOT,
  }
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [installedSkill],
  } as unknown as SkillsRuntimeManager)
  try {
    const host = new CodexHostOrchestrator({})
    const message = '用飞书 cli 查一下我这周还有哪些安排'
    const request: SendScopedRequest = {
      scopeId: 'codex-lark-cli-calendar',
      requestId: 'request-codex-lark-cli-calendar',
      message,
      userMessage: {
        id: 'message-codex-lark-cli-calendar',
        content: message,
        timestamp: '2026-08-13T00:00:00.000Z',
        attachmentConfirmation: {
          selectedCount: 0,
          metadataCount: 0,
          inputIncludedCount: 0,
          inputFailedCount: 0,
        },
      },
    }
    const productHost = {
      getScope: () => ({
        id: request.scopeId,
        aliasGeneration: 0,
        messageVisibilityEpoch: 0,
        agent: 'butler',
        activeAgentId: 'butler',
        handoffGeneration: 0,
        title: 'Local',
        sourceKind: 'local' as const,
        sourceId: 'app',
        threadKey: request.scopeId,
        meta: { actionAuthorizationMode: 'auto' },
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
      }),
      resolveSkillAuthorizationForTurn: (
        input: Parameters<CodexHostOrchestrator['resolveSkillAuthorizationForTurn']>[0],
      ) => host.resolveSkillAuthorizationForTurn(input),
    }
    const resolved = resolveCodexProductTurnAuthorization({
      mode: 'commit',
      host: productHost,
      request,
      scopeId: request.scopeId,
      externalReadSlice: null,
    })
    assert.equal(resolved.authorization.mode, 'none')
    if (resolved.authorization.mode !== 'none') return
    assert.equal(resolved.authorization.candidateSkillPrimitives?.skillId, 'lark-cli')

    const source = new AgentSdkToolExecutor({
      executeToolCall: async () => { throw new Error('not_executed') },
      sessionManager: new AgentSdkSessionManager(),
      browserController: {} as never,
      sidecarManager: null,
      runtime: null,
      runCleanupRegistry: null,
      async compactCapturedSession() { throw new Error('not_executed') },
      async resolveMapPlaceAmbiguityIfNeeded() { return false },
    })
    const requestEnvelope = {
      ...resolved.requestEnvelope,
      environmentHints: {
        ...resolved.requestEnvelope.environmentHints,
        workbenchMode: 'browser',
        browserPageRef: {
          tabId: 'tab-calendar',
          physicalTargetToken: 'physical-calendar',
          mainFrameDocumentToken: 'document-calendar',
        },
      },
    }
    const snapshot = resolveReadyToolTurnSnapshot({
      surfaceId: 'codex-lark-cli-calendar-surface',
      authorizationId: 'codex-lark-cli-calendar-authorization',
      authorization: resolved.authorization,
      source,
      resolutionInput: {
        message,
        sessionId: request.scopeId,
        scopeId: request.scopeId,
        config: BASE_CONFIG,
        browserHostAvailable: true,
        feishuConnected: true,
        channelScopeBound: false,
        authorization: resolved.authorization,
        skillSurfaceComposition: installedSkill.capabilitySurface?.composition,
        requestEnvelope,
        skillCatalogAvailable: true,
      },
    })
    assert.deepEqual(
      snapshot.readyTurnToolAuthorization.allowedToolNames
        .filter((name) => name.startsWith('skill_'))
        .sort(),
      ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
    )
    const composed = composeCodexTurnToolSnapshot({
      resolved: workbenchTestSnapshot([
        'document_read_section',
        'calendar_list_window',
        'calendar_create_event',
        'skill_run_shell',
        'skill_read_artifact',
        'skill_ask_user',
        'ask_user_questions',
        'web_search',
        'browser_read',
      ], ['document_read_section']),
      authorizationId: 'codex-lark-cli-calendar-compose',
      authorization: resolved.authorization,
      workbenchMode: 'calendar',
    })
    const names = composed.readyTurnToolAuthorization.allowedToolNames
    assert.ok(names.includes('calendar_list_window'))
    assert.ok(names.includes('skill_run_shell'))
    assert.ok(names.includes('ask_user_questions'))
    assert.ok(names.includes('web_search'))
    assert.equal(composed.readyTurnToolAuthorization.skillAuthorization.mode, 'none')
  } finally {
    __setSkillsRuntimeManagerForTests(null)
  }
})

test('exact Lark CLI name still selects the skill and keeps Ready local calendar additive', () => {
  const compiled = compileSkillDefinition({ folderPath: SKILL_ROOT, source: 'embedded' })
  const installedSkill = {
    ...compiled,
    installed: true,
    installStatePath: '',
    managedPath: SKILL_ROOT,
  }
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [installedSkill],
  } as unknown as SkillsRuntimeManager)
  try {
    const host = new CodexHostOrchestrator({})
    const message = '用 Lark CLI 查一下我这周还有哪些安排'
    const request: SendScopedRequest = {
      scopeId: 'codex-lark-cli-exact-name',
      requestId: 'request-codex-lark-cli-exact-name',
      message,
      userMessage: {
        id: 'message-codex-lark-cli-exact-name',
        content: message,
        timestamp: '2026-08-13T00:00:00.000Z',
        attachmentConfirmation: {
          selectedCount: 0,
          metadataCount: 0,
          inputIncludedCount: 0,
          inputFailedCount: 0,
        },
      },
    }
    const productHost = {
      getScope: () => ({
        id: request.scopeId,
        aliasGeneration: 0,
        messageVisibilityEpoch: 0,
        agent: 'butler',
        activeAgentId: 'butler',
        handoffGeneration: 0,
        title: 'Local',
        sourceKind: 'local' as const,
        sourceId: 'app',
        threadKey: request.scopeId,
        meta: { actionAuthorizationMode: 'auto' },
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
      }),
      resolveSkillAuthorizationForTurn: (
        input: Parameters<CodexHostOrchestrator['resolveSkillAuthorizationForTurn']>[0],
      ) => host.resolveSkillAuthorizationForTurn(input),
    }
    const resolved = resolveCodexProductTurnAuthorization({
      mode: 'commit',
      host: productHost,
      request,
      scopeId: request.scopeId,
      externalReadSlice: null,
    })
    assert.equal(resolved.authorization.mode, 'selected')
    if (resolved.authorization.mode !== 'selected') return
    assert.equal(resolved.authorization.skillId, 'lark-cli')
    const composed = composeCodexTurnToolSnapshot({
      resolved: workbenchTestSnapshot([
        'calendar_list_window',
        'calendar_create_event',
        'skill_run_shell',
        'skill_read_artifact',
        'skill_ask_user',
        'ask_user_questions',
        'web_search',
      ], [
        'calendar_list_window',
        'skill_run_shell',
        'skill_read_artifact',
        'skill_ask_user',
        'ask_user_questions',
        'web_search',
      ]),
      authorizationId: 'codex-lark-cli-exact-compose',
      authorization: resolved.authorization,
      workbenchMode: 'calendar',
    })
    const names = composed.readyTurnToolAuthorization.allowedToolNames
    assert.ok(names.includes('calendar_list_window'))
    assert.ok(names.includes('skill_run_shell'))
    assert.ok(names.includes('ask_user_questions'))
    assert.ok(names.includes('web_search'))
  } finally {
    __setSkillsRuntimeManagerForTests(null)
  }
})
