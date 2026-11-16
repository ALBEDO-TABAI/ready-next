import { createRotatingLogger } from '../../../utils/rotating-logger'
import type { CodexModelGatewayUpstreamFailureDiagnostic } from './codex-model-gateway-types'

const logger = createRotatingLogger('ready-directchat.log', { buffered: true })

function field(value: string | number | null): string {
  if (value === null) return '-'
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 300)
}

/** The provider's own words for a failed model request; the turn receipt keeps only the cause code. */
export function appendCodexUpstreamFailureLog(diagnostic: CodexModelGatewayUpstreamFailureDiagnostic): void {
  const parts = [
    '[gateway] upstream_failure',
    `run=${field(diagnostic.readyRunId)}`,
    `thread=${field(diagnostic.codexThreadId)}`,
    `turn=${field(diagnostic.codexTurnId)}`,
    `profile=${field(diagnostic.profileId)}`,
    `model=${field(diagnostic.model)}`,
    `cause=${field(diagnostic.causeCode)}`,
    `stage=${field(diagnostic.failureStage)}`,
    `elapsedMs=${Math.round(diagnostic.elapsedMs)}`,
    `retries=${diagnostic.retriesUsed}`,
    `upstreamRequestId=${field(diagnostic.upstreamRequestId)}`,
    `providerCode=${field(diagnostic.providerError?.code ?? null)}`,
    `providerType=${field(diagnostic.providerError?.type ?? null)}`,
    `providerMessage=${JSON.stringify(field(diagnostic.providerError?.message ?? null))}`,
  ]
  try {
    logger.append(`[${new Date().toISOString()}] ${parts.join(' ')}\n`)
  } catch {
    // silent-catch: the diagnostic log write is best-effort and must not fail the model request path
    /* best-effort */
  }
}

/** A model request Ready's own gateway refused: the code names the check, and no provider was contacted for it. */
export function appendCodexGatewayRefusalLog(refusal: { code: string; status: number }): void {
  try {
    logger.append(`[${new Date().toISOString()}] [gateway] request_refused code=${field(refusal.code)} status=${refusal.status}\n`)
  } catch {
    // silent-catch: the diagnostic log write is best-effort and must not fail the model request path
    /* best-effort */
  }
}
