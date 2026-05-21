/**
 * Bridge between the `skill_ask_user` handler (lives in tool dispatch) and
 * the IPC layer (lives in claude-bridge/ipc-handler.ts). The handler doesn't
 * want a direct `BrowserWindow` dependency — it would pull electron into the
 * tool module and make the primitive untestable under `tsx --test`. Instead,
 * the IPC setup code registers an emitter here at boot; the handler reads
 * the emitter via `getAskUserQuestionEmitter()`.
 *
 * When no emitter is registered (unit tests, headless boot, renderer not
 * ready yet), reads return a no-op and the handler proceeds anyway —
 * ephemeral questions still live in the store so a UI reconnect could
 * enumerate them via `store.list()`.
 */

import type { EmitAskUserQuestion } from '../../tools/skill-primitives/ask-user'

const noopEmitter: EmitAskUserQuestion = () => {}

let registeredEmitter: EmitAskUserQuestion = noopEmitter

export function registerAskUserQuestionEmitter(emitter: EmitAskUserQuestion | null): void {
  registeredEmitter = emitter || noopEmitter
}

export function getAskUserQuestionEmitter(): EmitAskUserQuestion {
  return registeredEmitter
}

// Exposed for tests that want to swap the emitter in-place and read events.
export function _resetAskUserBridgeForTests(): void {
  registeredEmitter = noopEmitter
}
