import { createRotatingLogger } from '../../../utils/rotating-logger'
import type {
  CodexModelGatewayResponseEventNote,
  CodexModelGatewayUpstreamFailureDiagnostic,
} from './codex-model-gateway-types'

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

/** A provider-chosen name is logged only when it looks like one; anything else could be content. */
function name(value: string): string {
  return /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : '(unprintable)'
}

/** Which response event Ready left out or stopped at. Names only: an event's content never reaches this log. */
export function appendCodexGatewayResponseEventLog(note: CodexModelGatewayResponseEventNote): void {
  const keys = note.keys.slice(0, 24).map(name).join(',') || '-'
  try {
    logger.append(
      `[${new Date().toISOString()}] [gateway] response_event_${note.kind} type=${name(note.eventType)}`
      + ` code=${field(note.code)} keys=${keys}\n`,
    )
  } catch {
    // silent-catch: the diagnostic log write is best-effort and must not fail the model request path
    /* best-effort */
  }
}
