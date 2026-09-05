export type ComposerSendBlocker =
  | 'closed'
  | 'head_unavailable'
  | 'thread_busy'
  | 'runtime_unverified'
  | 'runtime_unsupported'
  | 'model_changed'
  | 'thread_config_changed'
  | 'cwd_unavailable'
  | 'cwd_changed'
  | 'instruction_contract_changed'
  | 'native_tool_surface_extension_required'
  | 'native_tool_definition_changed'
  | 'ready_tool_execution_contract_changed'
  | 'history_only'
  | 'authorization_mode_updating'
  | string

export type ComposerState = Readonly<{
  editable: boolean
  sendEnabled: boolean
  blocker: ComposerSendBlocker | null
  exactStopIntentAvailable: boolean
}>

export function deriveComposerState(input: {
  hasSendableContent: boolean
  sendAvailability: 'ready' | 'blocked' | 'not_applicable'
  blocker: ComposerSendBlocker | null
  authorizationModeUpdating: boolean
  destructiveOperationPending: boolean
  exactStopIntentAvailable: boolean
}): ComposerState {
  const blocker = input.authorizationModeUpdating
    ? 'authorization_mode_updating'
    : input.sendAvailability === 'ready'
      ? null
      : input.blocker || 'head_unavailable'
  return {
    editable: !input.destructiveOperationPending,
    sendEnabled: !input.destructiveOperationPending
      && !input.authorizationModeUpdating
      && input.sendAvailability === 'ready'
      && input.hasSendableContent,
    blocker,
    exactStopIntentAvailable: input.exactStopIntentAvailable,
  }
}

/**
 * Reads the composer authority a mounted ChatInput publishes on its shell.
 * A shell without the dataset (stripped harness DOM) reports no authority rather
 * than throwing, and callers never re-derive composer state from store fields.
 */
export function readComposerAuthorityFromDom(
  shell: { dataset?: DOMStringMap } | null | undefined,
): { editable: boolean; sendEnabled: boolean; blocker: string | null } | undefined {
  const data = shell?.dataset
  if (typeof data?.readyComposerEditable !== 'string'
    || typeof data.readyComposerSendEnabled !== 'string') return undefined
  return {
    editable: data.readyComposerEditable === 'true',
    sendEnabled: data.readyComposerSendEnabled === 'true',
    blocker: data.readyComposerBlocker || null,
  }
}
