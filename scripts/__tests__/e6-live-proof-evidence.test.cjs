'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const test = require('node:test')

const {
  LARK_RESOURCE_PATHS,
  assertE6LiveProofEvidence,
  sha256Canonical,
} = require('../codex-runtime/e6-live-proof-evidence.cjs')

const digest = (character) => character.repeat(64)

function capture(
  threadId,
  turnId,
  readyRunId,
  requestIndex,
  answer,
  occurrences,
  proofNeedles,
  toolNames,
  visibleTarget = null,
) {
  return {
    requestKind: 'product',
    readyRunId,
    threadId,
    turnId,
    requestDigest: sha256Canonical(`${readyRunId}:request:${requestIndex}`),
    inputDigest: sha256Canonical(`${readyRunId}:input:${requestIndex}`),
    readyResourceReferenceCount: 1,
    toolsDigest: digest(toolNames[0] === 'feishu_doc_read' ? '1' : '2'),
    toolNames,
    toolCount: toolNames.length,
    proofSentinels: proofNeedles.map((needle) => ({
      digest: sha256Canonical(needle),
      occurrences: needle === answer ? occurrences : (needle === visibleTarget ? 1 : 0),
    })),
  }
}

function receipt(scopeId, readyRunId, threadId, turnId, index, toolName, actionResult) {
  const resultDigest = sha256Canonical(actionResult)
  const actionIdentityDigest = sha256Canonical(`action:${scopeId}:${index}`)
  return {
    scopeId,
    readyRunId,
    codexThreadId: threadId,
    codexTurnId: turnId,
    codexCallId: `call-${scopeId}-${index}`,
    toolName,
    admissionArgsDigest: digest('a'),
    bindingArgsDigest: digest('a'),
    gatewayRequestReceiptId: `model-receipt-${readyRunId}-${index}`,
    readyActionId: `codex-action-${actionIdentityDigest}`,
    bindingReceiptId: `receipt-${scopeId}-${index}`,
    bindingResultDigest: resultDigest,
    actionIdentityDigest,
    actionState: 'confirmed',
    actionReceiptId: `receipt-${scopeId}-${index}`,
    actionResultDigest: resultDigest,
    actionResult,
  }
}

function refreshReceiptDigest(call) {
  call.bindingResultDigest = sha256Canonical(call.actionResult)
  call.actionResultDigest = call.bindingResultDigest
}

function fixture() {
  const proofAnswers = ['FEISHU_ANSWER', 'LARK_ANSWER']
  const larkDocumentRef = 'docx_fixture_token_1234'
  const proofNeedles = [...proofAnswers, larkDocumentRef]
  const runtimeExpectation = {
    runtimeManifestDigest: digest('6'),
    protocolSchemaDigest: digest('7'),
    sidecarRuntime: {
      runtimeManifestDigest: digest('6'),
      binarySha256: digest('9'),
      executablePath: '/trusted/codex',
    },
  }
  const larkProvenance = {
    payloadPath: '/opt/homebrew/lib/node_modules/@larksuite/cli/bin/lark-cli',
    payloadSha256: digest('8'),
    version: 'lark-cli version 1.0.76',
  }
  const providerSnapshot = {
    profileId: 'provider-profile-1',
    providerId: 'openai-compatible',
    model: 'real-model',
    baseUrl: 'https://provider.example.org/v1',
    agentProtocol: 'openai',
    wireApi: 'responses',
    reasoningEffort: 'high',
    supportsToolCalls: true,
    supportsNativeToolCalls: true,
    supportsVision: true,
    supportsThinking: true,
    multiTurnThinkingPolicy: 'proven_safe',
    patchProfileId: null,
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    extraHeaders: {},
    credentialReferenceId: 'ai-profile:provider-profile-1',
    retryPolicy: { owner: 'ready_gateway', maxRetries: 6, semantic4xxRetries: 0 },
  }
  const providerSnapshotDigest = sha256Canonical(providerSnapshot)
  const larkResourceTexts = ['selected-resource', 'sibling-resource', 'fetch-resource']
  const larkResources = LARK_RESOURCE_PATHS.map((logicalPath, index) => ({
    logicalPath,
    rootKind: index === 1 ? 'sibling_skill' : 'selected_skill',
    relativePath: index === 2 ? 'references/lark-doc-fetch.md' : 'SKILL.md',
    sha256: createHash('sha256').update(larkResourceTexts[index]).digest('hex'),
    fileIdentity: {
      device: '1',
      inode: String(index + 1),
      size: Buffer.byteLength(larkResourceTexts[index]),
      mode: 33188,
      mtimeMs: 1,
    },
  }))
  const larkExecutableFileIdentity = {
    device: '1', inode: '10', size: 100, mode: 33188, mtimeMs: 1,
  }
  const larkExecutableUnsigned = {
    program: larkProvenance.payloadPath,
    outerPath: larkProvenance.payloadPath,
    realPath: larkProvenance.payloadPath,
    payloadPath: larkProvenance.payloadPath,
    payloadSha256: larkProvenance.payloadSha256,
    fileIdentity: larkExecutableFileIdentity,
    launcherChain: [{
      kind: 'payload',
      path: larkProvenance.payloadPath,
      realPath: larkProvenance.payloadPath,
      sha256: larkProvenance.payloadSha256,
      fileIdentity: larkExecutableFileIdentity,
    }],
    launchPath: larkProvenance.payloadPath,
    spawnPath: larkProvenance.payloadPath,
    launchPrefixArgs: [],
    version: larkProvenance.version,
    wrapperExecutionForbidden: true,
    autoInstallForbidden: true,
  }
  const larkExecutableAuthority = {
    ...larkExecutableUnsigned,
    authorityDigest: sha256Canonical(larkExecutableUnsigned),
  }
  const larkAuthUnsigned = {
    identity: 'user',
    verified: true,
    userStatus: 'ready',
    userAvailable: true,
    userVerified: true,
    tokenStatus: 'valid',
    principalDigest: digest('d'),
    scopeDigest: digest('e'),
    executableReadbackDigest: larkExecutableAuthority.authorityDigest,
  }
  const larkAuthReadback = {
    ...larkAuthUnsigned,
    authReadbackDigest: sha256Canonical(larkAuthUnsigned),
  }
  const providerExpectation = {
    profileId: providerSnapshot.profileId,
    providerId: providerSnapshot.providerId,
    model: providerSnapshot.model,
    baseUrl: providerSnapshot.baseUrl,
    snapshotRef: 'provider-snapshot-1',
    snapshotDigest: providerSnapshotDigest,
    endpointClass: 'trusted_public_https',
    endpointOriginDigest: digest('0'),
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  }
  const results = []
  const expectedRuns = []
  const threads = []
  const turns = []
  const calls = []
  const groups = []
  const gatewayRequests = []
  const gatewayCapture = []
  for (const [kind, callNames, toolNames, surfaceDigest] of [
    ['feishu_typed_read', ['feishu_doc_read'], ['feishu_doc_read', 'safe_other_read'], digest('1')],
    ['lark_cli_read', [
      'skill_read_artifact', 'skill_read_artifact', 'skill_read_artifact', 'skill_run_shell',
    ], ['skill_read_artifact', 'skill_run_shell', 'safe_other_read'], digest('2')],
  ]) {
    for (let index = 1; index <= 3; index += 1) {
      const prefix = kind === 'feishu_typed_read' ? 'feishu' : 'lark'
      const scopeId = `${prefix}-scope-${index}`
      const threadId = `${prefix}-thread-${index}`
      const turnId = `${prefix}-turn-${index}`
      const readyRunId = `${prefix}-run-${index}`
      const answer = `${prefix.toUpperCase()}_ANSWER`
      const feishuRawResult = { success: true, data: { content: `ANSWER=${answer}` } }
      const larkStdout = JSON.stringify({
        data: {
          document: {
            document_id: larkDocumentRef,
            content: `Fixture body\nANSWER=${answer}\nFixture tail`,
          },
        },
      })
      const currentDigest = kind === 'feishu_typed_read'
        ? sha256Canonical(feishuRawResult)
        : createHash('sha256').update(larkStdout).digest('hex')
      const logicalResourceId = `${prefix}:resource`
      const currentVersion = 'v1'
      const policyEpoch = 1
      const baseSlice = {
        kind,
        logicalResourceId,
        currentVersion,
        currentDigest,
        policyEpoch,
        allowedToolNames: kind === 'feishu_typed_read'
          ? ['feishu_doc_read']
          : ['skill_read_artifact', 'skill_run_shell'],
      }
      const unsealedSlice = kind === 'feishu_typed_read'
        ? {
            ...baseSlice,
            authority: {
              channelId: 'channel-1',
              docToken: 'doc-token-1',
              docType: 'docx',
              allowedToolName: 'feishu_doc_read',
              channelIdentityDigest: digest('c'),
              expectedResultDigest: currentDigest,
            },
          }
        : {
            ...baseSlice,
            skillId: 'lark-doc',
            docRef: larkDocumentRef,
            skillRoot: '/trusted/lark-doc',
            siblingReadRoots: ['/trusted/lark-shared'],
            requiredResources: larkResources,
            authReadback: larkAuthReadback,
            requiredMethod: {
              methodId: 'lark-doc-fetch',
              commandName: 'lark-cli',
              expectedStdoutSha256: currentDigest,
              allowedArgv: [[
                'docs', '+fetch', '--doc', larkDocumentRef,
                '--as', 'user', '--doc-format', 'markdown', '--detail', 'simple',
                '--revision-id', '-1', '--scope', 'full', '--format', 'json',
              ]],
              executableAuthority: larkExecutableAuthority,
            },
          }
      const sliceDigests = kind === 'feishu_typed_read'
        ? {
            methodConstraintDigest: sha256Canonical({
              kind,
              allowedToolNames: baseSlice.allowedToolNames,
              authority: {
                channelId: unsealedSlice.authority.channelId,
                docToken: unsealedSlice.authority.docToken,
                docType: unsealedSlice.authority.docType,
                allowedToolName: unsealedSlice.authority.allowedToolName,
              },
            }),
            dependencySnapshotDigest: sha256Canonical({
              provider: 'ready_connector:feishu',
              channelIdentityDigest: unsealedSlice.authority.channelIdentityDigest,
            }),
          }
        : {
            methodConstraintDigest: sha256Canonical({
              kind,
              allowedToolNames: baseSlice.allowedToolNames,
              skillId: unsealedSlice.skillId,
              requiredResources: unsealedSlice.requiredResources.map((resource) => ({
                logicalPath: resource.logicalPath,
                rootKind: resource.rootKind,
                relativePath: resource.relativePath,
              })),
              methodId: unsealedSlice.requiredMethod.methodId,
              commandName: unsealedSlice.requiredMethod.commandName,
              allowedArgv: unsealedSlice.requiredMethod.allowedArgv,
            }),
            dependencySnapshotDigest: sha256Canonical({
              skillRoot: unsealedSlice.skillRoot,
              siblingReadRoots: unsealedSlice.siblingReadRoots,
              requiredResourceIdentities: unsealedSlice.requiredResources.map((resource) => ({
                logicalPath: resource.logicalPath,
                sha256: resource.sha256,
                fileIdentity: resource.fileIdentity,
              })),
              executableAuthority: unsealedSlice.requiredMethod.executableAuthority,
              authReadback: unsealedSlice.authReadback,
            }),
          }
      const externalReadSlice = { ...unsealedSlice, ...sliceDigests }
      results.push({
        ok: true,
        scopeId,
        kind,
        index,
        finalText: answer,
        expectedAnswer: answer,
        toolCalls: [...callNames],
      })
      expectedRuns.push({
        scopeId,
        kind,
        index,
        expectedAnswer: answer,
        logicalResourceId,
        currentVersion,
        currentDigest,
        policyEpoch,
        allowedToolNames: [...baseSlice.allowedToolNames],
        callNames,
        ...(kind === 'feishu_typed_read'
          ? { channelId: 'channel-1', documentToken: 'doc-token-1', documentType: 'docx' }
          : { documentRef: larkDocumentRef, larkProvenance }),
      })
      threads.push({
        scopeId,
        codexThreadId: threadId,
        codexSessionId: threadId,
        runtimeManifestDigest: runtimeExpectation.runtimeManifestDigest,
        protocolSchemaDigest: runtimeExpectation.protocolSchemaDigest,
        codexModel: 'ready-e0-model',
        upstreamProfileSnapshotRef: providerExpectation.snapshotRef,
        upstreamProfileSnapshotDigest: providerExpectation.snapshotDigest,
        toolSurfaceDigest: surfaceDigest,
        toolSurfaceJson: { toolNames },
      })
      const runCalls = callNames.map((toolName, callIndex) => {
        let actionResult
        if (kind === 'feishu_typed_read') {
          actionResult = {
            data: {
              ok: true,
              success: true,
              data: feishuRawResult.data,
            },
          }
        } else if (toolName === 'skill_read_artifact') {
          actionResult = {
            text: larkResourceTexts[callIndex],
            data: { resourcePath: LARK_RESOURCE_PATHS[callIndex] },
          }
        } else {
          actionResult = {
            data: {
              ok: true,
              exitCode: 0,
              stdout: larkStdout,
              stdoutTruncated: false,
              stdoutArtifactPath: null,
              requiredMethod: {
                methodId: 'lark-doc-fetch',
                commandName: 'lark-cli',
                authorityDigest: larkExecutableAuthority.authorityDigest,
              },
            },
          }
        }
        return receipt(scopeId, readyRunId, threadId, turnId, callIndex, toolName, actionResult)
      })
      calls.push(...runCalls)
      groups.push(...runCalls.map((call) => ({
        scopeId,
        readyRunId,
        codexThreadId: threadId,
        codexTurnId: turnId,
        gatewayRequestReceiptId: call.gatewayRequestReceiptId,
        toolCallCount: 1,
        parallelGroupCharged: 0,
      })))
      turns.push({
        scopeId,
        readyRunId,
        codexThreadId: threadId,
        codexTurnId: turnId,
        ingress: {
          prepared: {
            ingress: {
              currentDocumentAnchor: null,
              resourceAdditionalContext: [{
                logicalResourceId,
                currentVersion,
                currentDigest,
                supersedesVersion: null,
                policyEpoch,
              }],
            },
            externalReadSlice,
          },
        },
        authorization: { allowedToolNames: baseSlice.allowedToolNames },
        engineTerminalStatus: 'completed',
        candidateText: answer,
        canonicalMessageCount: 1,
        canonicalMessageText: answer,
        assistantScopeMessageCount: 1,
        userScopeMessageCount: 1,
        userMessageText: kind === 'lark_cli_read'
          ? `Read target ${larkDocumentRef} and return the ANSWER line value.`
          : 'Read the authorized Feishu document and return the ANSWER line value.',
        productTerminalDigest: digest('3'),
        publicationReceiptRefs: runCalls.map((call) => call.bindingReceiptId),
        publicationReceiptDigest: digest('4'),
        fenceReleaseRevision: 2,
        gatewayRequestCount: runCalls.length + 1,
      })
      for (let requestIndex = 0; requestIndex < runCalls.length + 1; requestIndex += 1) {
        const requestCapture = capture(
          threadId,
          turnId,
          readyRunId,
          requestIndex,
          answer,
          requestIndex === runCalls.length ? 1 : 0,
          proofNeedles,
          toolNames,
          kind === 'lark_cli_read' ? larkDocumentRef : null,
        )
        gatewayCapture.push(requestCapture)
        const requestSequence = gatewayRequests.length * 2 + 1
        gatewayRequests.push({
          scopeId,
          gatewayRequestReceiptId: `model-receipt-${readyRunId}-${requestIndex}`,
          readyRunId,
          requestKind: requestCapture.requestKind,
          codexThreadId: threadId,
          codexTurnId: turnId,
          upstreamProfileSnapshotDigest: providerExpectation.snapshotDigest,
          requestDigest: requestCapture.requestDigest,
          inputDigest: requestCapture.inputDigest,
          toolsDigest: requestCapture.toolsDigest,
          requestSequence,
          requestEvidenceDigest: sha256Canonical(`${readyRunId}:request-evidence:${requestIndex}`),
          responseSequence: requestSequence + 1,
          responseEvidenceDigest: sha256Canonical(`${readyRunId}:response-evidence:${requestIndex}`),
          responseId: `response-${readyRunId}-${requestIndex}`,
          responseTerminalDigest: sha256Canonical(`${readyRunId}:terminal:${requestIndex}`),
          responseOutputDigest: sha256Canonical(`${readyRunId}:output:${requestIndex}`),
          responseUsageDigest: sha256Canonical(`${readyRunId}:usage:${requestIndex}`),
        })
      }
    }
  }
  return {
    results,
    expectedRuns,
    gatewayCapture,
    evidence: {
      threads,
      turns,
      calls,
      groups,
      gatewayRequests,
      providerSnapshots: [{
        snapshotRef: providerExpectation.snapshotRef,
        snapshotDigest: providerExpectation.snapshotDigest,
        profileId: providerExpectation.profileId,
        credentialReferenceId: providerSnapshot.credentialReferenceId,
        snapshot: providerSnapshot,
      }],
      sidecarLeases: [{
        pid: 43210,
        processGroupId: 43210,
        processStartIdentity: '43210:proof-start',
        runtimeManifestDigest: runtimeExpectation.sidecarRuntime.runtimeManifestDigest,
        binarySha256: runtimeExpectation.sidecarRuntime.binarySha256,
        executablePath: '/trusted/codex',
        ownerMainPid: 43100,
        ownerMainProcessStartIdentity: '43100:main-start',
        closedAt: 'now',
        treeZeroAt: 'now',
        treeZeroEvidenceDigest: digest('5'),
      }],
      ignoredUnstartedThreadCount: 1,
    },
    providerExpectation,
    runtimeExpectation,
    mainProcessExpectation: {
      pid: 43100,
      processStartIdentity: '43100:main-start',
    },
  }
}

test('accepts exact independent Feishu 3 and Lark 3 evidence', () => {
  const input = fixture()
  const summary = assertE6LiveProofEvidence(input)
  assert.equal(summary.runCount, 6)
  assert.equal(summary.toolCallCount, 15)
  assert.equal(summary.providerRequestCount, 21)
  assert.equal(summary.runs.filter((row) => row.kind === 'feishu_typed_read').length, 3)
  assert.equal(summary.runs.filter((row) => row.kind === 'lark_cli_read').length, 3)
})

test('binds the renderer result to its exact expected scope and answer', () => {
  const input = fixture()
  input.results[0].finalText = 'WRONG'
  input.results[0].expectedAnswer = 'WRONG'
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_renderer_result_mismatch/)
})

test('rejects authorization widening and Browser fallback', () => {
  const widened = fixture()
  widened.evidence.turns[0].authorization.allowedToolNames.push('browser_read')
  assert.throws(() => assertE6LiveProofEvidence(widened), /e6_authorization_mismatch/)

  const browser = fixture()
  browser.evidence.calls[0].toolName = 'browser_read'
  assert.throws(() => assertE6LiveProofEvidence(browser), /e6_tool_sequence_mismatch/)
})

test('rejects duplicate tool calls or provider requests', () => {
  const duplicateCall = fixture()
  duplicateCall.evidence.calls.push({ ...duplicateCall.evidence.calls[0] })
  assert.throws(() => assertE6LiveProofEvidence(duplicateCall), /e6_call_or_request_count_mismatch/)

  const duplicateRequest = fixture()
  duplicateRequest.gatewayCapture.push({ ...duplicateRequest.gatewayCapture[0] })
  assert.throws(() => assertE6LiveProofEvidence(duplicateRequest), /e6_gateway_capture_mismatch/)
})

test('rejects a flat Feishu result that cannot occur on the real tool path', () => {
  const input = fixture()
  input.evidence.calls[0].actionResult.data.content = input.evidence.calls[0].actionResult.data.data.content
  delete input.evidence.calls[0].actionResult.data.data
  refreshReceiptDigest(input.evidence.calls[0])
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_feishu_result_mismatch/)
})

test('recomputes Feishu and Lark external result digests from persisted output', () => {
  const feishu = fixture()
  feishu.evidence.calls[0].actionResult.data.data.content += '\nchanged'
  refreshReceiptDigest(feishu.evidence.calls[0])
  assert.throws(() => assertE6LiveProofEvidence(feishu), /e6_feishu_result_mismatch/)

  const lark = fixture()
  const shell = lark.evidence.calls.find((call) => call.toolName === 'skill_run_shell')
  shell.actionResult.data.stdout += '\nchanged'
  refreshReceiptDigest(shell)
  assert.throws(() => assertE6LiveProofEvidence(lark), /e6_lark_result_mismatch/)
})

test('rejects gateway captures outside the six proof turns', () => {
  const input = fixture()
  input.gatewayCapture.push({
    ...input.gatewayCapture[0],
    threadId: 'alien-thread',
    turnId: 'alien-turn',
  })
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_unexpected_gateway_capture/)
})

test('rejects a duplicated capture that replaces a distinct admitted request', () => {
  const input = fixture()
  input.gatewayCapture[7] = { ...input.gatewayCapture[8] }
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_gateway_receipt_capture_mismatch/)
})

test('rejects Lark body visibility before the shell read result', () => {
  const input = fixture()
  input.gatewayCapture[7].proofSentinels[0].occurrences = 1
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_gateway_capture_mismatch/)
})

test('requires the exact Lark target in the first provider input while the body sentinel is absent', () => {
  const input = fixture()
  const expected = input.expectedRuns.find((run) => run.kind === 'lark_cli_read')
  const turn = input.evidence.turns.find((row) => row.scopeId === expected.scopeId)
  const capture = input.gatewayCapture.find((row) => (
    row.threadId === turn.codexThreadId && row.turnId === turn.codexTurnId
  ))
  assert.equal(capture.proofSentinels[1].occurrences, 0)
  assert.equal(capture.proofSentinels[2].occurrences, 1)
  capture.proofSentinels[2].occurrences = 0
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_lark_target_visibility_mismatch/)
})

test('rejects a Lark answer that was already present in the user prompt', () => {
  const input = fixture()
  const expected = input.expectedRuns.find((run) => run.kind === 'lark_cli_read')
  const turn = input.evidence.turns.find((row) => row.scopeId === expected.scopeId)
  turn.userMessageText += expected.expectedAnswer
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_terminal_closeout_mismatch/)
})

test('requires exactly one ANSWER line inside ordinary Lark document content', () => {
  const input = fixture()
  const expected = input.expectedRuns.find((run) => run.kind === 'lark_cli_read')
  const turn = input.evidence.turns.find((row) => row.scopeId === expected.scopeId)
  const shell = input.evidence.calls.find((call) => (
    call.scopeId === expected.scopeId && call.toolName === 'skill_run_shell'
  ))
  const parsed = JSON.parse(shell.actionResult.data.stdout)
  parsed.data.document.content += `\nANSWER=${expected.expectedAnswer}`
  shell.actionResult.data.stdout = JSON.stringify(parsed)
  const changedDigest = createHash('sha256').update(shell.actionResult.data.stdout).digest('hex')
  expected.currentDigest = changedDigest
  turn.ingress.prepared.ingress.resourceAdditionalContext[0].currentDigest = changedDigest
  turn.ingress.prepared.externalReadSlice.currentDigest = changedDigest
  turn.ingress.prepared.externalReadSlice.requiredMethod.expectedStdoutSha256 = changedDigest
  refreshReceiptDigest(shell)
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_lark_result_mismatch/)
})

test('rejects another scope body in every capture of the current turn', () => {
  const input = fixture()
  input.gatewayCapture[0].proofSentinels[1].occurrences = 1
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_gateway_capture_mismatch/)
})

test('rejects body leaks before the authorized read', () => {
  const input = fixture()
  input.gatewayCapture[0].proofSentinels[0].occurrences = 1
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_gateway_capture_mismatch/)
})

test('rejects current-document graft and non-thin resource references', () => {
  const anchor = fixture()
  anchor.evidence.turns[0].ingress.prepared.ingress.currentDocumentAnchor = { tabId: 'wrong' }
  assert.throws(() => assertE6LiveProofEvidence(anchor), /e6_resource_reference_missing/)

  const body = fixture()
  body.evidence.turns[0].ingress.prepared.ingress.resourceAdditionalContext[0].body = 'forbidden'
  assert.throws(() => assertE6LiveProofEvidence(body), /e6_resource_reference_not_thin/)
})

test('rejects incomplete action receipts and sidecar process leases', () => {
  const receiptMissing = fixture()
  receiptMissing.evidence.calls[0].actionReceiptId = null
  assert.throws(() => assertE6LiveProofEvidence(receiptMissing), /e6_tool_receipt_mismatch/)

  const processLive = fixture()
  processLive.evidence.sidecarLeases[0].treeZeroAt = null
  assert.throws(() => assertE6LiveProofEvidence(processLive), /e6_sidecar_lease_not_closed/)
})

test('binds every closed sidecar lease to the exact proof Main process', () => {
  const input = fixture()
  input.evidence.sidecarLeases[0].ownerMainPid += 1
  assert.throws(() => assertE6LiveProofEvidence(input), /e6_sidecar_lease_not_closed/)
})

test('binds every sidecar lease to the pinned runtime manifest and binary', () => {
  for (const key of ['runtimeManifestDigest', 'binarySha256', 'executablePath']) {
    const input = fixture()
    input.evidence.sidecarLeases[0][key] = key === 'executablePath' ? '/other/codex' : digest('0')
    assert.throws(() => assertE6LiveProofEvidence(input), /e6_sidecar_lease_not_closed/)
  }
})

test('binds every tool call and group receipt to the exact current turn', () => {
  for (const mutate of [
    (input) => { input.evidence.calls[0].readyRunId = 'alien-run' },
    (input) => { input.evidence.calls[0].codexTurnId = 'alien-turn' },
    (input) => { input.evidence.groups[0].gatewayRequestReceiptId = 'alien-receipt' },
    (input) => { input.evidence.calls[0].gatewayRequestReceiptId = 'alien-receipt' },
  ]) {
    const input = fixture()
    mutate(input)
    assert.throws(() => assertE6LiveProofEvidence(input), /e6_tool_receipt_ownership_mismatch/)
  }
})

test('rejects secret, mock, or unbound provider snapshot fields', () => {
  for (const mutate of [
    (input) => { input.evidence.providerSnapshots[0].snapshot.apiKey = 'sk-secret' },
    (input) => { input.evidence.providerSnapshots[0].snapshot.extraHeaders.Authorization = 'Bearer secret' },
    (input) => { input.evidence.providerSnapshots[0].snapshot.extraHeaders['X-Mock-Mode'] = 'fixture' },
    (input) => {
      input.evidence.providerSnapshots[0].snapshot.authHeader = 'X-Mock-Mode'
      input.evidence.providerSnapshots[0].snapshot.authPrefix = 'fixture '
    },
    (input) => { input.evidence.providerSnapshots[0].snapshot.mock = true },
    (input) => { input.evidence.providerSnapshots[0].credentialReferenceId = 'sk-secret' },
    (input) => { input.evidence.providerSnapshots[0].snapshot.retryPolicy.maxRetries = 0 },
    (input) => { input.evidence.providerSnapshots[0].snapshot.retryPolicy.maxRetries = 7 },
  ]) {
    const input = fixture()
    mutate(input)
    const row = input.evidence.providerSnapshots[0]
    row.snapshotDigest = sha256Canonical(row.snapshot)
    for (const thread of input.evidence.threads) thread.upstreamProfileSnapshotDigest = row.snapshotDigest
    for (const request of input.evidence.gatewayRequests) {
      request.upstreamProfileSnapshotDigest = row.snapshotDigest
    }
    assert.throws(() => assertE6LiveProofEvidence(input), /e6_provider_identity_mismatch/)
  }
})

test('requires completed, non-overlapping provider responses for every request', () => {
  const missing = fixture()
  missing.evidence.gatewayRequests[0].responseId = null
  assert.throws(() => assertE6LiveProofEvidence(missing), /e6_gateway_receipt_capture_mismatch/)

  const overlapping = fixture()
  overlapping.evidence.gatewayRequests[0].responseSequence =
    overlapping.evidence.gatewayRequests[1].requestSequence
  assert.throws(() => assertE6LiveProofEvidence(overlapping), /e6_gateway_receipt_capture_mismatch/)
})

test('requires Feishu 1-3 before Lark 1-3 across results and durable turns', () => {
  const reversedResults = fixture()
  reversedResults.results.reverse()
  assert.throws(() => assertE6LiveProofEvidence(reversedResults), /e6_run_order_mismatch/)

  const reversedTurns = fixture()
  reversedTurns.evidence.turns.reverse()
  assert.throws(() => assertE6LiveProofEvidence(reversedTurns), /e6_run_order_mismatch/)
})

test('requires unique native thread, turn, and Ready run identities for all six runs', () => {
  for (const mutate of [
    (input) => { input.evidence.threads[1].codexThreadId = input.evidence.threads[0].codexThreadId },
    (input) => { input.evidence.turns[1].codexTurnId = input.evidence.turns[0].codexTurnId },
    (input) => { input.evidence.turns[1].readyRunId = input.evidence.turns[0].readyRunId },
  ]) {
    const input = fixture()
    mutate(input)
    assert.throws(() => assertE6LiveProofEvidence(input), /e6_run_identity_not_unique/)
  }
})

test('rejects extra assistant or missing user messages in a proof scope', () => {
  const extraAssistant = fixture()
  extraAssistant.evidence.turns[0].assistantScopeMessageCount = 2
  assert.throws(() => assertE6LiveProofEvidence(extraAssistant), /e6_terminal_closeout_mismatch/)

  const missingUser = fixture()
  missingUser.evidence.turns[0].userScopeMessageCount = 0
  assert.throws(() => assertE6LiveProofEvidence(missingUser), /e6_terminal_closeout_mismatch/)
})

test('binds every Lark resource body and receipt to its frozen resource digest', () => {
  const mutateAndRefreshReceipt = (input, mutate) => {
    const reads = input.evidence.calls.filter((call) => call.toolName === 'skill_read_artifact')
      .slice(0, 3)
    mutate(reads)
    for (const call of reads) {
      refreshReceiptDigest(call)
    }
  }
  for (const mutate of [
    (reads) => { reads[0].actionResult.text = 'wrong-resource' },
    (reads) => {
      const first = reads[0].actionResult.text
      reads[0].actionResult.text = reads[1].actionResult.text
      reads[1].actionResult.text = first
    },
    (reads) => {
      reads[1].actionResult.text = reads[0].actionResult.text
      reads[2].actionResult.text = reads[0].actionResult.text
    },
  ]) {
    const input = fixture()
    mutateAndRefreshReceipt(input, mutate)
    assert.throws(() => assertE6LiveProofEvidence(input), /e6_lark_resource_result_mismatch/)
  }

  const forgedReceipt = fixture()
  forgedReceipt.evidence.calls[0].bindingResultDigest = digest('b')
  forgedReceipt.evidence.calls[0].actionResultDigest = digest('b')
  assert.throws(() => assertE6LiveProofEvidence(forgedReceipt), /e6_tool_receipt_mismatch/)
})
