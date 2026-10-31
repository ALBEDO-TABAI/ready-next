import { isLibraryReadTool } from './library-read-tools'
import { CodexToolBridgeError } from './codex-tool-bridge'
import type { ReadyToolActionReceiptPort } from './codex-tool-action-journal'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import { isAllowedProductAction } from './codex-product-action-map'
import {
  buildCodexProductEffectIdentity,
  digestProductActionArgs,
} from './codex-product-effect-identity'

export class CodexProductActionError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexProductActionError'
  }
}

export type CodexProductActionHandlers = {
  dispatch(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>>
}

export function createCodexProductActionRequester(input: {
  executingToolName: string
  allowedToolNames: readonly string[]
  readyRunId: string
  scopeId: string
  messageVisibilityEpoch: number
  codexThreadId: string
  codexTurnId: string
  codexCallId: string
  readyActionId: string
  actionIdentityDigest: string
  abortSignal: AbortSignal
  journal: ReadyToolActionReceiptPort
  now?: () => string
  assertEffectAuthority: () => void
  handlers: CodexProductActionHandlers
}): (action: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  let nextOrdinal = 0
  return async (action, args) => {
    input.assertEffectAuthority()
    if (input.abortSignal.aborted) {
      throw new CodexProductActionError('product_action_aborted')
    }
    if (!input.allowedToolNames.includes(input.executingToolName)) {
      throw new CodexProductActionError('product_action_tool_not_in_allow_set')
    }
    if (!isAllowedProductAction(input.executingToolName, action)) {
      throw new CodexProductActionError('product_action_tool_mismatch')
    }
    // Read snapshots have no external effect to commit or replay. Revalidate on every call.
    if (isLibraryReadTool(input.executingToolName)) {
      const payload = await input.handlers.dispatch(action, args)
      input.assertEffectAuthority()
      if (input.abortSignal.aborted) throw new CodexProductActionError('product_action_aborted')
      return normalizeProductPayload(action, payload)
    }
    const actionOrdinal = nextOrdinal
    nextOrdinal += 1
    const argsDigest = digestProductActionArgs(args)
    const { effectActionId, effectIdentityDigest } = buildCodexProductEffectIdentity({
      readyRunId: input.readyRunId,
      scopeId: input.scopeId,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
      codexThreadId: input.codexThreadId,
      codexTurnId: input.codexTurnId,
      codexCallId: input.codexCallId,
      readyActionId: input.readyActionId,
      executingToolName: input.executingToolName,
      action,
      actionOrdinal,
      argsDigest,
    })
    const at = (input.now || (() => new Date().toISOString()))()
    const began = await input.journal.beginBoundProductEffect({
      effectActionId,
      actionIdentityDigest: effectIdentityDigest,
      readyRunId: input.readyRunId,
      readyScopeId: input.scopeId,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
      codexThreadId: input.codexThreadId,
      codexTurnId: input.codexTurnId,
      codexCallId: input.codexCallId,
      parentReadyActionId: input.readyActionId,
      toolName: input.executingToolName,
      productAction: action,
      actionOrdinal,
      argsDigest,
      at,
    })
    if (!began.fresh) {
      const prior = await input.journal.read(effectActionId)
      if (prior.state === 'confirmed') {
        const replayed = prior.output.data
        if (!replayed || typeof replayed !== 'object' || Array.isArray(replayed)) {
          throw new CodexProductActionError('product_action_replay_invalid')
        }
        return { ...replayed, replayed: true }
      }
      return {
        ok: false,
        errorKind: prior.state === 'proven_absent'
          ? 'product_action_rejected'
          : 'product_action_unknown',
        summary: prior.state === 'proven_absent'
          ? '产品动作已被证明未执行。'
          : '产品动作结果未知，不能自动重试。',
        effectActionId,
      }
    }

    let dispatched = false
    try {
      input.assertEffectAuthority()
      if (input.abortSignal.aborted) {
        input.journal.markProvenAbsent({
          readyActionId: effectActionId,
          actionIdentityDigest: effectIdentityDigest,
          reason: 'aborted_before_dispatch',
          evidenceDigest: digestCanonicalJson({ effectActionId, reason: 'aborted_before_dispatch' }),
          at: (input.now || (() => new Date().toISOString()))(),
        })
        throw new CodexProductActionError('product_action_aborted')
      }
      dispatched = true
      let payload: Record<string, unknown>
      try {
        payload = await input.handlers.dispatch(action, args)
      } catch (error) {
        if (error instanceof CodexProductActionError) {
          try {
            input.journal.markProvenAbsent({
              readyActionId: effectActionId,
              actionIdentityDigest: effectIdentityDigest,
              reason: error.code,
              evidenceDigest: digestCanonicalJson({
                effectActionId,
                reason: error.message,
              }),
              at: (input.now || (() => new Date().toISOString()))(),
            })
          } catch {
            // silent-catch: the receipt may already be resolved (CAS miss); the product action error is rethrown below and closeout settles any pending receipt
          }
          throw error
        }
        markUnknown(input, effectActionId, effectIdentityDigest, error)
        return {
          ok: false,
          errorKind: 'product_action_unknown',
          summary: '产品动作结果未知，不能自动重试。',
          effectActionId,
        }
      }
      try {
        input.assertEffectAuthority()
      } catch (error) {
        // silent-catch: authority lost after dispatch makes the outcome unknown; it is journaled indeterminate and returned as product_action_unknown
        markUnknown(input, effectActionId, effectIdentityDigest, error)
        return {
          ok: false,
          errorKind: 'product_action_unknown',
          summary: '产品动作结果未知，不能自动重试。',
          effectActionId,
        }
      }
      const normalized = normalizeProductPayload(action, payload)
      await input.journal.commit({
        readyActionId: effectActionId,
        actionIdentityDigest: effectIdentityDigest,
        resultDigest: digestCanonicalJson(asJournalOutput(normalized)),
        output: asJournalOutput(normalized),
        at: (input.now || (() => new Date().toISOString()))(),
      })
      return { ...normalized, effectActionId }
    } catch (error) {
      if (error instanceof CodexProductActionError) throw error
      if (!dispatched && error instanceof CodexToolBridgeError) {
        try {
          input.journal.markProvenAbsent({
            readyActionId: effectActionId,
            actionIdentityDigest: effectIdentityDigest,
            reason: error.code,
            evidenceDigest: digestCanonicalJson({
              effectActionId,
              reason: error instanceof Error ? error.message : String(error),
            }),
            at: (input.now || (() => new Date().toISOString()))(),
          })
        } catch {
          // silent-catch: the receipt may already be resolved (CAS miss); the bridge error is rethrown below and closeout settles any pending receipt
        }
        throw error
      }
      markUnknown(input, effectActionId, effectIdentityDigest, error)
      return {
        ok: false,
        errorKind: 'product_action_unknown',
        summary: '产品动作结果未知，不能自动重试。',
        effectActionId,
      }
    }
  }
}

function markUnknown(
  input: {
    journal: ReadyToolActionReceiptPort
    now?: () => string
  },
  effectActionId: string,
  effectIdentityDigest: string,
  error: unknown,
): void {
  try {
    input.journal.markIndeterminate({
      readyActionId: effectActionId,
      actionIdentityDigest: effectIdentityDigest,
      reason: 'product_action_result_unknown',
      evidenceDigest: digestCanonicalJson({
        effectActionId,
        reason: error instanceof Error ? error.message : String(error),
      }),
      at: (input.now || (() => new Date().toISOString()))(),
    })
  } catch {
    // silent-catch: the receipt may already be resolved (CAS miss); callers still return product_action_unknown and closeout settles any pending receipt
  }
}

function normalizeProductPayload(
  action: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.ok === false) {
    return {
      ...payload,
      ok: false,
      errorKind: typeof payload.errorKind === 'string' ? payload.errorKind : 'product_action_failed',
      summary: typeof payload.summary === 'string' && payload.summary.trim()
        ? payload.summary
        : `${action} 失败`,
    }
  }
  return {
    ...payload,
    ok: payload.ok === undefined ? true : payload.ok,
    summary: typeof payload.summary === 'string' && payload.summary.trim()
      ? payload.summary
      : `${action} 已完成。`,
  }
}

function asJournalOutput(payload: Record<string, unknown>) {
  return {
    text: typeof payload.summary === 'string' ? payload.summary : '',
    shape: 'json' as const,
    data: payload,
    projectionPatch: null,
    interactionHint: null,
    framePatch: null,
  }
}
