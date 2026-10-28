import type { CodexRuntimeComposition } from '../../main/modules/agent-control/codex-runtime/codex-runtime-composition'
import { CodexProductRunPreparer } from '../../main/modules/agent-control/codex-runtime/codex-product-run-preparer'
import { createActionSurfaceReader } from '../../main/modules/agent-control/codex-runtime/composition/action-surface'
import { createAliasPorts } from '../../main/modules/agent-control/codex-runtime/composition/alias-ports'
import {
  createActionSurfaceInvalidationPublisher,
  createPreparedReservationRelease,
} from '../../main/modules/agent-control/codex-runtime/composition/base'
import { createBeginNewContextIssuer } from '../../main/modules/agent-control/codex-runtime/composition/begin-new-context'
import { createHeadContinuation } from '../../main/modules/agent-control/codex-runtime/composition/head-continuation'
import { createIngressPort } from '../../main/modules/agent-control/codex-runtime/composition/ingress-port'
import { createIngressPrepare } from '../../main/modules/agent-control/codex-runtime/composition/ingress-prepare'
import { createCodexCompositionLive } from '../../main/modules/agent-control/codex-runtime/composition/live-state'
import { clearLastReferenceSkill } from '../../main/modules/agent-control/skills/skill-reference-hints'
import type { CodexActionSurfaceEnvelope } from '../../shared/ipc-contracts/agent-runtime'

/**
 * Builds the production `ingressPort` / `startIdentityPort` / `aliasBindingPort` / `readActionSurface` from the same
 * composition factories `createCodexRuntimeComposition` uses, over caller-supplied dependencies. Callers may pass a
 * stub repository (isolated port behaviour) or a real `CodexBindingRepository` (production prepare joined to real
 * admission).
 *
 * A dependency the caller names replaces the production part of that name: a composition part (for example
 * `resolveHeadContinuation` or `issueBeginNewContextAction`), a base value (`repository`, `input`, `preparedDetails`),
 * or a field of the shared runtime state (`host`, `state`, `registry`). Everything else is the production code.
 */
export type CodexProductionPorts = Pick<CodexRuntimeComposition, 'ingressPort' | 'startIdentityPort' | 'aliasBindingPort'> & {
  readActionSurface: (input: { aliasId: string; aliasGeneration: number; workbenchMode?: 'browser' | 'document' | 'rss' | 'calendar' }) => CodexActionSurfaceEnvelope
}

// In the order `createCodexRuntimeComposition` creates them.
const PORT_FACTORIES = [
  createPreparedReservationRelease,
  createActionSurfaceInvalidationPublisher,
  createHeadContinuation,
  createBeginNewContextIssuer,
  createActionSurfaceReader,
  createAliasPorts,
  createIngressPrepare,
  createIngressPort,
] as Array<(deps: never) => object>

export async function createCodexProductionPorts(
  dependencies: Record<string, unknown>,
): Promise<CodexProductionPorts> {
  const live = createCodexCompositionLive() as unknown as Record<string, unknown>
  for (const [name, value] of Object.entries(dependencies)) {
    if (Object.hasOwn(live, name)) live[name] = value
  }
  let scope: Record<string, unknown> = {
    preparer: new CodexProductRunPreparer(),
    preparedDetails: new Map(),
    detailPrepared: new Map(),
    clearLastReferenceSkill,
    ...dependencies,
    live,
  }
  for (const factory of PORT_FACTORIES) {
    scope = { ...scope, ...factory(scope as never), ...dependencies, live }
  }
  const { ingressPort, startIdentityPort, aliasBindingPort, readActionSurface } = scope as CodexProductionPorts
  return { ingressPort, startIdentityPort, aliasBindingPort, readActionSurface }
}
