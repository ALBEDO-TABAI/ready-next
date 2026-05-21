/**
 * Bridge between the `ask_user_questions` handler (lives in tool dispatch)
 * and electron-coupled layers — IPC push (claude-bridge/ipc-handler) and DB
 * persistence (database / chat-repository).
 *
 * The handler stays transport- and storage-agnostic: it reads emitter +
 * persistor from this module, both default to no-op so unit tests under
 * `tsx --test` work without electron / sqlite. Production wires both at
 * `setupAgentIPC` boot.
 *
 * Mirrors `ask-user-bridge.ts` for the skill_ask_user primitive, with two
 * separate slots because `ask_user_questions` has an additional persistence
 * responsibility the skill primitive doesn't (it's not ephemeral — the
 * answered card stays in chat_messages permanently).
 */

import type {
  EmitAskUserQuestionsCard,
  PersistAskUserQuestionsCardPending,
} from '../tools/builtins/ask-user-questions'

const noopEmitter: EmitAskUserQuestionsCard = () => {}
const noopPersist: PersistAskUserQuestionsCardPending = () => {}

let registeredEmitter: EmitAskUserQuestionsCard = noopEmitter
let registeredPersist: PersistAskUserQuestionsCardPending = noopPersist

export function registerAskUserQuestionsCardEmitter(
  emitter: EmitAskUserQuestionsCard | null,
): void {
  registeredEmitter = emitter || noopEmitter
}

export function getAskUserQuestionsCardEmitter(): EmitAskUserQuestionsCard {
  return registeredEmitter
}

export function registerAskUserQuestionsCardPersistor(
  persist: PersistAskUserQuestionsCardPending | null,
): void {
  registeredPersist = persist || noopPersist
}

export function getAskUserQuestionsCardPersistor(): PersistAskUserQuestionsCardPending {
  return registeredPersist
}

/** Test helper — swap both slots back to no-op. */
export function _resetAskUserQuestionsBridgeForTests(): void {
  registeredEmitter = noopEmitter
  registeredPersist = noopPersist
}
