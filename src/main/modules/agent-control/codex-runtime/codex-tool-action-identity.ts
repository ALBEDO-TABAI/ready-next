import { digestCanonicalJson } from './codex-model-gateway-contract'

export type CodexToolActionIdentityInput = Readonly<{
  readyAliasId: string
  codexSessionId: string
  codexThreadId: string
  codexTurnId: string
  codexCallId: string
  readyTaskId: string
  readyRunId: string
  toolName: string
  argsDigest: string
  turnContractDigest: string
  surfaceSnapshotDigest: string
  authorizationSnapshotDigest: string
  toolSchemaDigest: string
}>

export function buildCodexToolActionIdentity(input: CodexToolActionIdentityInput): Readonly<{
  actionIdentityDigest: string
  readyActionId: string
}> {
  const actionIdentityDigest = digestCanonicalJson({
    readyAliasId: input.readyAliasId,
    codexSessionId: input.codexSessionId,
    codexThreadId: input.codexThreadId,
    codexTurnId: input.codexTurnId,
    callId: input.codexCallId,
    readyTaskId: input.readyTaskId,
    readyRunId: input.readyRunId,
    toolName: input.toolName,
    argsDigest: input.argsDigest,
    turnContractDigest: input.turnContractDigest,
    surfaceSnapshotDigest: input.surfaceSnapshotDigest,
    authorizationSnapshotDigest: input.authorizationSnapshotDigest,
    schemaDigest: input.toolSchemaDigest,
  })
  return {
    actionIdentityDigest,
    readyActionId: `codex-action-${actionIdentityDigest}`,
  }
}
