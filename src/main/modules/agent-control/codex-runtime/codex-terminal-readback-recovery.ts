import type { CodexProductTurnRuntimeRead } from './codex-binding-repository'
import type { CodexNativeRuntime, CodexTurn } from './codex-native-runtime'
import {
  buildCodexProductReadbackCandidate,
} from './codex-product-boot-recovery'
import type { CodexTurnCollector, CoreTurnCandidate } from './codex-turn-collector'

/**
 * The runtime that owns this readback stopped. The interrupt stays unknown in storage and the next boot's recovery
 * resolves it from a fresh `thread/read`, so the wait ends instead of polling a detached runtime forever.
 */
export const CODEX_TERMINAL_READBACK_RUNTIME_STOPPED = 'codex_terminal_readback_runtime_stopped'

export async function recoverCodexTerminalAfterInterrupt(input: {
  runtime: Pick<CodexNativeRuntime, 'turnInterrupt' | 'threadRead' | 'subscribe'>
  collector: CodexTurnCollector
  product: CodexProductTurnRuntimeRead
  timedOutCandidate: CoreTurnCandidate
  acknowledgeInterrupt: () => void
  markInterruptUnknown: () => void
  /** False once the runtime is stopping or stopped; a crashed sidecar that is still recovering stays active. */
  isRuntimeActive: () => boolean
  wait?: () => Promise<void>
}): Promise<CoreTurnCandidate> {
  const threadId = input.product.codexThreadId
  const turnId = input.product.codexTurnId
  if (!threadId || !turnId || input.timedOutCandidate.codexThreadId !== threadId
    || input.timedOutCandidate.codexTurnId !== turnId) {
    input.markInterruptUnknown()
    throw new Error('codex_terminal_readback_identity_missing')
  }
  let terminal: CodexTurn | null = null
  let wake: (() => void) | null = null
  const unsubscribe = input.runtime.subscribe((notification) => {
    if (notification.method !== 'turn/completed'
      || notification.params.threadId !== threadId
      || notification.params.turn.id !== turnId
      || notification.params.turn.status === 'inProgress') return
    terminal = notification.params.turn
    wake?.()
  })
  let unknownMarked = false
  const markUnknownOnce = () => {
    if (unknownMarked) return
    unknownMarked = true
    input.markInterruptUnknown()
  }
  try {
    try {
      await input.runtime.turnInterrupt({ threadId, turnId })
      input.acknowledgeInterrupt()
    } catch {
      // silent-catch: a failed interrupt request is recorded via markUnknownOnce; terminal readback still proceeds
      markUnknownOnce()
    }
    while (!terminal) {
      if (!input.isRuntimeActive()) {
        markUnknownOnce()
        throw new Error(CODEX_TERMINAL_READBACK_RUNTIME_STOPPED)
      }
      try {
        const read = await input.runtime.threadRead({ threadId, includeTurns: true })
        if (read.thread.id !== threadId) throw new Error('codex_terminal_readback_thread_mismatch')
        const matches = read.thread.turns.filter((turn) => turn.id === turnId)
        if (matches.length !== 1) throw new Error('codex_terminal_readback_turn_ambiguous')
        if (matches[0].status !== 'inProgress') terminal = matches[0]
      } catch {
        // silent-catch: a failed or ambiguous thread readback is recorded via markUnknownOnce and retried after the wait
        markUnknownOnce()
      }
      if (terminal) break
      markUnknownOnce()
      await Promise.race([
        input.wait?.() || new Promise<void>((resolve) => setTimeout(resolve, 250)),
        new Promise<void>((resolve) => { wake = resolve }),
      ])
      wake = null
    }
  } finally {
    unsubscribe()
  }
  return buildCodexProductReadbackCandidate({
    collector: input.collector,
    product: input.product,
    turn: terminal as CodexTurn,
    recovery: 'terminal_timeout_interrupt_readback',
    sourceCandidate: input.timedOutCandidate,
  })
}
