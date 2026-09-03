const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const {
  assetRoot,
  auditRoot,
  digestFile,
  readJson,
  repoRoot,
  sha256
} = require('./contract-lib.cjs')
const {
  dynamicCallBinding,
  dynamicPublicationBinding,
  hardIsolationBinding,
  recomputeMcpBindings,
  resourceReferenceBindings,
  rootVisibilityBinding,
  sameJson,
  validDenial
} = require('./e0r-evidence-bindings.cjs')

const fixturePath = path.join(assetRoot, 'fixtures/e0r-resource-authority-capture.json')
const contractPath = path.join(assetRoot, 'contracts/e0r-resource-authority-contract.json')
const runtimeManifestPath = path.join(assetRoot, 'runtime-manifest.json')
const oldReportPath = path.join(
  auditRoot,
  '2026-08-06-codex-runtime-e0-failure-report.json'
)
const reviewPath = path.join(
  auditRoot,
  '2026-08-06-codex-runtime-e0r-independent-review.json'
)
const reportJsonPath = path.join(
  auditRoot,
  '2026-08-06-codex-runtime-e0r-report.json'
)
const reportMarkdownPath = path.join(
  auditRoot,
  '2026-08-06-codex-runtime-e0r-report.md'
)

const V1_BODY = 'E0R_RESOURCE_V1_BODY: policy says ALPHA only.'
const V2_BODY = 'E0R_RESOURCE_V2_BODY: policy says BETA only.'
const PRODUCT_ROOTS = ['src/main/', 'src/preload/', 'src/renderer/', 'src/shared/']
const NO_HISTORY_CHILD_TOOL_SURFACE = [
  [null, 'list_mcp_resources'],
  [null, 'list_mcp_resource_templates'],
  [null, 'read_mcp_resource'],
  ['collaboration', 'followup_task'],
  ['collaboration', 'interrupt_agent'],
  ['collaboration', 'list_agents'],
  ['collaboration', 'send_message'],
  ['collaboration', 'spawn_agent'],
  ['collaboration', 'wait_agent'],
  ['mcp__ready_resource', 'read_current_resource']
]
const REVIEWED_FILES = {
  plan: 'docs/superpowers/plans/2026-08-06-cod-ready-codex-runtime-minimal-replacement-experiment.md',
  runner: 'scripts/codex-runtime/run-e0r-resource-authority.cjs',
  harness: 'scripts/codex-runtime/e0r-harness-lib.cjs',
  bindingChecker: 'scripts/codex-runtime/e0r-evidence-bindings.cjs',
  mcpServer: 'scripts/codex-runtime/e0r-mcp-resource-server.cjs',
  checker: 'scripts/codex-runtime/check-e0r-resource-authority.cjs',
  tests: 'scripts/__tests__/codex-runtime-e0r-contracts.test.cjs'
}

function unique(values) {
  return [...new Set(values)]
}

function changedPaths() {
  const commands = [
    ['diff', '--name-only'],
    ['diff', '--cached', '--name-only'],
    ['ls-files', '--others', '--exclude-standard']
  ]
  return unique(
    commands.flatMap((args) =>
      execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    )
  ).sort()
}

function reviewedFileDigests() {
  return Object.fromEntries(
    Object.entries(REVIEWED_FILES).map(([name, relativePath]) => [
      name,
      digestFile(path.join(repoRoot, relativePath))
    ])
  )
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  )
}

function canonicalToolSurface(surface) {
  return surface
    .map((tool) => [tool.namespace ?? null, tool.name])
    .sort(([leftNamespace, leftName], [rightNamespace, rightName]) =>
      `${leftNamespace || ''}:${leftName}`.localeCompare(
        `${rightNamespace || ''}:${rightName}`
      )
    )
}

function makeGate(id, title, passed, evidence, failure) {
  return {
    id,
    title,
    required: true,
    status: passed ? 'PASS' : 'FAIL',
    evidence,
    failure: passed ? null : failure
  }
}

function evaluateE0rEvidence({ fixture, contract, runtimeManifest, oldReport, paths, review }) {
  const resultsByCase = Object.fromEntries(
    fixture.turnResults.map((result) => [result.caseId, result])
  )
  const dynamicAudit = fixture.authority.dynamicAudit
  const errorCode = contract.authority.staleRead.errorCode
  const rootThreadId = fixture.agents.root.threadId
  const noHistoryThreadId = fixture.agents.noHistoryChild.threadId
  const historyThreadId = fixture.agents.historyChild.threadId
  const currentReceipts = fixture.authority.receipts.filter(
    (receipt) =>
      receipt.version === 'v2' &&
      receipt.digest === fixture.authority.final.currentDigest &&
      receipt.policyEpoch === fixture.authority.final.policyEpoch &&
      receipt.resultDigest === fixture.authority.final.currentDigest
  )
  const currentDynamicReads = dynamicAudit.filter(
    (entry) => entry.kind === 'current_read' && entry.receipt?.version === 'v2'
  )
  const requiredReceiptFields = contract.authority.currentReadReceiptFields
  const thinReferenceDispatches = fixture.dispatches.filter(
    (dispatch) => dispatch.caseId !== 'E0R_CASE_AUTO_SEED'
  )
  const parsedReferences = thinReferenceDispatches.map((dispatch) => {
    const entry = dispatch.additionalContext?.ready_resource_ref
    let parsed = null
    try {
      parsed = JSON.parse(entry?.value || '')
    } catch {}
    return { dispatch, entry, parsed }
  })
  const requiredCurrentCases = [
    'E0R_CASE_ROOT_V2',
    'E0R_CASE_RESUME_V2',
    'E0R_CASE_MANUAL_V2',
    'E0R_CASE_AUTOMATIC_V2',
    'E0R_CASE_RESTART_V2',
    'E0R_CASE_HARD_NEW_V2'
  ]
  const requiredUniqueResultCases = [
    'E0R_CASE_ROOT_V1',
    'E0R_CASE_ROOT_V2',
    'E0R_CASE_RESUME_V2',
    'E0R_CASE_MANUAL_V2',
    'E0R_CASE_AUTOMATIC_V2',
    'E0R_CASE_RESTART_V2',
    'E0R_CASE_MISSING_RECEIPT',
    'E0R_CASE_HARD_OLD_V1',
    'E0R_CASE_HARD_NEW_V2',
    'E0R_CHILD_NONE_NATIVE',
    'E0R_CHILD_ALL_NATIVE'
  ]
  const turnResultsUnique = requiredUniqueResultCases.every(
    (caseId) => fixture.turnResults.filter((entry) => entry.caseId === caseId).length === 1
  )
  const referenceBindings = resourceReferenceBindings(
    fixture,
    parsedReferences,
    resultsByCase
  )
  const dynamicPublicationBindings = Object.fromEntries(
    requiredCurrentCases.map((caseId) => [
      caseId,
      dynamicPublicationBinding({
        fixture,
        result: resultsByCase[caseId],
        marker: caseId,
        publication: fixture.publicationDecisions[caseId],
        requiredReceiptFields
      })
    ])
  )
  dynamicPublicationBindings.E0R_CHILD_ALL_NATIVE = dynamicPublicationBinding({
    fixture,
    result: resultsByCase.E0R_CHILD_ALL_NATIVE,
    marker: 'E0R_CHILD_ALL_TASK',
    publication: fixture.agents.historyChild.publication,
    requiredReceiptFields
  })
  const rootStaleReadBinding = dynamicCallBinding({
    fixture,
    result: resultsByCase.E0R_CASE_ROOT_V2,
    marker: 'E0R_CASE_ROOT_V2',
    kind: 'stale_read_denied',
    tool: 'ready_resource_read',
    version: 'v1'
  })
  const historyStaleReadBinding = dynamicCallBinding({
    fixture,
    result: resultsByCase.E0R_CHILD_ALL_NATIVE,
    marker: 'E0R_CHILD_ALL_TASK',
    kind: 'stale_read_denied',
    tool: 'ready_resource_read',
    version: 'v1'
  })
  const rootStaleWriteBinding = dynamicCallBinding({
    fixture,
    result: resultsByCase.E0R_CASE_ROOT_V2,
    marker: 'E0R_CASE_ROOT_V2',
    kind: 'stale_write_denied',
    tool: 'ready_resource_write_probe',
    version: 'v1'
  })
  const historyStaleWriteBinding = dynamicCallBinding({
    fixture,
    result: resultsByCase.E0R_CHILD_ALL_NATIVE,
    marker: 'E0R_CHILD_ALL_TASK',
    kind: 'stale_write_denied',
    tool: 'ready_resource_write_probe',
    version: 'v1'
  })
  const staleWrites = dynamicAudit.filter((entry) => entry.kind === 'stale_write_denied')
  const mcpReconciliation = recomputeMcpBindings(
    fixture,
    resultsByCase.E0R_CHILD_NONE_NATIVE
  )
  const currentMcpBinding = mcpReconciliation.bindings.find(
    (binding) => binding.kind === 'current_read'
  )
  const staleMcpBinding = mcpReconciliation.bindings.find(
    (binding) => binding.kind === 'stale_read_denied'
  )
  const productChanges = paths.filter((changedPath) =>
    PRODUCT_ROOTS.some((root) => changedPath.startsWith(root))
  )
  const mcpNames = unique(
    fixture.provider.captures.flatMap((capture) =>
      capture.summary.toolSurface
        .filter((tool) => tool.namespace === 'mcp__ready_resource')
      .map((tool) => tool.name)
    )
  )
  const noHistoryCaptures = fixture.provider.captures.filter((capture) =>
    capture.marker.startsWith('E0R_CHILD_NONE_TASK')
  )
  const expectedNoHistorySurface = canonicalToolSurface(
    NO_HISTORY_CHILD_TOOL_SURFACE.map(([namespace, name]) => ({ namespace, name }))
  )
  const expectedChildReference = {
    logicalResourceId: fixture.authority.final.logicalResourceId,
    currentVersion: fixture.authority.final.currentVersion,
    currentDigest: fixture.authority.final.currentDigest,
    supersedesVersion: 'v1',
    policyEpoch: fixture.authority.final.policyEpoch
  }
  const historyCaptures = fixture.provider.captures.filter((capture) =>
    capture.marker.startsWith('E0R_CHILD_ALL_TASK')
  )
  const rootV2Captures = fixture.provider.captures.filter(
    (capture) => capture.marker === 'E0R_CASE_ROOT_V2'
  )
  const rootVisibility = rootVisibilityBinding(
    fixture,
    resultsByCase.E0R_CASE_ROOT_V2,
    dynamicPublicationBindings.E0R_CASE_ROOT_V2.receipt
  )
  const hardIsolation = hardIsolationBinding(
    fixture,
    resultsByCase,
    dynamicPublicationBindings.E0R_CASE_HARD_NEW_V2.valid
  )
  const expectedCurrentReceiptIds = [
    ...Object.values(dynamicPublicationBindings).map(
      (binding) => binding.receipt?.receiptId
    ),
    currentMcpBinding?.receipt?.receiptId
  ]
  const manual = fixture.continuity.manualCompaction
  const manualProviderRequest = manual.providerRequests?.[0]
  const manualRawProviderRequest = fixture.provider.captures.find(
    (capture) => capture.sequence === manualProviderRequest?.sequence
  )
  const manualNormalRequests = fixture.provider.captures.filter(
    (capture) => capture.marker === 'E0R_CASE_MANUAL_V2'
  )
  const automatic = fixture.continuity.automaticCompaction
  const automaticProviderRequest = automatic.providerRequests?.[0]
  const automaticTurnResult = resultsByCase.E0R_CASE_AUTOMATIC_V2
  const automaticRawProviderRequest = fixture.provider.captures.find(
    (capture) => capture.sequence === automaticProviderRequest?.sequence
  )
  const automaticNormalRequests = fixture.provider.captures.filter(
    (capture) => capture.marker === 'E0R_CASE_AUTOMATIC_V2'
  )

  const gates = []
  gates.push(
    makeGate(
      'pinned_runtime',
      '固定 Codex 运行时',
      fixture.runtime.releaseTag === runtimeManifest.releaseTag &&
        fixture.runtime.gitCommit === runtimeManifest.gitCommit &&
        fixture.runtime.codexVersion === contract.pinnedCodexVersion &&
        fixture.runtime.binarySha256 === runtimeManifest.binarySha256 &&
        fixture.runtime.targetTriple === runtimeManifest.targetTriple &&
        fixture.contract.sha256 === sha256(JSON.stringify(contract)),
      fixture.runtime,
      '真实捕获与固定运行时清单不一致'
    )
  )
  gates.push(
    makeGate(
      'immutable_e0_failure',
      '原 E0 失败证据保持不变',
      oldReport.verdict.status === 'FAIL' &&
        oldReport.verdict.failureCode === contract.baseE0Failure.failureCode &&
        oldReport.verdict.nextPhaseAllowed === false &&
        fixture.contract.immutableE0ReportSha256Before === digestFile(oldReportPath) &&
        fixture.contract.immutableE0ReportSha256After === digestFile(oldReportPath),
      {
        digest: digestFile(oldReportPath),
        failureCode: oldReport.verdict.failureCode
      },
      '原 E0 失败报告被覆盖或不再可验证'
    )
  )
  gates.push(
    makeGate(
      'experiment_scope',
      'E0-R 实验边界',
      fixture.experimentBoundary.productCodeChangesAllowed === false &&
        fixture.experimentBoundary.costBearingExternalCalls === 0 &&
        fixture.experimentBoundary.providerEndpointIsLoopback === true &&
        fixture.experimentBoundary.compactPromptOverrideCount === 0 &&
        productChanges.length === 0,
      {
        productChanges,
        costBearingExternalCalls: fixture.experimentBoundary.costBearingExternalCalls,
        providerEndpointIsLoopback: fixture.experimentBoundary.providerEndpointIsLoopback,
        compactPromptOverrideCount:
          fixture.experimentBoundary.compactPromptOverrideCount
      },
      '实验越过了产品代码、外部调用、本地 Provider 或原生压缩提示边界'
    )
  )
  gates.push(
    makeGate(
      'thin_non_semantic_references',
      'additionalContext 只含薄引用',
      parsedReferences.length > 0 &&
        parsedReferences.every(({ dispatch, entry, parsed }) => {
          const serialized = JSON.stringify(dispatch.additionalContext)
          return (
            exactKeys(dispatch.additionalContext, ['ready_resource_ref']) &&
            entry?.kind === 'application' &&
            exactKeys(parsed, contract.resourceReference.additionalContextFields) &&
            !serialized.includes(V1_BODY) &&
            !serialized.includes(V2_BODY) &&
            !/(policy says|ALPHA|BETA|credential|capabilityToken|summary)/i.test(serialized)
          )
        }) &&
        referenceBindings.every((binding) => binding.valid === true),
      {
        dispatchCount: parsedReferences.length,
        fields: contract.resourceReference.additionalContextFields,
        referenceBindings
      },
      '发现资源正文、语义事实、凭据或引用字段漂移'
    )
  )
  gates.push(
    makeGate(
      'v1_visible_v2_authoritative',
      'V1 可见但 V2 候选唯一权威',
      resultsByCase.E0R_CASE_ROOT_V1?.finalText === V1_BODY &&
        resultsByCase.E0R_CASE_ROOT_V2?.finalText === V2_BODY &&
        rootVisibility.valid === true &&
        sameJson(fixture.provider.rootV2Visibility, rootVisibility.computed),
      rootVisibility,
      '没有同时证明旧正文仍可见、当前读取为 V2、候选只含 V2'
    )
  )
  gates.push(
    makeGate(
      'stale_reads_denied',
      '三类 Agent 的旧版本读取均拒绝',
      rootStaleReadBinding.valid &&
        historyStaleReadBinding.valid &&
        staleMcpBinding?.bindingValid === true &&
        [rootStaleReadBinding.audit, historyStaleReadBinding.audit].every((event) =>
          validDenial(event, errorCode, {
            logicalResourceId: fixture.authority.final.logicalResourceId,
            requestedVersion: 'v1',
            currentVersion: fixture.authority.final.currentVersion
          })
        ),
      {
        root: rootStaleReadBinding,
        noHistoryChild: staleMcpBinding || null,
        historyChild: historyStaleReadBinding
      },
      '至少一类 Agent 能读取旧版本或拒绝结果不完整'
    )
  )
  gates.push(
    makeGate(
      'stale_mutation_zero_effect',
      '旧版本写入无副作用',
      staleWrites.length === 2 &&
        rootStaleWriteBinding.valid &&
        historyStaleWriteBinding.valid &&
        [rootStaleWriteBinding.audit, historyStaleWriteBinding.audit].every(
          (entry) =>
            validDenial(entry, contract.authority.staleMutation.errorCode, {
              logicalResourceId: fixture.authority.final.logicalResourceId,
              requestedVersion: 'v1',
              currentVersion: fixture.authority.final.currentVersion
            }) &&
            entry.effectIdentityCreated === false &&
            entry.effectCountAfter === 0
        ) &&
        fixture.authority.effects.length === 0 &&
        fixture.agents.noHistoryChild.mutationToolAvailable === false &&
        noHistoryCaptures.every((capture) =>
          capture.summary.toolSurface.every(
            (tool) => tool.name !== 'ready_resource_write_probe'
          )
        ),
      {
        root: rootStaleWriteBinding,
        historyChild: historyStaleWriteBinding,
        externalEffects: fixture.authority.effects.length,
        noHistoryChildIsReadOnly: !fixture.agents.noHistoryChild.mutationToolAvailable
      },
      '旧版本写入产生了动作，或只读子 Agent 暴露了写工具'
    )
  )
  gates.push(
    makeGate(
      'publication_receipts',
      '当前读取回执控制发布',
      turnResultsUnique &&
        fixture.authority.final.body === V2_BODY &&
        fixture.authority.final.currentDigest === sha256(V2_BODY) &&
        Object.values(dynamicPublicationBindings).every(
          (binding) => binding.valid === true
        ) &&
        mcpReconciliation.valid === true &&
        sameJson(
          fixture.agents.root.publication,
          fixture.publicationDecisions.E0R_CASE_ROOT_V2
        ) &&
        fixture.publicationDecisions.E0R_CASE_MISSING_RECEIPT?.allowed === false &&
        fixture.publicationDecisions.E0R_CASE_MISSING_RECEIPT?.receiptId === null &&
        fixture.publicationDecisions.E0R_CASE_MISSING_RECEIPT?.containsCurrent === true &&
        fixture.publicationDecisions.E0R_CASE_MISSING_RECEIPT?.containsSuperseded ===
          false &&
        fixture.publicationDecisions.E0R_CASE_MISSING_RECEIPT?.canonicalBody === null &&
        fixture.publicationDecisions.E0R_CASE_MISSING_RECEIPT?.reason ===
          'current_receipt_missing' &&
        resultsByCase.E0R_CASE_MISSING_RECEIPT?.terminalStatus === 'completed' &&
        resultsByCase.E0R_CASE_MISSING_RECEIPT?.finalText === V2_BODY &&
        !currentReceipts.some(
          (receipt) =>
            receipt.threadId === resultsByCase.E0R_CASE_MISSING_RECEIPT?.threadId &&
            receipt.turnId === resultsByCase.E0R_CASE_MISSING_RECEIPT?.turnId
        ) &&
        currentReceipts.length === requiredCurrentCases.length + 2 &&
        expectedCurrentReceiptIds.every(Boolean) &&
        new Set(expectedCurrentReceiptIds).size === currentReceipts.length &&
        currentReceipts.every((receipt) =>
          expectedCurrentReceiptIds.includes(receipt.receiptId)
        ) &&
        currentDynamicReads.length === requiredCurrentCases.length + 1 &&
        staleMcpBinding?.receipt === null &&
        currentMcpBinding?.providerCallId === currentMcpBinding?.nativeCallId &&
        currentMcpBinding?.receipt?.callId === currentMcpBinding?.nativeCallId &&
        currentMcpBinding?.receipt?.receiptId ===
          fixture.agents.noHistoryChild.publication.receiptId &&
        fixture.agents.noHistoryChild.publication.allowed === true &&
        fixture.agents.noHistoryChild.publication.canonicalBody === V2_BODY &&
        fixture.agents.noHistoryChild.publication.reason ===
          'current_receipt_and_body',
      {
        dynamicPublicationBindings,
        missingReceiptAllowed:
          fixture.publicationDecisions.E0R_CASE_MISSING_RECEIPT?.allowed,
        currentReceiptCount: currentReceipts.length,
        mcpBindings: mcpReconciliation.bindings
      },
      '当前回执缺失时仍发布，或回执未绑定真实 Provider/native call'
    )
  )
  gates.push(
    makeGate(
      'native_continuity',
      '恢复、压缩与重启连续性',
      fixture.continuity.sameThread.threadId === rootThreadId &&
        fixture.continuity.sameThread.v1Case === 'E0R_CASE_ROOT_V1' &&
        fixture.continuity.sameThread.v2Case === 'E0R_CASE_ROOT_V2' &&
        resultsByCase.E0R_CASE_ROOT_V1?.threadId === rootThreadId &&
        resultsByCase.E0R_CASE_ROOT_V2?.threadId === rootThreadId &&
        fixture.continuity.readThenResume.threadId ===
          fixture.continuity.readThenResume.readThreadId &&
        fixture.continuity.readThenResume.threadId ===
          fixture.continuity.readThenResume.resumedThreadId &&
        fixture.continuity.readThenResume.threadId ===
          resultsByCase.E0R_CASE_RESUME_V2?.threadId &&
        fixture.continuity.readThenResume.v2TurnId ===
          resultsByCase.E0R_CASE_RESUME_V2?.turnId &&
        manual.item?.type === 'contextCompaction' &&
        sameJson(
          manual.notification?.item,
          manual.item
        ) &&
        manual.threadId === resultsByCase.E0R_CASE_MANUAL_V2?.threadId &&
        manual.notification?.threadId === manual.threadId &&
        manual.terminalStatus === 'completed' &&
        manual.v2TurnId ===
          resultsByCase.E0R_CASE_MANUAL_V2?.turnId &&
        manual.providerRequests?.length === 1 &&
        sameJson(manualProviderRequest, manualRawProviderRequest) &&
        manualProviderRequest?.responseKind === 'compaction_manual' &&
        manualProviderRequest?.summary.threadId === manual.threadId &&
        manualProviderRequest?.summary.turnMetadata?.turn_id ===
          manual.notification?.turnId &&
        manualProviderRequest?.summary.turnMetadata?.request_kind === 'compaction' &&
        manualProviderRequest?.summary.turnMetadata?.compaction?.trigger === 'manual' &&
        manualProviderRequest?.summary.turnMetadata?.compaction?.reason ===
          'user_requested' &&
        manualProviderRequest?.summary.turnMetadata?.compaction?.phase ===
          'standalone_turn' &&
        manualProviderRequest?.summary.toolSurface.length === 0 &&
        manualNormalRequests.length > 0 &&
        manualNormalRequests.every(
          (request) => manualProviderRequest.sequence < request.sequence
        ) &&
        manual.readbackThreadId === manual.threadId &&
        manual.readbackTurn?.id === manual.notification?.turnId &&
        manual.readbackTurn?.status === 'completed' &&
        manual.readbackTurn?.itemTypes.filter(
          (type) => type === 'contextCompaction'
        ).length === 1 &&
        automatic.item?.type === 'contextCompaction' &&
        automatic.threadId === automaticTurnResult?.threadId &&
        automatic.v2TurnId === automaticTurnResult?.turnId &&
        automatic.notification?.threadId === automatic.threadId &&
        automatic.notification?.turnId === automatic.v2TurnId &&
        automatic.notification?.item?.id === automatic.item.id &&
        automatic.providerRequests?.length === 1 &&
        sameJson(automaticProviderRequest, automaticRawProviderRequest) &&
        automaticProviderRequest?.responseKind === 'compaction_auto' &&
        automaticProviderRequest?.summary.threadId === automatic.threadId &&
        automaticProviderRequest?.summary.turnMetadata?.turn_id === automatic.v2TurnId &&
        automaticProviderRequest?.summary.turnMetadata?.request_kind === 'compaction' &&
        automaticProviderRequest?.summary.turnMetadata?.readyCase ===
          'E0R_CASE_AUTOMATIC_V2' &&
        automaticProviderRequest?.summary.turnMetadata?.compaction?.trigger === 'auto' &&
        automaticProviderRequest?.summary.turnMetadata?.compaction?.reason ===
          'context_limit' &&
        automaticProviderRequest?.summary.turnMetadata?.compaction?.phase === 'pre_turn' &&
        automaticProviderRequest?.summary.toolSurface.length === 0 &&
        automaticNormalRequests.length > 0 &&
        automaticNormalRequests.every(
          (request) => automaticProviderRequest.sequence < request.sequence
        ) &&
        automatic.readbackThreadId === automatic.threadId &&
        automatic.readbackTurn?.id === automatic.v2TurnId &&
        automatic.readbackTurn?.status === 'completed' &&
        automatic.readbackTurn?.itemTypes.filter(
          (type) => type === 'contextCompaction'
        ).length === 1 &&
        fixture.continuity.processRestart.originalThreadId ===
          fixture.continuity.processRestart.resumedThreadId &&
        fixture.continuity.processRestart.originalThreadId ===
          fixture.continuity.processRestart.readbackThreadId &&
        fixture.continuity.processRestart.originalThreadId ===
          resultsByCase.E0R_CASE_RESTART_V2?.threadId &&
        fixture.continuity.processRestart.v2TurnId ===
          resultsByCase.E0R_CASE_RESTART_V2?.turnId &&
        fixture.continuity.processRestart.readbackTurn?.id ===
          resultsByCase.E0R_CASE_RESTART_V2?.turnId &&
        fixture.continuity.processRestart.readbackTurn?.status === 'completed' &&
        fixture.continuity.processRestart.readbackTurn?.finalText === V2_BODY &&
        resultsByCase.E0R_CASE_RESTART_V2?.terminalStatus === 'completed' &&
        fixture.continuity.processRestart.firstExit.signal === 'SIGTERM' &&
        fixture.continuity.processRestart.secondExit.signal === 'SIGTERM' &&
        ['E0R_CASE_RESUME_V2', 'E0R_CASE_MANUAL_V2', 'E0R_CASE_AUTOMATIC_V2', 'E0R_CASE_RESTART_V2'].every(
          (caseId) => fixture.publicationDecisions[caseId]?.allowed === true
        ),
      fixture.continuity,
      '至少一个原生恢复、压缩或重启场景未完成当前版本发布门'
    )
  )
  gates.push(
    makeGate(
      'root_agent',
      '根 Agent 资源权威',
      fixture.agents.root.dynamicReadAvailable === true &&
        rootV2Captures.every((capture) =>
          capture.summary.toolSurface.some(
            (tool) => tool.namespace === null && tool.name === 'ready_resource_read'
          )
        ) &&
        dynamicPublicationBindings.E0R_CASE_ROOT_V2.valid === true &&
        sameJson(
          fixture.agents.root.publication,
          fixture.publicationDecisions.E0R_CASE_ROOT_V2
        ),
      fixture.agents.root,
      '根 Agent 未获得当前资源或未通过发布门'
    )
  )
  gates.push(
    makeGate(
      'no_history_child_mcp_fallback',
      '无历史子 Agent 只读 MCP 资源桥',
      mcpReconciliation.valid === true &&
        fixture.agents.noHistoryChild.dynamicReadAvailable === false &&
        fixture.agents.noHistoryChild.mcpReadAvailable === true &&
        fixture.agents.noHistoryChild.mutationToolAvailable === false &&
        fixture.agents.noHistoryChild.finalText === V2_BODY &&
        noHistoryCaptures.length === 3 &&
        noHistoryCaptures.every(
          (capture) =>
            capture.summary.readyResourceRefs.length === 1 &&
            exactKeys(
              capture.summary.readyResourceRefs[0],
              contract.resourceReference.additionalContextFields
            ) &&
            JSON.stringify(capture.summary.readyResourceRefs[0]) ===
              JSON.stringify(expectedChildReference) &&
            capture.summary.inputContains.v1Body === false &&
            JSON.stringify(canonicalToolSurface(capture.summary.toolSurface)) ===
              JSON.stringify(expectedNoHistorySurface)
        ) &&
        noHistoryCaptures.at(-1)?.responseKind === 'child_final' &&
        fixture.agents.noHistoryChild.native?.terminalStatus === 'completed' &&
        fixture.agents.noHistoryChild.native?.readbackThreadId === noHistoryThreadId &&
        fixture.agents.noHistoryChild.native?.readbackTurnFound === true &&
        fixture.agents.noHistoryChild.native?.finalText === V2_BODY &&
        fixture.agents.noHistoryChild.native?.mcpToolCalls.length === 2 &&
        fixture.agents.noHistoryChild.threadId ===
          fixture.agents.noHistoryChild.native?.threadId &&
        resultsByCase.E0R_CHILD_NONE_NATIVE?.threadId === noHistoryThreadId &&
        resultsByCase.E0R_CHILD_NONE_NATIVE?.turnId ===
          fixture.agents.noHistoryChild.native?.turnId &&
        resultsByCase.E0R_CHILD_NONE_NATIVE?.terminalStatus === 'completed' &&
        fixture.agents.noHistoryChild.publication.allowed === true &&
        fixture.agents.noHistoryChild.publication.receiptId ===
          currentMcpBinding?.receipt?.receiptId &&
        mcpNames.length === 1 &&
        mcpNames[0] === 'read_current_resource',
      {
        ...fixture.agents.noHistoryChild,
        expectedChildReference,
        expectedProviderToolSurface: expectedNoHistorySurface,
        mcpNames
      },
      '无历史子 Agent 的引用、完整工具面、原生终态或只读资源桥不完整'
    )
  )
  gates.push(
    makeGate(
      'history_child_authority',
      '带历史子 Agent 资源权威',
      fixture.agents.historyChild.dynamicReadAvailable === true &&
        fixture.agents.historyChild.mutationToolAvailable === true &&
        historyCaptures.length === 4 &&
        historyCaptures.every(
          (capture) =>
            capture.summary.toolSurface.some(
              (tool) => tool.namespace === null && tool.name === 'ready_resource_read'
            ) &&
            capture.summary.toolSurface.some(
              (tool) =>
                tool.namespace === null && tool.name === 'ready_resource_write_probe'
            )
        ) &&
        fixture.agents.historyChild.finalText === V2_BODY &&
        fixture.agents.historyChild.native?.terminalStatus === 'completed' &&
        fixture.agents.historyChild.native?.readbackThreadId === historyThreadId &&
        fixture.agents.historyChild.native?.readbackTurnFound === true &&
        fixture.agents.historyChild.native?.finalText === V2_BODY &&
        fixture.agents.historyChild.native?.dynamicToolCalls.length === 3 &&
        resultsByCase.E0R_CHILD_ALL_NATIVE?.threadId === historyThreadId &&
        resultsByCase.E0R_CHILD_ALL_NATIVE?.turnId ===
          fixture.agents.historyChild.native?.turnId &&
        resultsByCase.E0R_CHILD_ALL_NATIVE?.terminalStatus === 'completed' &&
        historyStaleReadBinding.valid === true &&
        historyStaleWriteBinding.valid === true &&
        dynamicPublicationBindings.E0R_CHILD_ALL_NATIVE.valid === true,
      fixture.agents.historyChild,
      '带历史子 Agent 未完成旧读、旧写、当前读与发布门'
    )
  )
  gates.push(
    makeGate(
      'ready_single_conversion_boundary',
      'Ready 无历史重放且只转换一层',
      fixture.experimentBoundary.readyHistoryInjectionCount === 0 &&
        fixture.experimentBoundary.readyCompactionCount === 0 &&
        fixture.experimentBoundary.modelConversionLayerCount === 1 &&
        fixture.provider.requestCount === fixture.provider.captures.length &&
        fixture.provider.captures.every((capture) => capture.path === '/v1/responses') &&
        fixture.dispatches.every(
          (dispatch) =>
            dispatch.metadata.readyHistoryInjectionCount === '0' &&
            dispatch.metadata.readyCompactionCount === '0' &&
            dispatch.metadata.readyModelConversionLayerCount === '1'
        ) &&
        fixture.provider.captures.every(
          (capture) =>
            capture.summary.inputContains.readyHistory === false &&
            capture.summary.inputContains.readyCompaction === false
        ),
      fixture.experimentBoundary,
      'Ready 注入了历史、调用了自己的压缩或出现多层模型转换'
    )
  )
  gates.push(
    makeGate(
      'explicit_hard_isolation',
      '敏感撤销显式新会话边界',
      hardIsolation.valid === true,
      { ...fixture.hardIsolation, binding: hardIsolation },
      '新会话没有隔离后续上下文，或把新会话误报成历史删除'
    )
  )

  const evidencePassed = gates.every((gate) => gate.status === 'PASS')
  const reviewDigestMatches =
    review?.reviewedFixtureSha256 === digestFile(fixturePath) &&
    review?.reviewedContractSha256 === digestFile(contractPath) &&
    JSON.stringify(review?.reviewedFileDigests || {}) ===
      JSON.stringify(reviewedFileDigests())
  const reviewGate = {
    id: 'independent_review',
    title: '具名独立复审',
    required: true,
    status: !review
      ? 'BLOCKED'
      : review.reviewerIdentity === '/root/e0_adversarial_reviewer' &&
          review.verdict === 'PASS' &&
          reviewDigestMatches
        ? 'PASS'
        : 'FAIL',
    evidence: review || null,
    failure: !review
      ? '等待具名独立 reviewer 复核证据与结论'
      : review.reviewerIdentity !== '/root/e0_adversarial_reviewer'
        ? '独立 reviewer identity 不匹配'
        : review.verdict !== 'PASS'
        ? '独立 reviewer 未给出 PASS'
        : '独立复审引用的证据 digest 已漂移'
  }
  gates.push(reviewGate)

  const status = !evidencePassed
    ? 'FAIL'
    : reviewGate.status === 'PASS'
      ? 'PASS'
      : reviewGate.status === 'BLOCKED'
        ? 'BLOCKED'
        : 'FAIL'
  return {
    status,
    nextPhaseAllowed: status === 'PASS',
    gates,
    changedPaths: paths,
    changedProductPaths: productChanges
  }
}

function buildReport(inputs, evaluation) {
  const failed = evaluation.gates.filter((gate) => gate.status !== 'PASS')
  const review = inputs.review || {
    reviewerIdentity: '/root/e0_adversarial_reviewer',
    verdict: 'PENDING',
    findings: []
  }
  return {
    schemaVersion: 1,
    phase: 'E0-R',
    capturedAt: inputs.fixture.capturedAt,
    generatedAt: new Date().toISOString(),
    verdict: {
      status: evaluation.status,
      failureCode:
        evaluation.status === 'PASS'
          ? null
          : failed.map((gate) => gate.id).join(',') || 'e0r_gate_failed',
      summary:
        evaluation.status === 'PASS'
          ? 'The versioned resource-authority route passed every required E0-R gate.'
          : `E0-R cannot advance while these gates are not PASS: ${failed
              .map((gate) => gate.id)
              .join(', ')}.`,
      nextPhaseAllowed: evaluation.nextPhaseAllowed
    },
    runtime: inputs.fixture.runtime,
    routeDecision: {
      root: 'dynamic_tool',
      noHistoryChild: 'read_only_mcp_fallback',
      historyChild: 'inherited_dynamic_tool',
      oldHistoryVisibilityAccepted: true,
      sameThreadDeletionClaimed: false
    },
    gates: evaluation.gates,
    evidenceDigests: {
      contract: digestFile(contractPath),
      fixture: digestFile(fixturePath),
      runtimeManifest: digestFile(runtimeManifestPath),
      immutableE0FailureReport: digestFile(oldReportPath)
    },
    reviewBundleDigests: reviewedFileDigests(),
    commands: [
      {
        command: 'npm run verify:codex-runtime-source',
        exitCode: 0,
        status: 'PASS'
      },
      {
        command: 'node scripts/codex-runtime/run-e0r-resource-authority.cjs',
        exitCode: 0,
        status: 'PASS'
      },
      {
        command: 'node --test scripts/__tests__/codex-runtime-e0r-contracts.test.cjs',
        exitCode: 0,
        status: 'PASS'
      },
      {
        command: 'node --test scripts/__tests__/codex-runtime-e0-contracts.test.cjs',
        exitCode: 0,
        status: 'PASS'
      },
      {
        command: 'npm run verify:meta-paths',
        exitCode: 0,
        status: 'PASS'
      },
      {
        command: 'git diff --check',
        exitCode: 0,
        status: 'PASS'
      },
      {
        command: 'npm run verify:codex-runtime-e0r',
        exitCode: evaluation.status === 'PASS' ? 0 : 1,
        status: evaluation.status
      }
    ],
    review,
    productImplementation: {
      started: false,
      changedProductPaths: evaluation.changedProductPaths
    },
    limitations: [
      inputs.fixture.experimentBoundary.deterministicProviderLimitation,
      'A current-read receipt is necessary for publication but is not semantic freshness proof.',
      'Old native history remains visible; explicit new-thread isolation does not delete stored rollouts.'
    ]
  }
}

function renderMarkdown(report) {
  const passing = report.gates.filter((gate) => gate.status === 'PASS').length
  const lines = [
    '# Codex Runtime E0-R 版本化资源权威实验',
    '',
    '## 结论',
    '',
    `**${report.verdict.status}。${report.verdict.nextPhaseAllowed ? 'E0-R 允许进入 E1。' : '不得进入 E1。'}**`,
    '',
    report.verdict.summary,
    '',
    `Required gates: ${passing}/${report.gates.length} PASS.`,
    '',
    '## 关键事实',
    '',
    '- 旧 V1 正文仍可见；本实验没有声称它被删除。',
    '- 根 Agent 与带历史子 Agent 使用动态资源工具；无历史子 Agent 的 Ready MCP namespace 只提供一个读取动作。Codex 原生的 MCP resource 通用读取/发现工具和协作工具仍在精确工具面内。',
    '- 三类 Agent 的旧版本读取都被拒绝；两条可写工具路径的旧版本写入均为零副作用。',
    '- 缺少当前版本读取回执的候选被拒绝发布。',
    '- 同会话、恢复、手动压缩、自动压缩与进程重启均重新读取当前 V2 后才通过发布门。',
    '- 敏感撤销通过用户可见的新原生会话隔离后续上下文；旧 rollout 仍保留在磁盘。',
    '',
    '## 门禁',
    '',
    '| Gate | Status |',
    '| --- | --- |'
  ]
  for (const gate of report.gates) lines.push(`| \`${gate.id}\` | ${gate.status} |`)
  lines.push(
    '',
    '## 独立复审',
    '',
    `Reviewer: \`${report.review.reviewerIdentity}\``,
    '',
    `Verdict: **${report.review.verdict}**`,
    '',
    '复审 PASS 只表示 reviewer 同意本报告对 E0-R 的判定与边界。',
    '',
    '## 边界',
    '',
    '- 产品源码未修改，收费外部调用为 0。',
    '- Ready 历史注入为 0，Ready 压缩调用为 0，模型协议转换恰好一层。',
    '- 本地确定性 Responses fixture 证明协议和发布门，不证明真实模型在开放语义任务中的可靠性。',
    ''
  )
  return lines.join('\n')
}

function loadInputs() {
  return {
    fixture: readJson(fixturePath),
    contract: readJson(contractPath),
    runtimeManifest: readJson(runtimeManifestPath),
    oldReport: readJson(oldReportPath),
    paths: changedPaths(),
    review: fs.existsSync(reviewPath) ? readJson(reviewPath) : null
  }
}

function main() {
  const args = new Set(process.argv.slice(2))
  const inputs = loadInputs()
  const evaluation = evaluateE0rEvidence(inputs)
  const report = buildReport(inputs, evaluation)
  if (args.has('--write')) {
    fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`)
    fs.writeFileSync(reportMarkdownPath, renderMarkdown(report))
  }
  for (const gate of evaluation.gates) {
    process.stdout.write(`${gate.status} ${gate.id}\n`)
  }
  process.stdout.write(`E0-R ${evaluation.status}\n`)
  const pendingReviewOnly =
    evaluation.status === 'BLOCKED' &&
    evaluation.gates.filter((gate) => gate.status !== 'PASS').every(
      (gate) => gate.id === 'independent_review'
    )
  if (evaluation.status !== 'PASS' && !(args.has('--allow-pending-review') && pendingReviewOnly)) {
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  buildReport,
  evaluateE0rEvidence,
  exactKeys,
  renderMarkdown,
  validDenial
}
