import { digestCanonicalJson } from './codex-model-gateway-contract'

export type CodexToolResponseDeliveryAttemptIdentity = Readonly<{
  attemptId: string
  codexThreadId: string
  codexTurnId: string
  codexCallId: string
  readyActionId: string
  connectionEpoch: string
  requestRpcId: string
  toolResponseDigest: string
}>

export type CodexToolResponseDeliveryAttemptRead = (
  CodexToolResponseDeliveryAttemptIdentity
  & Readonly<{
    toolResponse: unknown
    transportWriteConfirmedAt: string | null
    createdAt: string
  }>
)

export type CodexServerRequestResponse = Readonly<{
  result: unknown
  deliveryAttempt: CodexToolResponseDeliveryAttemptIdentity
}>

export function buildCodexToolResponseDeliveryAttemptId(
  input: Omit<CodexToolResponseDeliveryAttemptIdentity, 'attemptId'>,
): string {
  return `codex-tool-delivery-${digestCanonicalJson(input)}`
}
