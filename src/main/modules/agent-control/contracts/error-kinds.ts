/**
 * Stage U (PR 1) — central registry of `errorKind` string literals used by
 * domain tool handlers in the `agent_interaction` group (ask_user_questions)
 * and provider request paths.
 *
 * Distinct from `tool-error-metrics.ts`:
 *   - `TOOL_ERROR_METRICS` is the registry of **metric names**
 *     (snake_case strings passed to `logAgentMetric`).
 *   - This file is the registry of **errorKind values**
 *     (snake_case strings passed as `ToolDomainError`'s first arg /
 *     `ToolExecutionOutput.errorKind`). They feed the dispatch contract
 *     (§6.11) and the renderer's `agent:error` IPC envelope.
 *
 * Why they are separate:
 *   - A single errorKind may emit zero, one, or several metrics depending
 *     on the path it surfaces through.
 *   - A metric may be emitted from non-error sites too (e.g. a success-side
 *     counter), so it cannot be modeled as "the errorKind that triggered me".
 *
 * Each entry carries:
 *   - `code` (the string literal — KEEP STABLE across renames)
 *   - `metricName?` — when present, the matching `TOOL_ERROR_METRICS.<key>`
 *     value (the snake_case metric string) so the CI gate
 *     `check-ask-user-error-kinds-registered.cjs` can verify mapping.
 *   - `noMetric?: true` — when set, declares the errorKind intentionally
 *     does not emit a metric (e.g. terminal abort already counted elsewhere).
 *     The gate accepts either `metricName` or `noMetric: true` — but never
 *     both, and never neither.
 *
 * Anything thrown from `ask_user_questions` / cancel handler / provider
 * adapter that lands as an `errorKind` MUST be listed here. The gate scans
 * the source files in `scripts/check-ask-user-error-kinds-registered.cjs`
 * and fails CI if a literal slips through.
 */

export interface ErrorKindMeta {
  readonly code: string
  readonly metricName?: string
  readonly noMetric?: true
  readonly description: string
}

// ---------- ask_user_questions ----------

export const ASK_USER_ERROR_KINDS = {
  /** Server-side re-validation of submitted answers failed (missing required,
   *  single_choice answer outside options, etc.). Thrown from submit IPC. */
  inputValidation: {
    code: 'input_validation',
    noMetric: true,
    description: 'submit IPC reject — answers did not pass server-side schema/business validation',
  },
  /** Generic persistence failure: DB throw (e.g. SQLITE_BUSY) during update
   *  or insert. recoverable=true on the IPC envelope; caller may retry. */
  persistenceFailed: {
    code: 'persistence_failed',
    metricName: 'ask_user_questions_submit_db_failed',
    description: 'DB write threw (transient). In-memory pending preserved; user may retry.',
  },
  /** `updateChatMessageMeta` returned false → the card row no longer exists
   *  (already swept / never persisted). The in-memory Promise MUST be
   *  rejected so the tool handler stops awaiting; renderer marks the card
   *  locally as cancelled(card_row_missing). */
  waitingTaskGone: {
    code: 'waiting_task_gone',
    metricName: 'ask_user_questions_submit_db_failed',
    description: 'DB row missing or session already gone — in-memory Promise terminated, card locally cancelled.',
  },
  /** DB write of `submitted` succeeded but `store.resolve(cardId, ...)` returned
   *  false (race: handler already timed out / aborted before resolve landed).
   *  Submit IPC rolls back the DB row to cancelled(card_resolver_missed). */
  cardResolverMissed: {
    code: 'card_resolver_missed',
    metricName: 'ask_user_questions_submit_resolver_missed',
    description: 'DB write succeeded but waiting Promise was already gone; DB row rolled back.',
  },
  /** A new pending card is requested while the same session already has one
   *  in flight. The model must wait for the user to finish before issuing
   *  another reflection. */
  overlappingCard: {
    code: 'overlapping_card',
    noMetric: true,
    description: 'Session already has a pending ask_user_questions card.',
  },
  /** Cancel reason was `user_typed_instead` — the user sent a new message
   *  rather than answering the card; surfaced as "user replied with prose". */
  userSkipped: {
    code: 'user_skipped',
    noMetric: true,
    description: 'User typed a new message instead of selecting card options.',
  },
  /** Explicit user cancel via the card's skip button. */
  userCancelled: {
    code: 'user_cancelled',
    noMetric: true,
    description: 'User clicked the card cancel/skip button.',
  },
  /** AbortSignal fired — usually a session reset or scope switch. */
  aborted: {
    code: 'aborted',
    noMetric: true,
    description: 'Handler abort signal triggered (session reset / scope teardown).',
  },
  /** No answer within the 24h handler timeout. */
  timeout: {
    code: 'timeout',
    noMetric: true,
    description: 'No user response within the configured timeoutMs (default 24h).',
  },
  /** Cancel IPC: in-memory store.reject succeeded but DB write failed.
   *  Returned as IPC envelope `errorKind` (not via ToolDomainError, since the
   *  Promise is already rejected with userCancelled/userSkipped). Renderer
   *  must locally fold the card to `cancelled(cancel_persist_failed)` so the
   *  UI doesn't keep showing pending. Boot sweep cleans up the DB residue. */
  cancelPersistFailed: {
    code: 'cancel_persist_failed',
    metricName: 'ask_user_questions_cancel_persist_failed',
    description: 'Cancel store-reject succeeded but DB write failed; renderer folds card locally.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type AskUserErrorKindKey = keyof typeof ASK_USER_ERROR_KINDS
export type AskUserErrorKind = (typeof ASK_USER_ERROR_KINDS)[AskUserErrorKindKey]['code']

// ---------- provider request adapter ----------

export const PROVIDER_ERROR_KINDS = {
  /** Provider request could not be safely constructed or sent. PR 3 uses this
   *  for current-turn media mismatch and manual thinking-mode mismatch. */
  providerRequestFailed: {
    code: 'provider_request_failed',
    metricName: 'provider_thinking_echo_unsupported',
    description: 'Provider request blocked before network I/O due to unsupported or unverified request capability.',
  },
  /** Provider returned a 400 that explicitly asks for multi-turn thinking
   *  content to be preserved / echoed. */
  providerThinkingEchoRequired: {
    code: 'provider_thinking_echo_required',
    metricName: 'provider_thinking_echo_required_400',
    description: 'Provider 400 indicates missing reasoning_content / extended thinking echo.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type ProviderErrorKindKey = keyof typeof PROVIDER_ERROR_KINDS
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[ProviderErrorKindKey]['code']

// ---------- detached skill tasks ----------

export const DETACHED_TASK_ERROR_KINDS = {
  taskFailed: {
    code: 'detached_task_failed',
    noMetric: true,
    description: 'Detached skill task reached a failed terminal state.',
  },
  notFound: {
    code: 'detached_task_not_found',
    noMetric: true,
    description: 'Requested detached skill task id was not found.',
  },
  forbidden: {
    code: 'detached_task_forbidden',
    noMetric: true,
    description: 'Detached skill task exists but is not available in this session.',
  },
  runtimeUnavailable: {
    code: 'detached_task_runtime_unavailable',
    noMetric: true,
    description: 'Detached skill task tracker/runtime is unavailable.',
  },
  skillActionUnknown: {
    code: 'detached_task_skill_action_unknown',
    noMetric: true,
    description: 'Requested skill action is not exposed by the loaded skill tool registry.',
  },
  skillNotLoaded: {
    code: 'detached_task_skill_not_loaded',
    noMetric: true,
    description: 'Skill manifest is not loaded for the requested detached action.',
  },
  hintRequired: {
    code: 'detached_task_hint_required',
    noMetric: true,
    description: 'Detached action requires a reference-skill hint to be armed.',
  },
  visibilityInternal: {
    code: 'detached_task_visibility_internal',
    noMetric: true,
    description: 'Detached action is internal and is not exposed for this turn.',
  },
  startFailed: {
    code: 'detached_task_start_failed',
    noMetric: true,
    description: 'Detached skill task failed to start.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type DetachedTaskErrorKindKey = keyof typeof DETACHED_TASK_ERROR_KINDS
export type DetachedTaskErrorKind =
  (typeof DETACHED_TASK_ERROR_KINDS)[DetachedTaskErrorKindKey]['code']

// ---------- send-im ----------

export const SEND_IM_ERROR_KINDS = {
  blockedExternal: {
    code: 'blocked_external',
    noMetric: true,
    description: 'External IM service rejected the send operation.',
  },
  sendFailed: {
    code: 'send_failed',
    noMetric: true,
    description: 'Remote IM send failed after dispatch.',
  },
  sidecarUnavailable: {
    code: 'sidecar_unavailable',
    noMetric: true,
    description: 'Remote IM sidecar is unavailable.',
  },
  channelNotReady: {
    code: 'channel_not_ready',
    noMetric: true,
    description: 'No usable remote IM channel is ready for this send.',
  },
  directoryNotSupported: {
    code: 'directory_not_supported',
    noMetric: true,
    description: 'A directory was selected where a concrete file is required.',
  },
  fileNotFound: {
    code: 'file_not_found',
    noMetric: true,
    description: 'The requested local file could not be resolved.',
  },
  fileAmbiguous: {
    code: 'file_ambiguous',
    noMetric: true,
    description: 'Multiple candidate files matched the send request.',
  },
  intentNegated: {
    code: 'intent_negated',
    noMetric: true,
    description: 'User text explicitly negated the remote IM send intent.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type SendImErrorKindKey = keyof typeof SEND_IM_ERROR_KINDS
export type SendImErrorKind = (typeof SEND_IM_ERROR_KINDS)[SendImErrorKindKey]['code']

// ---------- document target guards ----------

export const TARGET_DOCUMENT_ERROR_KINDS = {
  preservedContentMissing: {
    code: 'target_document_preserved_content_missing',
    noMetric: true,
    description: 'A target document mutation would remove required preserved content.',
  },
  openUnavailable: {
    code: 'target_document_open_unavailable',
    noMetric: true,
    description: 'The current turn did not expose the tool required to open the target document.',
  },
  openFailed: {
    code: 'target_document_open_failed',
    noMetric: true,
    description: 'The target document open guard failed before mutation.',
  },
  saveUnavailable: {
    code: 'target_document_save_unavailable',
    noMetric: true,
    description: 'The current turn did not expose the tool required to save the target document.',
  },
  saveFailed: {
    code: 'target_document_save_failed',
    noMetric: true,
    description: 'The target document save guard failed after mutation.',
  },
  required: {
    code: 'target_document_required',
    noMetric: true,
    description: 'A document write attempted to bypass the explicit target document.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type TargetDocumentErrorKindKey = keyof typeof TARGET_DOCUMENT_ERROR_KINDS
export type TargetDocumentErrorKind =
  (typeof TARGET_DOCUMENT_ERROR_KINDS)[TargetDocumentErrorKindKey]['code']

// ---------- browser tool fallbacks ----------

export const BROWSER_TOOL_ERROR_KINDS = {
  browserToolFailed: {
    code: 'browser_tool_failed',
    noMetric: true,
    description: 'Browser tool returned a legacy or unclassified failure that must be surfaced as structured data.',
  },
  browserPowerGrantRequired: {
    code: 'grant_required',
    noMetric: true,
    description: 'Browser Power action requires a matching user grant before execution.',
  },
  browserPowerGrantMismatch: {
    code: 'grant_mismatch',
    noMetric: true,
    description: 'Browser Power grant exists but does not match the requested effect, scope, URL, tab, or destination.',
  },
  browserPowerBlockedByPolicy: {
    code: 'blocked_by_policy',
    noMetric: true,
    description: 'Browser Power action is blocked by the code-owned policy boundary.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type BrowserToolErrorKindKey = keyof typeof BROWSER_TOOL_ERROR_KINDS
export type BrowserToolErrorKind =
  (typeof BROWSER_TOOL_ERROR_KINDS)[BrowserToolErrorKindKey]['code']

// ---------- tool admission/control ----------

export const TOOL_ADMISSION_ERROR_KINDS = {
  toolNotRegistered: {
    code: 'tool_not_registered',
    noMetric: true,
    description: 'The model or child gateway attempted to call a tool that is not registered.',
  },
  authorizationDenied: {
    code: 'authorization_denied',
    metricName: 'authorization_denied',
    description: 'A model-issued skill tool exists but is not authorized for this turn.',
  },
  internalToolNotAllowed: {
    code: 'internal_tool_not_allowed',
    noMetric: true,
    description: 'An internal-only tool was called from a context that cannot use internal tools.',
  },
  toolRestrictedThisTurn: {
    code: 'tool_restricted_this_turn',
    noMetric: true,
    description: 'The tool exists but is not in the current turn allowlist.',
  },
  deniedByUserNegation: {
    code: 'denied_by_user_negation',
    metricName: 'user_negation_denied',
    description: 'The user has an active standing negation for this tool family.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type ToolAdmissionErrorKindKey = keyof typeof TOOL_ADMISSION_ERROR_KINDS
export type ToolAdmissionErrorKind =
  (typeof TOOL_ADMISSION_ERROR_KINDS)[ToolAdmissionErrorKindKey]['code']

// ---------- MCP tool dispatcher ----------

export const MCP_TOOL_ERROR_KINDS = {
  toolUnregistered: {
    code: 'mcp_tool_unregistered',
    noMetric: true,
    description: 'An MCP tool call did not resolve to any registered MCP server.',
  },
  authorizationDenied: {
    code: 'mcp_authorization_denied',
    noMetric: true,
    description: 'The MCP tool is not authorized for the current session/scope tuple.',
  },
  clientMissing: {
    code: 'mcp_client_missing',
    noMetric: true,
    description: 'The registered MCP server has no connected client.',
  },
  toolFailed: {
    code: 'mcp_tool_failed',
    noMetric: true,
    description: 'The MCP client call threw or returned a non-ok result without a more specific kind.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type McpToolErrorKindKey = keyof typeof MCP_TOOL_ERROR_KINDS
export type McpToolErrorKind =
  (typeof MCP_TOOL_ERROR_KINDS)[McpToolErrorKindKey]['code']

// ---------- channel outbound (Phase I 远程会话回传) ----------

export const CHANNEL_OUTBOUND_ERROR_KINDS = {
  scopeUnbound: {
    code: 'channel_scope_unbound',
    noMetric: true,
    description: 'channel_send_file was invoked in a scope that has no bound remote channel thread (or the outbound bridge is not registered).',
  },
  fileInvalid: {
    code: 'channel_file_invalid',
    noMetric: true,
    description: 'The requested file path is not an existing regular file within the allowed size for channel delivery.',
  },
  deliveryFailed: {
    code: 'channel_delivery_failed',
    noMetric: true,
    description: 'The sidecar delivery of the outbound channel attachment reported failure (e.g. wechat ret=-3 session invalid).',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type ChannelOutboundErrorKindKey = keyof typeof CHANNEL_OUTBOUND_ERROR_KINDS
export type ChannelOutboundErrorKind =
  (typeof CHANNEL_OUTBOUND_ERROR_KINDS)[ChannelOutboundErrorKindKey]['code']

// ---------- MCP server install (Phase M agent 前门) ----------

export const MCP_INSTALL_ERROR_KINDS = {
  invalidSource: {
    code: 'mcp_install_invalid_source',
    noMetric: true,
    description: 'The requested MCP server source could not be resolved to a valid npx/uvx package.',
  },
  commandNotAllowed: {
    code: 'mcp_install_command_not_allowed',
    noMetric: true,
    description: 'Agent-driven MCP install only accepts the npx/uvx command allowlist; other commands must be added manually in settings.',
  },
  duplicateServer: {
    code: 'mcp_install_duplicate_server',
    noMetric: true,
    description: 'A server with the same id already exists in mcp_servers_json.',
  },
  configUnreadable: {
    code: 'mcp_install_config_unreadable',
    noMetric: true,
    description: 'Existing mcp_servers_json is not a parseable JSON array; refusing to rewrite it (fix in settings first).',
  },
  serverNotFound: {
    code: 'mcp_install_server_not_found',
    noMetric: true,
    description: 'Remove was requested for a server id that does not exist in the config.',
  },
  applyFailed: {
    code: 'mcp_install_apply_failed',
    noMetric: true,
    description: 'Persisting the config or reloading the MCP servers failed.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type McpInstallErrorKindKey = keyof typeof MCP_INSTALL_ERROR_KINDS
export type McpInstallErrorKind =
  (typeof MCP_INSTALL_ERROR_KINDS)[McpInstallErrorKindKey]['code']

// ---------- setup command execution (Phase M+ agent 代跑安装命令) ----------

export const SETUP_COMMAND_ERROR_KINDS = {
  invalidCommand: {
    code: 'setup_command_invalid',
    noMetric: true,
    description: 'The requested setup command is empty, contains shell metacharacters, or is otherwise malformed.',
  },
  notConfirmed: {
    code: 'setup_command_not_confirmed',
    noMetric: true,
    description: 'Phase 2 execution was requested without a matching confirmed command descriptor (confirmAck + echoed command).',
  },
  executionFailed: {
    code: 'setup_command_execution_failed',
    noMetric: true,
    description: 'The setup command process could not be spawned (binary missing, permission denied, spawn error).',
  },
  timedOut: {
    code: 'setup_command_timed_out',
    noMetric: true,
    description: 'The setup command exceeded the execution timeout and was killed.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type SetupCommandErrorKindKey = keyof typeof SETUP_COMMAND_ERROR_KINDS
export type SetupCommandErrorKind =
  (typeof SETUP_COMMAND_ERROR_KINDS)[SetupCommandErrorKindKey]['code']

// ---------- action confirmation/control ----------

export const ACTION_CONFIRMATION_ERROR_KINDS = {
  deniedManualOnly: {
    code: 'denied_manual_only',
    noMetric: true,
    description: 'The action confirmation policy requires the user to perform this action manually.',
  },
  deniedPendingConfirmation: {
    code: 'denied_pending_confirmation',
    noMetric: true,
    description: 'The action requires explicit user confirmation before execution.',
  },
  confirmationDeniedByUser: {
    code: 'confirmation_denied_by_user',
    noMetric: true,
    description: 'The user denied a pending action confirmation request.',
  },
  confirmationExpired: {
    code: 'confirmation_expired',
    noMetric: true,
    description: 'The pending action confirmation request expired before user approval.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type ActionConfirmationErrorKindKey = keyof typeof ACTION_CONFIRMATION_ERROR_KINDS
export type ActionConfirmationErrorKind =
  (typeof ACTION_CONFIRMATION_ERROR_KINDS)[ActionConfirmationErrorKindKey]['code']

// ---------- specialist blueprint ----------

export const SPECIALIST_BLUEPRINT_ERROR_KINDS = {
  verbatimSourceUnavailable: {
    code: 'verbatim_source_unavailable',
    noMetric: true,
    description: 'The propose_specialist_blueprint tool could not verify the current user text source.',
  },
  verbatimMismatch: {
    code: 'verbatim_mismatch',
    noMetric: true,
    description: 'The propose_specialist_blueprint user_request_verbatim does not match the source user text.',
  },
  confirmedBlueprintImmutable: {
    code: 'confirmed_blueprint_immutable',
    noMetric: true,
    description: 'The propose_specialist_blueprint tool attempted to overwrite an already confirmed blueprint.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type SpecialistBlueprintErrorKindKey = keyof typeof SPECIALIST_BLUEPRINT_ERROR_KINDS
export type SpecialistBlueprintErrorKind =
  (typeof SPECIALIST_BLUEPRINT_ERROR_KINDS)[SpecialistBlueprintErrorKindKey]['code']

// ---------- web research ----------

export const WEB_RESEARCH_ERROR_KINDS = {
  webSearchFailed: {
    code: 'web_search_failed',
    noMetric: true,
    description: 'The web_search tool could not complete through its configured search backends.',
  },
  webFetchFailed: {
    code: 'web_fetch_failed',
    noMetric: true,
    description: 'The web_fetch tool could not complete through its configured fetch/extract backends.',
  },
} as const satisfies Record<string, ErrorKindMeta>

export type WebResearchErrorKindKey = keyof typeof WEB_RESEARCH_ERROR_KINDS
export type WebResearchErrorKind =
  (typeof WEB_RESEARCH_ERROR_KINDS)[WebResearchErrorKindKey]['code']

// ---------- helpers ----------

const ALL_REGISTERED_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(ASK_USER_ERROR_KINDS).map((m) => m.code),
  ...Object.values(PROVIDER_ERROR_KINDS).map((m) => m.code),
  ...Object.values(DETACHED_TASK_ERROR_KINDS).map((m) => m.code),
  ...Object.values(SEND_IM_ERROR_KINDS).map((m) => m.code),
  ...Object.values(TARGET_DOCUMENT_ERROR_KINDS).map((m) => m.code),
  ...Object.values(BROWSER_TOOL_ERROR_KINDS).map((m) => m.code),
  ...Object.values(TOOL_ADMISSION_ERROR_KINDS).map((m) => m.code),
  ...Object.values(MCP_TOOL_ERROR_KINDS).map((m) => m.code),
  ...Object.values(ACTION_CONFIRMATION_ERROR_KINDS).map((m) => m.code),
  ...Object.values(SPECIALIST_BLUEPRINT_ERROR_KINDS).map((m) => m.code),
  ...Object.values(WEB_RESEARCH_ERROR_KINDS).map((m) => m.code),
])

/** True iff `kind` is a registered errorKind in either group. */
export function isRegisteredErrorKind(kind: string): boolean {
  return ALL_REGISTERED_CODES.has(kind)
}

/** Lookup the meta record for an errorKind code; null when unregistered. */
export function lookupErrorKindMeta(code: string): ErrorKindMeta | null {
  for (const meta of Object.values(ASK_USER_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(PROVIDER_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(DETACHED_TASK_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(SEND_IM_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(TARGET_DOCUMENT_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(BROWSER_TOOL_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(TOOL_ADMISSION_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(MCP_TOOL_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(ACTION_CONFIRMATION_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(SPECIALIST_BLUEPRINT_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  for (const meta of Object.values(WEB_RESEARCH_ERROR_KINDS)) {
    if (meta.code === code) return meta
  }
  return null
}
