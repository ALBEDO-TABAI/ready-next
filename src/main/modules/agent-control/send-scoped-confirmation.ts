import {
  PRE_PERSISTENCE_ERROR_KINDS,
  type IngressAdmittedEvent,
  type IngressPersistenceErrorKind,
  type PersistedIngress,
  type PrePersistenceErrorKind,
  type SendScopedAttachmentConfirmationInput,
  type SendScopedResponse,
  type SendScopedUserMessage,
} from '../../../shared/ipc-contracts/agent-runtime'

export interface SendScopedAttachmentConfirmation {
  attachments: PersistedIngress['attachments']
  inputAttachments: PersistedIngress['inputAttachments']
}

export type StartIdentityReservationMethods =
  | readonly ['turn/start']
  | readonly ['thread/start', 'turn/start']

export type StartIdentityReservationSet =
  | {
      reservationSetId: string
      scopeId: string
      existingThread: true
      members: readonly [{ method: 'turn/start'; reservationId: string }]
      reservationEvidenceDigest: string
    }
  | {
      reservationSetId: string
      scopeId: string
      existingThread: false
      members: readonly [
        { method: 'thread/start'; reservationId: string },
        { method: 'turn/start'; reservationId: string },
      ]
      reservationEvidenceDigest: string
    }

export type StartIdentityReservationResult =
  | { ok: true; reservation: StartIdentityReservationSet }
  | {
      ok: false
      code: PrePersistenceErrorKind
      retryableByUser: boolean
      error: string
      admissionEvidenceDigest: string
    }

export class IngressPersistenceError extends Error {
  constructor(
    readonly code: IngressPersistenceErrorKind,
    readonly evidenceDigest: string,
    message: string,
  ) {
    super(message)
    this.name = 'IngressPersistenceError'
  }
}

export class PrePersistenceAdmissionError extends Error {
  constructor(
    readonly code: PrePersistenceErrorKind,
    readonly retryableByUser: boolean,
    readonly admissionEvidenceDigest: string,
    message: string,
  ) {
    super(message)
    this.name = 'PrePersistenceAdmissionError'
  }
}

type AdmittedSendScopedResponse = Extract<
  SendScopedResponse,
  { disposition: 'terminal_success' | 'terminal_failure_after_persistence' }
>

type ConfirmedRunOutcome = AdmittedSendScopedResponse extends infer Response
  ? Response extends AdmittedSendScopedResponse
    ? Omit<Response, 'aliasGeneration'>
    : never
  : never

export type PrePersistenceDispatchResult<DispatchContext> =
  | { ok: true; dispatchContext: DispatchContext }
  | {
      ok: false
      code: PrePersistenceErrorKind
      retryableByUser: boolean
      error: string
      admissionEvidenceDigest: string
    }

function skippedIngress(scope: 'pre-existing' | 'failed') {
  return {
    scope,
    message: 'skipped',
    attachments: 'none',
    inputAttachments: 'none',
  } as const
}

function failedIngress() {
  return {
    scope: 'pre-existing',
    message: 'failed',
    attachments: 'none',
    inputAttachments: 'none',
  } as const
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isStartIdentityReservationSet(value: unknown): value is StartIdentityReservationSet {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'reservationSetId',
      'scopeId',
      'existingThread',
      'members',
      'reservationEvidenceDigest',
    ])
    || !isNonEmptyString(value.reservationSetId)
    || !isNonEmptyString(value.scopeId)
    || typeof value.existingThread !== 'boolean'
    || !Array.isArray(value.members)
    || !isNonEmptyString(value.reservationEvidenceDigest)
  ) return false

  const expectedMethods = value.existingThread
    ? ['turn/start'] as const
    : ['thread/start', 'turn/start'] as const
  if (value.members.length !== expectedMethods.length) return false
  const reservationIds = new Set<string>()
  return value.members.every((member, index) => {
    if (!isRecord(member) || !hasExactKeys(member, ['method', 'reservationId'])) return false
    const method = expectedMethods[index]
    if (member.method !== method || !isNonEmptyString(member.reservationId)) return false
    if (reservationIds.has(member.reservationId)) return false
    reservationIds.add(member.reservationId)
    return true
  })
}

function isStartIdentityReservationFailure(
  value: unknown,
): value is Extract<StartIdentityReservationResult, { ok: false }> {
  return isRecord(value)
    && hasExactKeys(value, [
      'ok',
      'code',
      'retryableByUser',
      'error',
      'admissionEvidenceDigest',
    ])
    && value.ok === false
    && typeof value.code === 'string'
    && PRE_PERSISTENCE_ERROR_KINDS.includes(value.code as PrePersistenceErrorKind)
    && typeof value.retryableByUser === 'boolean'
    && isNonEmptyString(value.error)
    && isNonEmptyString(value.admissionEvidenceDigest)
}

function isPrePersistenceDispatchFailure(
  value: unknown,
): value is Extract<PrePersistenceDispatchResult<unknown>, { ok: false }> {
  return isRecord(value)
    && hasExactKeys(value, [
      'ok',
      'code',
      'retryableByUser',
      'error',
      'admissionEvidenceDigest',
    ])
    && value.ok === false
    && typeof value.code === 'string'
    && PRE_PERSISTENCE_ERROR_KINDS.includes(value.code as PrePersistenceErrorKind)
    && typeof value.retryableByUser === 'boolean'
    && isNonEmptyString(value.error)
    && isNonEmptyString(value.admissionEvidenceDigest)
}

function reservationMatchesRequest(
  reservation: StartIdentityReservationSet,
  scopeId: string,
  methods: StartIdentityReservationMethods,
): boolean {
  const expectedExistingThread = methods.length === 1
  if (
    reservation.scopeId !== scopeId
    || reservation.existingThread !== expectedExistingThread
    || !reservation.reservationSetId.trim()
    || !reservation.reservationEvidenceDigest.trim()
    || reservation.members.length !== methods.length
  ) return false

  const reservationIds = new Set<string>()
  for (let index = 0; index < methods.length; index += 1) {
    const member = reservation.members[index]
    if (
      !member
      || member.method !== methods[index]
      || !member.reservationId.trim()
      || reservationIds.has(member.reservationId)
    ) return false
    reservationIds.add(member.reservationId)
  }
  return true
}

function isStartIdentityReservationMethods(
  value: unknown,
): value is StartIdentityReservationMethods {
  return Array.isArray(value)
    && (
      (value.length === 1 && value[0] === 'turn/start')
      || (
        value.length === 2
        && value[0] === 'thread/start'
        && value[1] === 'turn/start'
      )
    )
}

function hostUnavailableBeforePersistence(input: {
  scope: 'pre-existing' | 'failed'
  stage: 'scope_read' | 'start_identity_resolution' | 'start_identity_reservation'
  scopeId: string
  error: unknown
}): Extract<SendScopedResponse, { disposition: 'rejected_before_persistence' }> {
  return createRejectedBeforePersistence({
    scope: input.scope,
    code: 'host_unavailable',
    retryableByUser: false,
    error: input.error instanceof Error ? input.error.message : String(input.error),
    admissionEvidenceDigest: `${input.stage}_failed:${input.scopeId}`,
  })
}

export function createRejectedBeforePersistence(input: {
  scope: 'pre-existing' | 'failed'
  code: PrePersistenceErrorKind
  retryableByUser: boolean
  error: string
  admissionEvidenceDigest: string
}): Extract<SendScopedResponse, { disposition: 'rejected_before_persistence' }> {
  return {
    success: false,
    disposition: 'rejected_before_persistence',
    shouldClearInput: false,
    preserveInput: true,
    retryableByUser: input.retryableByUser,
    persistence: skippedIngress(input.scope),
    error: input.error,
    errorKind: input.code,
    admissionEvidenceDigest: input.admissionEvidenceDigest,
  }
}

export async function runConfirmedSendScoped<ScopeRow, DispatchContext>(params: {
  scopeId: string
  requestId: string
  userMessage: SendScopedUserMessage
  getScope: (scopeId: string) => ScopeRow | null
  resolveStartIdentityMethods: (scope: ScopeRow) => StartIdentityReservationMethods
  reserveStartIdentitySet: (input: {
    scopeId: string
    methods: StartIdentityReservationMethods
  }) => Promise<StartIdentityReservationResult>
  reconcileReservationContractFailure: (input: {
    scopeId: string
    methods: StartIdentityReservationMethods
    reservationResult: unknown
    evidenceDigest: string
  }) => Promise<void>
  prepareDispatch: (input: {
    scope: ScopeRow
    requestId: string
    userMessage: SendScopedUserMessage
    reservation: StartIdentityReservationSet
  }) => Promise<PrePersistenceDispatchResult<DispatchContext>>
  validateDispatchContext: (
    value: unknown,
    input: {
      scope: ScopeRow
      requestId: string
      userMessage: SendScopedUserMessage
      reservation: StartIdentityReservationSet
    },
  ) => value is DispatchContext
  persistIngressAtomic: (input: {
    scope: ScopeRow
    requestId: string
    userMessage: SendScopedUserMessage
    reservation: StartIdentityReservationSet
    dispatchContext: DispatchContext
  }) => Promise<{
    persistence: PersistedIngress
    event: IngressAdmittedEvent
  }>
  emitIngressAdmitted: (event: IngressAdmittedEvent) => void
  releaseReservationAfterIngressFailure: (input: {
    reservation: StartIdentityReservationSet
    failure: IngressPersistenceError
  }) => Promise<void>
  releaseReservationAfterPrePersistenceRejection: (input: {
    reservation: StartIdentityReservationSet
    rejection: Extract<PrePersistenceDispatchResult<DispatchContext>, { ok: false }>
  }) => Promise<void>
  runConfirmed: (input: {
    scope: ScopeRow
    persistence: PersistedIngress
    reservation: StartIdentityReservationSet
    dispatchContext: DispatchContext
  }) => Promise<ConfirmedRunOutcome>
}): Promise<SendScopedResponse> {
  let scope: ScopeRow | null
  try {
    scope = params.getScope(params.scopeId)
  } catch (error) {
    if (error instanceof PrePersistenceAdmissionError) {
      return createRejectedBeforePersistence({
        scope: 'pre-existing',
        code: error.code,
        retryableByUser: error.retryableByUser,
        error: error.message,
        admissionEvidenceDigest: error.admissionEvidenceDigest,
      })
    }
    return hostUnavailableBeforePersistence({
      scope: 'failed',
      stage: 'scope_read',
      scopeId: params.scopeId,
      error,
    })
  }
  if (!scope) {
    return createRejectedBeforePersistence({
      scope: 'failed',
      code: 'scope_missing',
      retryableByUser: false,
      error: `Conversation scope not found: ${params.scopeId}`,
      admissionEvidenceDigest: `scope_missing:${params.scopeId}`,
    })
  }

  let methods: StartIdentityReservationMethods
  try {
    const resolvedMethods = params.resolveStartIdentityMethods(scope)
    if (!isStartIdentityReservationMethods(resolvedMethods)) {
      throw new Error('start_identity_methods_contract_invalid')
    }
    methods = resolvedMethods
  } catch (error) {
    if (error instanceof PrePersistenceAdmissionError) {
      return createRejectedBeforePersistence({
        scope: 'pre-existing',
        code: error.code,
        retryableByUser: error.retryableByUser,
        error: error.message,
        admissionEvidenceDigest: error.admissionEvidenceDigest,
      })
    }
    return hostUnavailableBeforePersistence({
      scope: 'pre-existing',
      stage: 'start_identity_resolution',
      scopeId: params.scopeId,
      error,
    })
  }

  let reservationResult: unknown
  try {
    reservationResult = await params.reserveStartIdentitySet({
      scopeId: params.scopeId,
      methods,
    })
  } catch (error) {
    return hostUnavailableBeforePersistence({
      scope: 'pre-existing',
      stage: 'start_identity_reservation',
      scopeId: params.scopeId,
      error,
    })
  }
  if (isStartIdentityReservationFailure(reservationResult)) {
    return createRejectedBeforePersistence({
      scope: 'pre-existing',
      code: reservationResult.code,
      retryableByUser: reservationResult.retryableByUser,
      error: reservationResult.error,
      admissionEvidenceDigest: reservationResult.admissionEvidenceDigest,
    })
  }
  if (
    !isRecord(reservationResult)
    || reservationResult.ok !== true
    || !hasExactKeys(reservationResult, ['ok', 'reservation'])
    || !isStartIdentityReservationSet(reservationResult.reservation)
  ) {
    const evidenceDigest = `start_identity_reservation_contract_invalid:${params.scopeId}`
    try {
      await params.reconcileReservationContractFailure({
        scopeId: params.scopeId,
        methods,
        reservationResult,
        evidenceDigest,
      })
    } catch {
      // Reconciliation owns any capacity whose runtime result is malformed.
    }
    return createRejectedBeforePersistence({
      scope: 'pre-existing',
      code: 'host_unavailable',
      retryableByUser: false,
      error: 'start_identity_reservation_contract_invalid',
      admissionEvidenceDigest: evidenceDigest,
    })
  }
  if (!reservationMatchesRequest(reservationResult.reservation, params.scopeId, methods)) {
    const evidenceDigest = `start_identity_reservation_contract_mismatch:${params.scopeId}`
    try {
      await params.reconcileReservationContractFailure({
        scopeId: params.scopeId,
        methods,
        reservationResult,
        evidenceDigest,
      })
    } catch {
      // Reconciliation owns any foreign or contradictory reservation identity.
    }
    return createRejectedBeforePersistence({
      scope: 'pre-existing',
      code: 'host_unavailable',
      retryableByUser: false,
      error: 'start_identity_reservation_contract_mismatch',
      admissionEvidenceDigest: evidenceDigest,
    })
  }

  let preparedDispatch: unknown
  try {
    preparedDispatch = await params.prepareDispatch({
      scope,
      requestId: params.requestId,
      userMessage: params.userMessage,
      reservation: reservationResult.reservation,
    })
  } catch (error) {
    preparedDispatch = {
      ok: false,
      code: 'host_unavailable',
      retryableByUser: false,
      error: error instanceof Error ? error.message : String(error),
      admissionEvidenceDigest: `dispatch_preparation_failed:${params.scopeId}`,
    }
  }
  if (isPrePersistenceDispatchFailure(preparedDispatch)) {
    try {
      await params.releaseReservationAfterPrePersistenceRejection({
        reservation: reservationResult.reservation,
        rejection: preparedDispatch,
      })
    } catch {
      // No ingress was persisted. Reconciliation retains ownership of any
      // reservation whose release could not be proven.
    }
    return createRejectedBeforePersistence({
      scope: 'pre-existing',
      code: preparedDispatch.code,
      retryableByUser: preparedDispatch.retryableByUser,
      error: preparedDispatch.error,
      admissionEvidenceDigest: preparedDispatch.admissionEvidenceDigest,
    })
  }
  let dispatchContextValid = false
  if (
    isRecord(preparedDispatch)
    && preparedDispatch.ok === true
    && hasExactKeys(preparedDispatch, ['ok', 'dispatchContext'])
    && Object.prototype.hasOwnProperty.call(preparedDispatch, 'dispatchContext')
  ) {
    try {
      dispatchContextValid = params.validateDispatchContext(
        preparedDispatch.dispatchContext,
        {
          scope,
          requestId: params.requestId,
          userMessage: params.userMessage,
          reservation: reservationResult.reservation,
        },
      )
    } catch {
      dispatchContextValid = false
    }
  }
  if (
    !isRecord(preparedDispatch)
    || preparedDispatch.ok !== true
    || !hasExactKeys(preparedDispatch, ['ok', 'dispatchContext'])
    || !Object.prototype.hasOwnProperty.call(preparedDispatch, 'dispatchContext')
    || !dispatchContextValid
  ) {
    const rejection = {
      ok: false as const,
      code: 'host_unavailable' as const,
      retryableByUser: false,
      error: 'dispatch_preparation_contract_invalid',
      admissionEvidenceDigest: `dispatch_preparation_contract_invalid:${params.scopeId}`,
    }
    try {
      await params.releaseReservationAfterPrePersistenceRejection({
        reservation: reservationResult.reservation,
        rejection,
      })
    } catch {
      // Reconciliation retains ownership of a reservation that could not be released.
    }
    return createRejectedBeforePersistence({
      scope: 'pre-existing',
      code: rejection.code,
      retryableByUser: rejection.retryableByUser,
      error: rejection.error,
      admissionEvidenceDigest: rejection.admissionEvidenceDigest,
    })
  }
  const dispatchContext = preparedDispatch.dispatchContext as DispatchContext

  let admission: {
    persistence: PersistedIngress
    event: IngressAdmittedEvent
  }
  try {
    admission = await params.persistIngressAtomic({
      scope,
      requestId: params.requestId,
      userMessage: params.userMessage,
      reservation: reservationResult.reservation,
      dispatchContext,
    })
  } catch (error) {
    if (error instanceof PrePersistenceAdmissionError) {
      // The atomic owner has rolled back; this is a known admission rejection.
      const rejection = { ok: false as const, code: error.code, retryableByUser: error.retryableByUser,
        error: error.message, admissionEvidenceDigest: error.admissionEvidenceDigest }
      try {
        await params.releaseReservationAfterPrePersistenceRejection({
          reservation: reservationResult.reservation, rejection,
        })
      } catch {
        // silent-catch: a failed release remains owned by the existing reservation reconciler.
      }
      return createRejectedBeforePersistence({ scope: 'pre-existing', ...rejection })
    }
    const failure = error instanceof IngressPersistenceError
      ? error
      : new IngressPersistenceError(
          'ingress_transaction_failed',
          `ingress_transaction_failed:${params.scopeId}`,
          error instanceof Error ? error.message : String(error),
        )
    try {
      await params.releaseReservationAfterIngressFailure({
        reservation: reservationResult.reservation,
        failure,
      })
    } catch {
      // Persistence remains failed; the reservation stays held for reconciliation.
    }
    return {
      success: false,
      disposition: 'ingress_persistence_failed',
      shouldClearInput: false,
      preserveInput: true,
      retryableByUser: true,
      persistence: failedIngress(),
      error: failure.message,
      errorKind: failure.code,
      evidenceDigest: failure.evidenceDigest,
    }
  }

  try {
    params.emitIngressAdmitted(admission.event)
  } catch {
    // Durable admission already succeeded. A renderer delivery race must not
    // prevent the one native dispatch that owns this persisted request.
  }
  const outcome = await params.runConfirmed({
    scope,
    persistence: admission.persistence,
    reservation: reservationResult.reservation,
    dispatchContext,
  })
  return {
    ...outcome,
    aliasGeneration: admission.event.aliasGeneration,
  }
}

export function resolveAttachmentConfirmation(
  input: SendScopedAttachmentConfirmationInput,
): SendScopedAttachmentConfirmation {
  const { selectedCount, metadataCount, inputIncludedCount, inputFailedCount } = input

  const attachments: PersistedIngress['attachments'] = selectedCount === 0
    ? 'none'
    : metadataCount <= 0
      ? 'metadata_failed'
      : metadataCount < selectedCount
        ? 'metadata_partial'
        : 'metadata_persisted'

  const inputAttachments: PersistedIngress['inputAttachments'] = selectedCount === 0
    ? 'none'
    : inputFailedCount > 0 && inputIncludedCount > 0
      ? 'partial'
      : inputFailedCount > 0
        ? 'failed'
        : inputIncludedCount > 0
          ? 'included'
          : 'none'

  return { attachments, inputAttachments }
}
