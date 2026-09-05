import { createHash } from 'node:crypto'
import { evaluateCdp, sqlQuote, sqliteJson } from './live-proof-runtime.mjs'
import { READY_BROWSER_BLANK_URL } from '../../src/shared/browser-defaults.ts'

export const freshRootCases = [
  { label: 'F01', workbenchMode: 'document', policy: 'untrusted_text_history', delivered: true },
  { label: 'F02', workbenchMode: 'browser', policy: 'resource_restatement_required', delivered: false },
]
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex')

export function assertFreshRootProviderCaptures(captures, proofs) {
  const fresh = captures.filter((capture) => capture.kind?.startsWith('fresh_root_'))
  if (fresh.some((capture) => !freshRootCases.some((scenario) => scenario.label === capture.label))) {
    throw new Error('unexpected fresh-root capture identity')
  }
  for (const { label } of freshRootCases) {
    const proof = proofs.find((item) => item.label === label)
    const rows = fresh.filter((capture) => capture.label === label)
    const failures = rows.filter((capture) => capture.kind === 'fresh_root_failure')
    if (!proof || proof.failedLogicalTurns !== 1 || proof.failedGatewayRequests !== 1
      || !Number.isSafeInteger(proof.frozenRetryLimit) || proof.frozenRetryLimit < 0
      || proof.failedProviderAttempts !== proof.frozenRetryLimit + 1
      || failures.length !== proof.failedProviderAttempts
      || failures.some((capture) => capture.round !== 1 || capture.stage !== 'provider_failure_injected')
      || rows.filter((capture) => capture.kind === 'fresh_root_recovery' && capture.round === 2).length !== 1
      || rows.filter((capture) => capture.kind === 'fresh_root_continuation' && capture.round === 3).length !== 1
      || rows.length !== failures.length + 2) throw new Error(`fresh-root capture/readback mismatch: ${label}`)
  }
  return fresh.length
}

// All writes use the installed product UI/IPC. SQL only inspects what that
// product actually committed; the model requests come from the real runtime.
export async function runFreshRootInstalledProof({ getCdp, restart, databasePath, captures, proofId, logPhase }) {
  const memory = await evaluateCdp(getCdp(), `window.electronAPI.agent.setReadyMemoryGlobalPolicy({ useMemories: false, generateMemories: false })`)
  if (!memory?.success || memory.data?.useMemories !== false) throw new Error('isolated memory policy did not settle')
  const readHead = (aliasId) => {
    const row = sqliteJson(databasePath, `SELECT thread_binding_id, alias_generation, codex_thread_id,
        thread_materialization_kind, uncommitted_user_tail_json, history_source_thread_binding_id
      FROM codex_thread_bindings WHERE ready_conversation_alias = ${sqlQuote(aliasId)} AND retired_at IS NULL;`)[0]
    if (!row) throw new Error('fresh-root active head missing')
    return row
  }
  const results = []
  for (const scenario of freshRootCases) {
    logPhase(`${scenario.label}: real first-turn failure (${scenario.policy})`)
    const divergence = await runFreshRootTurn(getCdp(), { ...scenario, proofId, round: 1 })
    if (!divergence.aliasId) throw new Error(`fresh-root first turn did not start: ${JSON.stringify(divergence)}`)
    const head = readHead(divergence.aliasId)
    const source = sqliteJson(databasePath, `SELECT retired_reason FROM codex_thread_bindings
      WHERE thread_binding_id = ${sqlQuote(head.history_source_thread_binding_id)};`)[0]
    const tail = JSON.parse(head.uncommitted_user_tail_json || 'null')
    if (head.thread_materialization_kind !== 'fresh_root_with_tail' || source?.retired_reason !== 'publication_diverged'
      || !Array.isArray(tail) || tail.length !== 1 || tail[0].policy !== scenario.policy
      || !JSON.stringify(tail[0].input).includes(`READY_HISTORY_${scenario.label}_R1_${proofId}`)) {
      throw new Error(`fresh-root source is not the intended case: ${JSON.stringify({ label: scenario.label, policies: tail?.map((item) => item.policy) })}`)
    }
    const failedTurns = sqliteJson(databasePath, `SELECT ready_run_id FROM codex_turn_bindings
      WHERE thread_binding_id = ${sqlQuote(head.history_source_thread_binding_id)};`)
    if (failedTurns.length !== 1) throw new Error('fresh-root source must contain exactly one failed logical turn')
    const failedGatewayRequests = sqliteJson(databasePath, `SELECT profile.snapshot_json
      FROM ready_model_gateway_request_receipts request
      JOIN ready_model_gateway_profile_snapshots profile ON profile.snapshot_ref = request.upstream_profile_snapshot_ref
      WHERE request.ready_run_id = ${sqlQuote(failedTurns[0].ready_run_id)};`)
    if (failedGatewayRequests.length !== 1) throw new Error('fresh-root source must use one admitted gateway request')
    const frozenRetryLimit = JSON.parse(failedGatewayRequests[0].snapshot_json).retryPolicy.maxRetries
    const failures = captures.filter((capture) => capture.label === scenario.label && capture.round === 1)
    const failedProviderAttempts = failures.length
    if (!Number.isSafeInteger(frozenRetryLimit) || frozenRetryLimit < 0 || failures.length !== frozenRetryLimit + 1
      || failures.some((capture) => capture.stage !== 'provider_failure_injected')) {
      throw new Error('fresh-root failed provider attempts do not match the single persisted source turn')
    }
    const turns = []
    let nativeThreadId = null
    for (const round of [2, 3]) {
      await restart()
      logPhase(`${scenario.label}: round ${round} after restart`)
      const result = await runFreshRootTurn(getCdp(), { ...scenario, proofId, round, aliasId: divergence.aliasId })
      const currentHead = readHead(divergence.aliasId)
      const capture = captures.find((item) => item.label === scenario.label && item.round === round)
      const priorCount = capture?.priorMarkerCounts[`${scenario.label}:R1`] || 0
      if (!result.ok || currentHead.alias_generation !== head.alias_generation || !currentHead.codex_thread_id
        || (nativeThreadId !== null && currentHead.codex_thread_id !== nativeThreadId)
        || priorCount !== (scenario.delivered ? 1 : 0) || capture?.currentMarkerCount !== 1
        || capture?.nonInputMarkerHits.length || (round === 3 && capture?.priorMarkerCounts[`${scenario.label}:R2`] !== 1)) {
        throw new Error(`fresh-root model/terminal/next-action mismatch: ${JSON.stringify({ label: scenario.label, round, result, capture })}`)
      }
      nativeThreadId = currentHead.codex_thread_id
      const stored = sqliteJson(databasePath, `SELECT ingress_json FROM codex_turn_bindings
        WHERE thread_binding_id = ${sqlQuote(currentHead.thread_binding_id)} ORDER BY rowid DESC LIMIT 1;`)[0]
      const assignments = JSON.parse(stored.ingress_json).prepared.ingress.uncommittedTailAssignments
      if (round === 2 && (assignments.length !== 1 || assignments[0].plan !== (
        scenario.delivered ? 'deliver_untrusted_history' : 'omit_from_current_run'
      ))) throw new Error('fresh-root assignment did not match the actual provider delivery')
      if (round === 3 && assignments.length !== 0) throw new Error('fresh-root settled tail was assigned again')
      turns.push({ round, terminal: result.disposition, nextSend: result.nextSend, currentInputCount: capture.currentMarkerCount, inheritedInputCount: priorCount })
    }
    results.push({
      label: scenario.label, sourcePolicy: scenario.policy,
      failedLogicalTurns: failedTurns.length, failedGatewayRequests: failedGatewayRequests.length,
      frozenRetryLimit, failedProviderAttempts,
      producedBy: 'real_first_turn_failure_closeout', sourceRetirement: source.retired_reason,
      scopeIdDigest: sha256(divergence.aliasId), nativeThreadDigest: sha256(nativeThreadId),
      tailDelivery: scenario.delivered ? 'untrusted_text_once' : 'resource_tail_omitted',
      sameNativeThreadAfterRecoveryAndRestart: true, turns,
    })
  }
  return results
}

export async function runFreshRootTurn(cdp, { label, proofId, round, aliasId = null, workbenchMode, delivered }) {
  return evaluateCdp(cdp, `(async () => {
    const harness = window.__READY_AGENT_TEST__;
    let aliasId = ${JSON.stringify(aliasId)};
    if (!aliasId) {
      aliasId = (await harness.createSession()).currentScopeId;
      if (!aliasId) return { ok: false, stage: 'create_session' };
    } else {
      const session = harness.sessionSummary().sessions.find((item) => item.conversationId === aliasId);
      if (!session || !(await harness.activateSession(session.id)).ok) return { ok: false, stage: 'activate' };
    }
    const workbenchMode = ${JSON.stringify(workbenchMode)};
    if (!(await harness.setWorkbenchMode(workbenchMode)).ok) return { ok: false, stage: 'workbench_mode' };
    const delivered = ${JSON.stringify(delivered)};
    if (delivered === false) {
      const tab = await window.electronAPI.browser.createTab(${JSON.stringify(READY_BROWSER_BLANK_URL)});
      if (!tab.success || !tab.tabId) return { ok: false, stage: 'resource_tab_missing', error: tab.error || null };
    }
    let surface = null;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const scopes = await window.electronAPI.agent.listConversationScopes();
      const scope = scopes.data?.find((item) => item.id === aliasId);
      if (Number.isSafeInteger(scope?.aliasGeneration)) {
        const read = await window.electronAPI.agent.readCodexActionSurface({ aliasId, aliasGeneration: scope.aliasGeneration, workbenchMode });
        if (read.success && read.data?.head?.actions?.send_new_message?.availability === 'ready') { surface = read.data; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!surface) return { ok: false, stage: 'head_not_ready', aliasId };
    const round = ${round};
    const marker = ${JSON.stringify(`READY_HISTORY_${label}_R${round}_${proofId}`)};
    const sent = await harness.submit(marker, {
      mode: 'store', awaitStoreSend: true, waitForIdle: true,
      timeoutMs: 180000, attachments: [], requireAssistantMessage: ${aliasId !== null || round !== 1},
    });
    if (round === 1 && ${aliasId === null}) return { aliasId, disposition: sent.sendResult?.disposition || null };
    const visible = [...sent.after.messages].reverse().find((message) => message.type === 'agent'
      && message.content.includes(${JSON.stringify(`READY_HISTORY_OK_${label}_R${round}`)}));
    const next = await window.electronAPI.agent.readCodexActionSurface({
      aliasId, aliasGeneration: surface.head.actionHeadIdentity.aliasGeneration, workbenchMode,
    });
    const nextSend = next.data?.head?.actions?.send_new_message?.availability;
    return {
      aliasId, ok: sent.sendResult?.disposition === 'terminal_success' && visible?.terminalReason === 'done' && nextSend === 'ready',
      disposition: sent.sendResult?.disposition || null, nextSend: nextSend || null,
    };
  })()`, 600_000)
}
