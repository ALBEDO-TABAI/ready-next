import { createHash } from 'crypto'

import type {
  BrowserActionOutcome,
  BrowserActionTargetIdentity,
  BrowserEnvironmentSummary,
} from '../../../shared/browser-action-outcome'
import {
  BROWSER_OPERATION_IDS,
  browserOperationCapability,
  type BrowserOperationId,
} from '../../../shared/browser-capability-registry'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function browserWorkflowStableDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export interface BrowserWorkflowActiveAction {
  actionId: string
  actionSeq: number
  operationId: BrowserOperationId
  ownerRunId: string
  argsDigest: string
  identity: BrowserActionTargetIdentity
  searchActionId?: string
  startedAt: string
}

export interface BrowserWorkflowActionJournal {
  nextActionSeq: number
  nextObservationSeq: number
  activeAction: BrowserWorkflowActiveAction | null
  settledOutcomes: Array<{
    receiptId: string
    actionId: string
    actionSeq: number
    outcome: BrowserActionOutcome
    settledAt: string
  }>
  observationReceipts: BrowserWorkflowObservationReceipt[]
}

export interface BrowserWorkflowObservationReceipt {
  receiptId: string
  observationSeq: number
  operationId: BrowserOperationId
  ownerRunId: string
  observedAfterActionSeq: number
  identity: BrowserActionTargetIdentity
  searchActionId: string | null
  queryDigest: string | null
  causalActions: Array<{
    actionId: string
    actionSeq: number
    predecessorIdentity: BrowserActionTargetIdentity
    successorIdentity: BrowserActionTargetIdentity
    searchActionId: string | null
    queryDigest: string | null
  }>
  resultDigest: string
  resourceId: string
  observedAt: string
}

export interface BrowserWorkflowObservationResource {
  resourceId: string
  taskId: string
  operationId: BrowserOperationId
  ownerRunId: string
  identity: BrowserActionTargetIdentity
  mediaType: 'application/json'
  content: string
  contentDigest: string
  provenanceDigest: string
  truncated: boolean
  createdAt: string
}

export interface RecordBrowserWorkflowObservationInput {
  taskId: string
  operationId: BrowserOperationId
  ownerRunId: string
  identity: BrowserActionTargetIdentity
  resultDigest: string
  resourceContent: string
  resourceTruncated: boolean
}

export interface BeginBrowserWorkflowActionInput {
  taskId: string
  operationId: BrowserOperationId
  ownerRunId: string
  argsDigest: string
  identity: BrowserActionTargetIdentity
  searchActionId?: string
}

export interface SettledBrowserWorkflowAction {
  receiptId: string
  actionId: string
  actionSeq: number
  outcome: BrowserActionOutcome
}

export interface BrowserResearchWorkItemInput {
  workItemId?: string | null
  goalRefs?: string[]
  requirement?: string | null
  query?: string | null
  url?: string | null
  fieldGoals?: string[]
  required?: boolean
}

export interface BrowserResearchWorkItem {
  workItemId: string
  goalRefs: string[]
  requirement: string | null
  query: string | null
  url: string | null
  fieldGoals: string[]
  required: boolean
  evidenceRefIds: string[]
  createdAt: string
}

export interface BrowserResearchEvidenceBindingInput {
  workItemId: string
  observationReceiptId: string
  actionReceiptId?: string | null
}

export interface BrowserResearchEvidenceRef {
  evidenceRefId: string
  workItemId: string
  observationReceiptId: string
  actionReceiptId: string | null
  observationSeq: number
  actionSeq: number | null
  operationId: BrowserOperationId
  resultDigest: string
  resourceId: string
  contentDigest: string
  provenanceDigest: string
  identity: BrowserActionTargetIdentity
  createdAt: string
}

export interface BrowserResearchAssessment {
  taskId: string
  satisfied: boolean
  missingWorkItemIds: string[]
  workItems: BrowserResearchWorkItem[]
  evidenceRefs: BrowserResearchEvidenceRef[]
}

export type BrowserResearchVerificationState = 'not_requested' | 'incomplete' | 'satisfied'

export interface VerifiedBrowserWorkflowEvidence {
  journal: BrowserWorkflowActionJournal
  resources: BrowserWorkflowObservationResource[]
  researchState: BrowserResearchVerificationState
  researchAssessment: BrowserResearchAssessment | null
  unresolvedActions: BrowserWorkflowActionJournal['settledOutcomes']
}

export interface BrowserResearchPayloadState {
  version: 1
  workItems: BrowserResearchWorkItem[]
  evidenceRefs: BrowserResearchEvidenceRef[]
}

const BROWSER_OPERATION_ID_SET = new Set<string>(BROWSER_OPERATION_IDS)
const BROWSER_ACTION_MODES = new Set(['control', 'observe', 'mutate'])
const BROWSER_DISPATCH_STATES = new Set(['accepted', 'rejected', 'unknown'])
const BROWSER_DELIVERY_STATES = new Set(['not_applicable', 'delivered', 'not_delivered', 'unknown'])
const BROWSER_EFFECT_STATES = new Set(['not_applicable', 'observed', 'unknown'])

function corruptBrowserWorkflowState(path: string): never {
  throw new Error(`browser_workflow_persisted_state_corrupt:${path}`)
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  return asRecord(value) || corruptBrowserWorkflowState(path)
}

function requiredString(value: unknown, path: string): string {
  return typeof value === 'string' && value.trim()
    ? value
    : corruptBrowserWorkflowState(path)
}

function optionalStringOrNull(value: unknown, path: string): string | null {
  return value === null
    ? null
    : requiredString(value, path)
}

function requiredPositiveInteger(value: unknown, path: string): number {
  return Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : corruptBrowserWorkflowState(path)
}

function requiredNonNegativeInteger(value: unknown, path: string): number {
  return Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : corruptBrowserWorkflowState(path)
}

function requiredTimestamp(value: unknown, path: string): string {
  const timestamp = requiredString(value, path)
  if (!Number.isFinite(Date.parse(timestamp))) corruptBrowserWorkflowState(path)
  return timestamp
}

function requiredOperationId(value: unknown, path: string): BrowserOperationId {
  const operationId = requiredString(value, path)
  return BROWSER_OPERATION_ID_SET.has(operationId)
    ? operationId as BrowserOperationId
    : corruptBrowserWorkflowState(path)
}

function parsePersistedIdentity(value: unknown, path: string): BrowserActionTargetIdentity {
  const identity = requiredRecord(value, path)
  if (identity.documentState === 'document') {
    return {
      documentState: 'document',
      tabId: requiredString(identity.tabId, `${path}.tabId`),
      physicalTargetToken: requiredString(identity.physicalTargetToken, `${path}.physicalTargetToken`),
      frameId: requiredString(identity.frameId, `${path}.frameId`),
      frameDocumentToken: requiredString(identity.frameDocumentToken, `${path}.frameDocumentToken`),
      targetRef: optionalStringOrNull(identity.targetRef, `${path}.targetRef`),
    }
  }
  if (
    identity.documentState === 'no_document'
    && ['tabId', 'physicalTargetToken', 'frameId', 'frameDocumentToken', 'targetRef']
      .every((key) => identity[key] === null)
  ) {
    return {
      documentState: 'no_document',
      tabId: null,
      physicalTargetToken: null,
      frameId: null,
      frameDocumentToken: null,
      targetRef: null,
    }
  }
  return corruptBrowserWorkflowState(path)
}

function parsePersistedSearchOutcome(value: unknown, path: string): NonNullable<BrowserActionOutcome['search']> {
  const search = requiredRecord(value, path)
  const phase = requiredString(search.phase, `${path}.phase`)
  if (!['not_submitted', 'submitted_needs_observation', 'effect_observed'].includes(phase)) {
    corruptBrowserWorkflowState(`${path}.phase`)
  }
  if (typeof search.submitted !== 'boolean' || typeof search.effectObserved !== 'boolean') {
    corruptBrowserWorkflowState(path)
  }
  return {
    searchActionId: requiredString(search.searchActionId, `${path}.searchActionId`),
    queryDigest: requiredString(search.queryDigest, `${path}.queryDigest`),
    fillActionId: optionalStringOrNull(search.fillActionId, `${path}.fillActionId`),
    submitActionId: optionalStringOrNull(search.submitActionId, `${path}.submitActionId`),
    phase: phase as NonNullable<BrowserActionOutcome['search']>['phase'],
    submitted: search.submitted,
    effectObserved: search.effectObserved,
  }
}

function parsePersistedOutcome(value: unknown, path: string): BrowserActionOutcome {
  const outcome = requiredRecord(value, path)
  const operationId = requiredOperationId(outcome.operationId, `${path}.operationId`)
  const mode = requiredString(outcome.mode, `${path}.mode`)
  const dispatch = requiredString(outcome.dispatch, `${path}.dispatch`)
  const delivery = requiredString(outcome.delivery, `${path}.delivery`)
  const effect = requiredString(outcome.effect, `${path}.effect`)
  if (
    !BROWSER_ACTION_MODES.has(mode)
    || mode !== browserOperationCapability(operationId).mode
    || !BROWSER_DISPATCH_STATES.has(dispatch)
    || !BROWSER_DELIVERY_STATES.has(delivery)
    || !BROWSER_EFFECT_STATES.has(effect)
    || typeof outcome.needsObservation !== 'boolean'
    || typeof outcome.mayHaveCommitted !== 'boolean'
  ) corruptBrowserWorkflowState(path)
  return {
    actionId: requiredString(outcome.actionId, `${path}.actionId`),
    actionSeq: requiredPositiveInteger(outcome.actionSeq, `${path}.actionSeq`),
    taskId: requiredString(outcome.taskId, `${path}.taskId`),
    ownerRunId: requiredString(outcome.ownerRunId, `${path}.ownerRunId`),
    operationId,
    mode: mode as BrowserActionOutcome['mode'],
    dispatch: dispatch as BrowserActionOutcome['dispatch'],
    delivery: delivery as BrowserActionOutcome['delivery'],
    effect: effect as BrowserActionOutcome['effect'],
    needsObservation: outcome.needsObservation,
    mayHaveCommitted: outcome.mayHaveCommitted,
    identity: parsePersistedIdentity(outcome.identity, `${path}.identity`),
    successorIdentity: parsePersistedIdentity(outcome.successorIdentity, `${path}.successorIdentity`),
    ...(outcome.postActionTabId === undefined
      ? {}
      : { postActionTabId: requiredString(outcome.postActionTabId, `${path}.postActionTabId`) }),
    ...(outcome.environmentSummary === undefined
      ? {}
      : { environmentSummary: parsePersistedEnvironmentSummary(outcome.environmentSummary, `${path}.environmentSummary`) }),
    ...(outcome.search === undefined
      ? {}
      : { search: parsePersistedSearchOutcome(outcome.search, `${path}.search`) }),
  }
}

function parsePersistedEnvironmentSummary(value: unknown, path: string): BrowserEnvironmentSummary {
  const summary = requiredRecord(value, path)
  const sampledAt = requiredTimestamp(summary.sampledAt, `${path}.sampledAt`)
  const dialogState = summary.dialogState
  const fileChooserState = summary.fileChooserState
  const downloadState = summary.downloadState
  if (dialogState !== undefined && dialogState !== 'open' && dialogState !== 'closed') {
    corruptBrowserWorkflowState(`${path}.dialogState`)
  }
  if (fileChooserState !== undefined && fileChooserState !== 'open' && fileChooserState !== 'closed') {
    corruptBrowserWorkflowState(`${path}.fileChooserState`)
  }
  if (downloadState !== undefined && downloadState !== 'in_flight' && downloadState !== 'settled') {
    corruptBrowserWorkflowState(`${path}.downloadState`)
  }
  return {
    sampledAt,
    ...(summary.targetTabId === undefined
      ? {}
      : { targetTabId: requiredString(summary.targetTabId, `${path}.targetTabId`) }),
    ...(summary.url === undefined ? {} : { url: requiredString(summary.url, `${path}.url`) }),
    ...(summary.title === undefined ? {} : { title: requiredString(summary.title, `${path}.title`) }),
    ...(dialogState === undefined ? {} : { dialogState }),
    ...(fileChooserState === undefined ? {} : { fileChooserState }),
    ...(downloadState === undefined ? {} : { downloadState }),
  }
}

function parsePersistedActiveAction(value: unknown, path: string): BrowserWorkflowActiveAction {
  const active = requiredRecord(value, path)
  return {
    actionId: requiredString(active.actionId, `${path}.actionId`),
    actionSeq: requiredPositiveInteger(active.actionSeq, `${path}.actionSeq`),
    operationId: requiredOperationId(active.operationId, `${path}.operationId`),
    ownerRunId: requiredString(active.ownerRunId, `${path}.ownerRunId`),
    argsDigest: requiredString(active.argsDigest, `${path}.argsDigest`),
    identity: parsePersistedIdentity(active.identity, `${path}.identity`),
    ...(active.searchActionId === undefined
      ? {}
      : { searchActionId: requiredString(active.searchActionId, `${path}.searchActionId`) }),
    startedAt: requiredTimestamp(active.startedAt, `${path}.startedAt`),
  }
}

function parsePersistedCausalAction(
  value: unknown,
  path: string,
): BrowserWorkflowObservationReceipt['causalActions'][number] {
  const action = requiredRecord(value, path)
  return {
    actionId: requiredString(action.actionId, `${path}.actionId`),
    actionSeq: requiredPositiveInteger(action.actionSeq, `${path}.actionSeq`),
    predecessorIdentity: parsePersistedIdentity(action.predecessorIdentity, `${path}.predecessorIdentity`),
    successorIdentity: parsePersistedIdentity(action.successorIdentity, `${path}.successorIdentity`),
    searchActionId: optionalStringOrNull(action.searchActionId, `${path}.searchActionId`),
    queryDigest: optionalStringOrNull(action.queryDigest, `${path}.queryDigest`),
  }
}

function parsePersistedObservationReceipt(value: unknown, path: string): BrowserWorkflowObservationReceipt {
  const receipt = requiredRecord(value, path)
  if (!Array.isArray(receipt.causalActions)) corruptBrowserWorkflowState(`${path}.causalActions`)
  return {
    receiptId: requiredString(receipt.receiptId, `${path}.receiptId`),
    observationSeq: requiredPositiveInteger(receipt.observationSeq, `${path}.observationSeq`),
    operationId: requiredOperationId(receipt.operationId, `${path}.operationId`),
    ownerRunId: requiredString(receipt.ownerRunId, `${path}.ownerRunId`),
    observedAfterActionSeq: requiredNonNegativeInteger(receipt.observedAfterActionSeq, `${path}.observedAfterActionSeq`),
    identity: parsePersistedIdentity(receipt.identity, `${path}.identity`),
    searchActionId: optionalStringOrNull(receipt.searchActionId, `${path}.searchActionId`),
    queryDigest: optionalStringOrNull(receipt.queryDigest, `${path}.queryDigest`),
    causalActions: receipt.causalActions.map((item, index) => (
      parsePersistedCausalAction(item, `${path}.causalActions[${index}]`)
    )),
    resultDigest: requiredString(receipt.resultDigest, `${path}.resultDigest`),
    resourceId: requiredString(receipt.resourceId, `${path}.resourceId`),
    observedAt: requiredTimestamp(receipt.observedAt, `${path}.observedAt`),
  }
}

export function parseBrowserWorkflowActionJournal(
  payload: Record<string, unknown>,
  expectedTaskId?: string,
): BrowserWorkflowActionJournal {
  if (!Object.prototype.hasOwnProperty.call(payload, 'browserWorkflowActionJournal')) {
    return corruptBrowserWorkflowState('actionJournal.missing')
  }
  const raw = requiredRecord(payload.browserWorkflowActionJournal, 'actionJournal')
  if (!Array.isArray(raw.settledOutcomes) || !Array.isArray(raw.observationReceipts)) {
    corruptBrowserWorkflowState('actionJournal')
  }
  const active = raw.activeAction === null
    ? null
    : parsePersistedActiveAction(raw.activeAction, 'actionJournal.activeAction')
  const settled = raw.settledOutcomes.map((value, index) => {
    const path = `actionJournal.settledOutcomes[${index}]`
    const item = requiredRecord(value, path)
    const outcome = parsePersistedOutcome(item.outcome, `${path}.outcome`)
    const actionId = requiredString(item.actionId, `${path}.actionId`)
    const actionSeq = requiredPositiveInteger(item.actionSeq, `${path}.actionSeq`)
    const receiptId = requiredString(item.receiptId, `${path}.receiptId`)
    const expectedReceiptId = `browser-receipt-${browserWorkflowStableDigest({
      taskId: outcome.taskId,
      actionId,
      normalizedOutcome: outcome,
    }).slice(0, 32)}`
    if (
      outcome.actionId !== actionId
      || outcome.actionSeq !== actionSeq
      || (expectedTaskId && outcome.taskId !== expectedTaskId)
      || receiptId !== expectedReceiptId
    ) corruptBrowserWorkflowState(path)
    return {
      receiptId,
      actionId,
      actionSeq,
      outcome,
      settledAt: requiredTimestamp(item.settledAt, `${path}.settledAt`),
    }
  })
  const observations = raw.observationReceipts.map((item, index) => (
    parsePersistedObservationReceipt(item, `actionJournal.observationReceipts[${index}]`)
  ))
  const nextActionSeq = requiredPositiveInteger(raw.nextActionSeq, 'actionJournal.nextActionSeq')
  const nextObservationSeq = requiredPositiveInteger(raw.nextObservationSeq, 'actionJournal.nextObservationSeq')
  const actionSeqs = [...settled.map((item) => item.actionSeq), ...(active ? [active.actionSeq] : [])]
  const observationSeqs = observations.map((item) => item.observationSeq)
  const sortedActionSeqs = [...actionSeqs].sort((left, right) => left - right)
  const sortedObservationSeqs = [...observationSeqs].sort((left, right) => left - right)
  for (const observation of observations) {
    const causalKeys = new Set<string>()
    for (const causal of observation.causalActions) {
      const key = `${causal.actionId}:${causal.actionSeq}`
      if (causalKeys.has(key)) corruptBrowserWorkflowState('actionJournal.observationReceipts.causalActions')
      causalKeys.add(key)
      const action = settled.find((item) => item.actionId === causal.actionId && item.actionSeq === causal.actionSeq)
      const expectedSuccessor = action
        ? resolveBrowserObservationSuccessorIdentity(action.outcome, causal.successorIdentity)
        : null
      if (
        !action
        || browserWorkflowStableDigest(causal.predecessorIdentity) !== browserWorkflowStableDigest(action.outcome.identity)
        || !expectedSuccessor
        || browserWorkflowStableDigest(causal.successorIdentity) !== browserWorkflowStableDigest(expectedSuccessor)
        || causal.searchActionId !== (action.outcome.search?.searchActionId || null)
        || causal.queryDigest !== (action.outcome.search?.queryDigest || null)
      ) corruptBrowserWorkflowState('actionJournal.observationReceipts.causalActions')
    }
    const observedAfterActionSeq = observation.causalActions.reduce(
      (highest, action) => Math.max(highest, action.actionSeq),
      0,
    )
    const receiptIdentity = observation.causalActions.at(-1)?.successorIdentity || observation.identity
    const linkedSearch = [...observation.causalActions].reverse()
      .find((action) => action.searchActionId && action.queryDigest) || null
    if (
      observation.observedAfterActionSeq !== observedAfterActionSeq
      || browserWorkflowStableDigest(observation.identity) !== browserWorkflowStableDigest(receiptIdentity)
      || observation.searchActionId !== (linkedSearch?.searchActionId || null)
      || observation.queryDigest !== (linkedSearch?.queryDigest || null)
    ) corruptBrowserWorkflowState('actionJournal.observationReceipts.causalBinding')
  }
  if (
    new Set(settled.map((item) => item.actionId)).size !== settled.length
    || new Set(settled.map((item) => item.receiptId)).size !== settled.length
    || new Set(actionSeqs).size !== actionSeqs.length
    || new Set(observations.map((item) => item.receiptId)).size !== observations.length
    || new Set(observationSeqs).size !== observationSeqs.length
    || sortedActionSeqs.some((value, index) => value !== index + 1)
    || sortedObservationSeqs.some((value, index) => value !== index + 1)
    || nextActionSeq !== Math.max(0, ...actionSeqs) + 1
    || nextObservationSeq !== Math.max(0, ...observationSeqs) + 1
  ) corruptBrowserWorkflowState('actionJournal.sequence')
  return {
    nextActionSeq,
    nextObservationSeq,
    activeAction: active,
    settledOutcomes: settled,
    observationReceipts: observations,
  }
}

export function parseBrowserWorkflowObservationResources(
  payload: Record<string, unknown>,
  expectedTaskId?: string,
): BrowserWorkflowObservationResource[] {
  if (!Object.prototype.hasOwnProperty.call(payload, 'browserWorkflowObservationResources')) return []
  if (!Array.isArray(payload.browserWorkflowObservationResources)) {
    corruptBrowserWorkflowState('observationResources')
  }
  const resources = payload.browserWorkflowObservationResources.map((value, index) => {
    const path = `observationResources[${index}]`
    const resource = requiredRecord(value, path)
    if (resource.mediaType !== 'application/json' || typeof resource.truncated !== 'boolean') {
      corruptBrowserWorkflowState(path)
    }
    const taskId = requiredString(resource.taskId, `${path}.taskId`)
    if (expectedTaskId && taskId !== expectedTaskId) corruptBrowserWorkflowState(`${path}.taskId`)
    return {
      resourceId: requiredString(resource.resourceId, `${path}.resourceId`),
      taskId,
      operationId: requiredOperationId(resource.operationId, `${path}.operationId`),
      ownerRunId: requiredString(resource.ownerRunId, `${path}.ownerRunId`),
      identity: parsePersistedIdentity(resource.identity, `${path}.identity`),
      mediaType: 'application/json' as const,
      content: requiredString(resource.content, `${path}.content`),
      contentDigest: requiredString(resource.contentDigest, `${path}.contentDigest`),
      provenanceDigest: requiredString(resource.provenanceDigest, `${path}.provenanceDigest`),
      truncated: resource.truncated,
      createdAt: requiredTimestamp(resource.createdAt, `${path}.createdAt`),
    }
  })
  if (new Set(resources.map((resource) => resource.resourceId)).size !== resources.length) {
    corruptBrowserWorkflowState('observationResources.resourceId')
  }
  return resources
}

function requiredStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return corruptBrowserWorkflowState(path)
  const result = value.map((item, index) => requiredString(item, `${path}[${index}]`))
  if (new Set(result).size !== result.length) corruptBrowserWorkflowState(path)
  return result
}

function parsePersistedResearchWorkItem(value: unknown, path: string): BrowserResearchWorkItem {
  const item = requiredRecord(value, path)
  if (typeof item.required !== 'boolean') corruptBrowserWorkflowState(`${path}.required`)
  return {
    workItemId: requiredString(item.workItemId, `${path}.workItemId`),
    goalRefs: requiredStringArray(item.goalRefs, `${path}.goalRefs`),
    requirement: optionalStringOrNull(item.requirement, `${path}.requirement`),
    query: optionalStringOrNull(item.query, `${path}.query`),
    url: optionalStringOrNull(item.url, `${path}.url`),
    fieldGoals: requiredStringArray(item.fieldGoals, `${path}.fieldGoals`),
    required: item.required,
    evidenceRefIds: requiredStringArray(item.evidenceRefIds, `${path}.evidenceRefIds`),
    createdAt: requiredTimestamp(item.createdAt, `${path}.createdAt`),
  }
}

function parsePersistedResearchEvidenceRef(value: unknown, path: string): BrowserResearchEvidenceRef {
  const ref = requiredRecord(value, path)
  return {
    evidenceRefId: requiredString(ref.evidenceRefId, `${path}.evidenceRefId`),
    workItemId: requiredString(ref.workItemId, `${path}.workItemId`),
    observationReceiptId: requiredString(ref.observationReceiptId, `${path}.observationReceiptId`),
    actionReceiptId: optionalStringOrNull(ref.actionReceiptId, `${path}.actionReceiptId`),
    observationSeq: requiredPositiveInteger(ref.observationSeq, `${path}.observationSeq`),
    actionSeq: ref.actionSeq === null
      ? null
      : requiredPositiveInteger(ref.actionSeq, `${path}.actionSeq`),
    operationId: requiredOperationId(ref.operationId, `${path}.operationId`),
    resultDigest: requiredString(ref.resultDigest, `${path}.resultDigest`),
    resourceId: requiredString(ref.resourceId, `${path}.resourceId`),
    contentDigest: requiredString(ref.contentDigest, `${path}.contentDigest`),
    provenanceDigest: requiredString(ref.provenanceDigest, `${path}.provenanceDigest`),
    identity: parsePersistedIdentity(ref.identity, `${path}.identity`),
    createdAt: requiredTimestamp(ref.createdAt, `${path}.createdAt`),
  }
}

export function parseBrowserResearchState(payload: Record<string, unknown>): BrowserResearchPayloadState {
  if (!Object.prototype.hasOwnProperty.call(payload, 'browserResearch')) {
    return { version: 1, workItems: [], evidenceRefs: [] }
  }
  const raw = requiredRecord(payload.browserResearch, 'browserResearch')
  if (raw.version !== 1 || !Array.isArray(raw.workItems) || !Array.isArray(raw.evidenceRefs)) {
    return corruptBrowserWorkflowState('browserResearch')
  }
  const workItems = raw.workItems.map((item, index) => (
    parsePersistedResearchWorkItem(item, `browserResearch.workItems[${index}]`)
  ))
  const evidenceRefs = raw.evidenceRefs.map((item, index) => (
    parsePersistedResearchEvidenceRef(item, `browserResearch.evidenceRefs[${index}]`)
  ))
  if (
    workItems.length === 0
    || new Set(workItems.map((item) => item.workItemId)).size !== workItems.length
    || new Set(evidenceRefs.map((item) => item.evidenceRefId)).size !== evidenceRefs.length
  ) corruptBrowserWorkflowState('browserResearch.identity')
  return { version: 1, workItems, evidenceRefs }
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > maxLength) throw new Error('browser_research_value_too_long')
  return normalized
}

function boundedStrings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  if (value.length > maxItems) throw new Error('browser_research_list_too_large')
  const seen = new Set<string>()
  const values: string[] = []
  for (const item of value) {
    const normalized = boundedString(item, maxLength)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    values.push(normalized)
  }
  return values
}

export function browserResearchBoundedString(value: unknown, maxLength: number): string | null {
  return boundedString(value, maxLength)
}

export function stableBrowserResearchWorkItem(
  taskId: string,
  input: BrowserResearchWorkItemInput,
  createdAt: string,
): BrowserResearchWorkItem {
  const goalRefs = boundedStrings(input.goalRefs, 64, 256)
  const fieldGoals = boundedStrings(input.fieldGoals, 64, 512)
  const requirement = boundedString(input.requirement, 4_000)
  const query = boundedString(input.query, 2_000)
  const url = boundedString(input.url, 4_000)
  if (!requirement && !query && !url && fieldGoals.length === 0 && goalRefs.length === 0) {
    throw new Error('browser_research_work_item_empty')
  }
  const content = { goalRefs, requirement, query, url, fieldGoals, required: input.required !== false }
  const suppliedId = boundedString(input.workItemId, 256)
  return {
    workItemId: suppliedId || `browser-research-work-${browserWorkflowStableDigest({ taskId, content }).slice(0, 32)}`,
    ...content,
    evidenceRefIds: [],
    createdAt,
  }
}

export function sameBrowserDocumentIdentity(
  left: BrowserActionTargetIdentity,
  right: BrowserActionTargetIdentity,
): boolean {
  if (left.documentState !== 'document' || right.documentState !== 'document') return false
  return left.tabId === right.tabId
    && left.physicalTargetToken === right.physicalTargetToken
    && left.frameId === right.frameId
    && left.frameDocumentToken === right.frameDocumentToken
}

export function hasCompleteBrowserDocumentIdentity(identity: BrowserActionTargetIdentity): boolean {
  return identity.documentState === 'document'
    && Boolean(identity.tabId)
    && Boolean(identity.physicalTargetToken)
    && Boolean(identity.frameId)
    && Boolean(identity.frameDocumentToken)
}

function sameBrowserActionTargetIdentity(
  left: BrowserActionTargetIdentity,
  right: BrowserActionTargetIdentity,
): boolean {
  if (left.documentState === 'no_document' || right.documentState === 'no_document') {
    return left.documentState === right.documentState
  }
  return sameBrowserDocumentIdentity(left, right) && left.targetRef === right.targetRef
}

export type TrustedBrowserPageRefPin = {
  tabId: string
  physicalTargetToken: string
  mainFrameDocumentToken: string
}

function pinMatchesPredecessor(
  pin: TrustedBrowserPageRefPin,
  identity: BrowserActionTargetIdentity,
): boolean {
  return identity.documentState === 'document'
    && identity.tabId === pin.tabId
    && identity.physicalTargetToken === pin.physicalTargetToken
    && identity.frameId === '0'
    && identity.frameDocumentToken === pin.mainFrameDocumentToken
}

export function resolveTrustedBrowserPageRefFromControlledNavigation(
  admissionPin: TrustedBrowserPageRefPin,
  outcomes: readonly BrowserActionOutcome[],
): TrustedBrowserPageRefPin {
  let current = admissionPin
  for (const outcome of [...outcomes].sort((left, right) => left.actionSeq - right.actionSeq)) {
    if (outcome.dispatch === 'rejected' || outcome.delivery === 'not_delivered') continue
    if (!hasCompleteBrowserDocumentIdentity(outcome.successorIdentity)) continue
    if (outcome.successorIdentity.tabId !== current.tabId) continue
    if (outcome.successorIdentity.physicalTargetToken !== current.physicalTargetToken) continue
    if (outcome.successorIdentity.frameId !== '0') continue
    if (!pinMatchesPredecessor(current, outcome.identity)) continue
    if (outcome.successorIdentity.frameDocumentToken === current.mainFrameDocumentToken) continue
    current = {
      tabId: current.tabId,
      physicalTargetToken: current.physicalTargetToken,
      mainFrameDocumentToken: outcome.successorIdentity.frameDocumentToken,
    }
  }
  return current
}

export function resolveBrowserObservationSuccessorIdentity(
  outcome: BrowserActionOutcome,
  observedIdentity: BrowserActionTargetIdentity,
): BrowserActionTargetIdentity | null {
  const deferredTabsOpenTabId = outcome.operationId === 'tabs_open'
    && sameBrowserActionTargetIdentity(outcome.identity, outcome.successorIdentity)
    && typeof outcome.postActionTabId === 'string'
    ? outcome.postActionTabId
    : null
  if (deferredTabsOpenTabId) {
    return hasCompleteBrowserDocumentIdentity(observedIdentity)
      && observedIdentity.tabId === deferredTabsOpenTabId
      ? observedIdentity
      : null
  }
  if (
    hasCompleteBrowserDocumentIdentity(outcome.successorIdentity)
    && sameBrowserDocumentIdentity(outcome.successorIdentity, observedIdentity)
  ) return outcome.successorIdentity
  return null
}

export function assessBrowserResearch(
  taskId: string,
  state: BrowserResearchPayloadState,
): BrowserResearchAssessment {
  const missingWorkItemIds = state.workItems
    .filter((item) => item.required && item.evidenceRefIds.length === 0)
    .map((item) => item.workItemId)
  return {
    taskId,
    satisfied: state.workItems.length > 0 && missingWorkItemIds.length === 0,
    missingWorkItemIds,
    workItems: state.workItems,
    evidenceRefs: state.evidenceRefs,
  }
}

export function browserObservationProvenanceDigest(
  taskId: string,
  receipt: Pick<BrowserWorkflowObservationReceipt,
    'operationId' | 'ownerRunId' | 'identity' | 'resultDigest' | 'observedAt'>,
): string {
  return browserWorkflowStableDigest({
    taskId,
    operationId: receipt.operationId,
    ownerRunId: receipt.ownerRunId,
    identity: receipt.identity,
    resultDigest: receipt.resultDigest,
    observedAt: receipt.observedAt,
  })
}

export function verifyBrowserObservationResource(
  taskId: string,
  resource: BrowserWorkflowObservationResource,
  receipt: BrowserWorkflowObservationReceipt,
): BrowserWorkflowObservationResource {
  if (resource.taskId !== taskId || receipt.resourceId !== resource.resourceId) {
    throw new Error(`browser_observation_resource_binding_mismatch:${resource.resourceId}`)
  }
  if (resource.operationId !== receipt.operationId
    || resource.ownerRunId !== receipt.ownerRunId
    || resource.createdAt !== receipt.observedAt
    || browserWorkflowStableDigest(resource.identity) !== browserWorkflowStableDigest(receipt.identity)) {
    throw new Error(`browser_observation_resource_provenance_fields_mismatch:${resource.resourceId}`)
  }
  const contentDigest = createHash('sha256').update(resource.content).digest('hex')
  if (contentDigest !== resource.contentDigest) {
    throw new Error(`browser_observation_resource_content_digest_mismatch:${resource.resourceId}`)
  }
  let contentValue: unknown
  try { contentValue = JSON.parse(resource.content) } catch {
    throw new Error(`browser_observation_resource_invalid_json:${resource.resourceId}`)
  }
  const contentRecord = asRecord(contentValue)
  if (
    !contentRecord
    || contentRecord.operationId !== receipt.operationId
    || browserWorkflowStableDigest(contentValue) !== receipt.resultDigest
  ) {
    throw new Error(`browser_observation_resource_result_digest_mismatch:${resource.resourceId}`)
  }
  const provenanceDigest = browserObservationProvenanceDigest(taskId, receipt)
  if (provenanceDigest !== resource.provenanceDigest) {
    throw new Error(`browser_observation_resource_provenance_digest_mismatch:${resource.resourceId}`)
  }
  const expectedResourceId = `browser-observation-resource-${browserWorkflowStableDigest({
    taskId,
    observationSeq: receipt.observationSeq,
    contentDigest,
    provenanceDigest,
  }).slice(0, 32)}`
  if (resource.resourceId !== expectedResourceId) {
    throw new Error(`browser_observation_resource_id_mismatch:${resource.resourceId}`)
  }
  const expectedReceiptId = `browser-observation-${browserWorkflowStableDigest({
    taskId,
    observationSeq: receipt.observationSeq,
    operationId: receipt.operationId,
    ownerRunId: receipt.ownerRunId,
    observedAfterActionSeq: receipt.observedAfterActionSeq,
    identity: receipt.identity,
    searchActionId: receipt.searchActionId,
    queryDigest: receipt.queryDigest,
    causalActions: receipt.causalActions,
    resultDigest: receipt.resultDigest,
    resourceId: receipt.resourceId,
  }).slice(0, 32)}`
  if (receipt.receiptId !== expectedReceiptId) {
    throw new Error(`browser_observation_receipt_id_mismatch:${receipt.receiptId}`)
  }
  return resource
}

export function browserObservationResourceUsableAsResearchEvidence(
  resource: BrowserWorkflowObservationResource,
): boolean {
  try {
    const content = asRecord(JSON.parse(resource.content))
    const result = asRecord(content?.result)
    return content?.usableAsResearchEvidence !== false
      && result?.usableAsResearchEvidence !== false
  } catch {
    return false
  }
}

export function readVerifiedBrowserWorkflowEvidence(
  taskId: string,
  payload: Record<string, unknown>,
): VerifiedBrowserWorkflowEvidence {
  const state = parseBrowserResearchState(payload)
  const journal = parseBrowserWorkflowActionJournal(payload, taskId)
  const resourceList = parseBrowserWorkflowObservationResources(payload, taskId)
  const resources = new Map(resourceList
    .map((resource) => [resource.resourceId, resource]))
  const receiptByResource = new Map(journal.observationReceipts
    .map((receipt) => [receipt.resourceId, receipt]))
  const workItems = new Map(state.workItems.map((item) => [item.workItemId, item]))
  const evidence = new Map(state.evidenceRefs.map((ref) => [ref.evidenceRefId, ref]))

  if (
    resources.size !== resourceList.length
    || receiptByResource.size !== journal.observationReceipts.length
    || resources.size !== receiptByResource.size
  ) throw new Error('browser_observation_resource_receipt_set_mismatch')
  for (const resource of resourceList) {
    const receipt = receiptByResource.get(resource.resourceId)
    if (!receipt) throw new Error('browser_observation_resource_receipt_set_mismatch')
    verifyBrowserObservationResource(taskId, resource, receipt)
  }

  for (const item of state.workItems) {
    for (const evidenceRefId of item.evidenceRefIds) {
      const ref = evidence.get(evidenceRefId)
      if (!ref || ref.workItemId !== item.workItemId) {
        throw new Error(`browser_research_work_item_evidence_drift:${item.workItemId}`)
      }
    }
  }
  for (const ref of state.evidenceRefs) {
    const workItem = workItems.get(ref.workItemId)
    if (!workItem || !workItem.evidenceRefIds.includes(ref.evidenceRefId)) {
      throw new Error(`browser_research_evidence_work_item_drift:${ref.evidenceRefId}`)
    }
    const receipt = journal.observationReceipts.find((item) => item.receiptId === ref.observationReceiptId)
    if (!receipt) throw new Error(`browser_research_observation_receipt_not_found:${ref.observationReceiptId}`)
    const resource = resources.get(ref.resourceId)
    if (!resource) throw new Error(`browser_research_observation_resource_not_found:${ref.resourceId}`)
    verifyBrowserObservationResource(taskId, resource, receipt)
    if (!browserObservationResourceUsableAsResearchEvidence(resource)) {
      throw new Error(`browser_research_observation_not_usable_as_evidence:${ref.observationReceiptId}`)
    }
    if (receipt.observationSeq !== ref.observationSeq
      || receipt.operationId !== ref.operationId
      || receipt.resultDigest !== ref.resultDigest
      || receipt.resourceId !== ref.resourceId
      || resource.contentDigest !== ref.contentDigest
      || resource.provenanceDigest !== ref.provenanceDigest
      || browserWorkflowStableDigest(receipt.identity) !== browserWorkflowStableDigest(ref.identity)) {
      throw new Error(`browser_research_evidence_receipt_drift:${ref.evidenceRefId}`)
    }
    const expectedEvidenceRefId = `browser-research-evidence-${browserWorkflowStableDigest({
      taskId,
      workItemId: ref.workItemId,
      observationReceiptId: ref.observationReceiptId,
      actionReceiptId: ref.actionReceiptId,
    }).slice(0, 32)}`
    if (ref.evidenceRefId !== expectedEvidenceRefId) {
      throw new Error(`browser_research_evidence_id_drift:${ref.evidenceRefId}`)
    }
    if (ref.actionReceiptId) {
      const action = journal.settledOutcomes.find((item) => item.receiptId === ref.actionReceiptId)
      const causal = action
        ? receipt.causalActions.find((item) => item.actionId === action.actionId && item.actionSeq === action.actionSeq)
        : null
      if (!action || !causal || ref.actionSeq !== action.actionSeq) {
        throw new Error(`browser_research_action_receipt_drift:${ref.evidenceRefId}`)
      }
    } else if (ref.actionSeq !== null) {
      throw new Error(`browser_research_action_receipt_drift:${ref.evidenceRefId}`)
    }
  }

  const observedActions = new Set(journal.observationReceipts.flatMap((receipt) => (
    receipt.causalActions.map((action) => `${action.actionId}:${action.actionSeq}`)
  )))
  const unresolvedActions = journal.settledOutcomes.filter((item) => {
    const outcome = item.outcome
    if (outcome.dispatch === 'rejected' || outcome.delivery === 'not_delivered') return false
    if (!outcome.needsObservation && !outcome.mayHaveCommitted) return false
    return !observedActions.has(`${item.actionId}:${item.actionSeq}`)
  })
  const researchAssessment = state.workItems.length > 0
    ? assessBrowserResearch(taskId, state)
    : null

  return {
    journal,
    resources: resourceList,
    researchState: !researchAssessment
      ? 'not_requested'
      : researchAssessment.satisfied
        ? 'satisfied'
        : 'incomplete',
    researchAssessment,
    unresolvedActions,
  }
}
