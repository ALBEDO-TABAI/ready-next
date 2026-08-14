import { digestCanonicalJson } from './codex-model-gateway-contract'

export type CodexProductEffectIdentityInput = Readonly<{
  readyRunId: string
  scopeId: string
  messageVisibilityEpoch: number
  codexThreadId: string
  codexTurnId: string
  codexCallId: string
  readyActionId: string
  executingToolName: string
  action: string
  actionOrdinal: number
  argsDigest: string
}>

export function buildCodexProductEffectIdentity(input: CodexProductEffectIdentityInput): Readonly<{
  effectIdentityDigest: string
  effectActionId: string
}> {
  const effectIdentityDigest = digestCanonicalJson({
    readyRunId: input.readyRunId,
    scopeId: input.scopeId,
    messageVisibilityEpoch: input.messageVisibilityEpoch,
    codexThreadId: input.codexThreadId,
    codexTurnId: input.codexTurnId,
    codexCallId: input.codexCallId,
    readyActionId: input.readyActionId,
    tool: input.executingToolName,
    action: input.action,
    actionOrdinal: input.actionOrdinal,
    argsDigest: input.argsDigest,
  })
  return {
    effectIdentityDigest,
    effectActionId: `codex-product-effect-${effectIdentityDigest}`,
  }
}

export function digestProductActionArgs(args: Record<string, unknown>): string {
  return digestCanonicalJson(args)
}
