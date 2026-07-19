import type { BrowserHumanTakeoverPhysicalTarget } from '../../../shared/browser-workflow-control'
import { workflowDigest } from './browser-workflow-codec'
import {
  BrowserWorkflowUnitOfWork,
  type DurableWriteResult,
  type WorkflowDatabaseAccessor,
  type WorkflowRawDatabase,
} from './browser-workflow-unit-of-work'
import { AgentSessionCheckpointRouteRepository } from './agent-session-checkpoint-route'
import { AgentSessionCheckpointCloseoutRepository } from './agent-session-checkpoint-closeout'
import { AgentSessionCheckpointSteeringRepository } from './agent-session-checkpoint-steering'
import { AgentSessionCheckpointResumeRepository } from './agent-session-checkpoint-resume'
import { AgentSessionCheckpointStoreRepository } from './agent-session-checkpoint-store'
import { AgentSessionCheckpointJournalRepository } from './agent-session-checkpoint-journal'

export { workflowDigest } from './browser-workflow-codec'
export {
  BrowserWorkflowUnitOfWork,
  type DurableWriteResult,
  type WorkflowDatabaseAccessor,
  type WorkflowRawDatabase,
} from './browser-workflow-unit-of-work'
export type {
  AgentSessionCheckpoint,
  BrowserWorkflowParentRecord,
} from './browser-workflow-row-mapping'
export type * from './agent-session-checkpoint-types'

export class AgentSessionCheckpointRepository {
  readonly unitOfWork: BrowserWorkflowUnitOfWork
  private readonly route: AgentSessionCheckpointRouteRepository
  private readonly closeout: AgentSessionCheckpointCloseoutRepository
  private readonly steering: AgentSessionCheckpointSteeringRepository
  private readonly resume: AgentSessionCheckpointResumeRepository
  private readonly store: AgentSessionCheckpointStoreRepository
  private readonly journal: AgentSessionCheckpointJournalRepository

  constructor(accessor: WorkflowDatabaseAccessor) {
    this.unitOfWork = new BrowserWorkflowUnitOfWork(accessor)
    this.route = new AgentSessionCheckpointRouteRepository(accessor, this.unitOfWork)
    this.closeout = new AgentSessionCheckpointCloseoutRepository(this.unitOfWork)
    this.steering = new AgentSessionCheckpointSteeringRepository(accessor, this.unitOfWork)
    this.resume = new AgentSessionCheckpointResumeRepository(accessor, this.unitOfWork)
    this.store = new AgentSessionCheckpointStoreRepository(accessor, this.unitOfWork)
    this.journal = new AgentSessionCheckpointJournalRepository(this.unitOfWork)
  }

  inspectWorkflowCloseout(
    ...args: Parameters<AgentSessionCheckpointRepository['route']['inspectWorkflowCloseout']>
  ): ReturnType<AgentSessionCheckpointRepository['route']['inspectWorkflowCloseout']> {
    return this.route.inspectWorkflowCloseout(...args)
  }

  isBrowserWorkflowBound(
    ...args: Parameters<AgentSessionCheckpointRepository['route']['isBrowserWorkflowBound']>
  ): ReturnType<AgentSessionCheckpointRepository['route']['isBrowserWorkflowBound']> {
    return this.route.isBrowserWorkflowBound(...args)
  }

  readWorkflowVerifierBundle(
    ...args: Parameters<AgentSessionCheckpointRepository['route']['readWorkflowVerifierBundle']>
  ): ReturnType<AgentSessionCheckpointRepository['route']['readWorkflowVerifierBundle']> {
    return this.route.readWorkflowVerifierBundle(...args)
  }

  bindBrowserWorkflowRoute(
    ...args: Parameters<AgentSessionCheckpointRepository['route']['bindBrowserWorkflowRoute']>
  ): ReturnType<AgentSessionCheckpointRepository['route']['bindBrowserWorkflowRoute']> {
    return this.route.bindBrowserWorkflowRoute(...args)
  }

  commitCanonicalCoreCloseout(
    ...args: Parameters<AgentSessionCheckpointRepository['closeout']['commitCanonicalCoreCloseout']>
  ): ReturnType<AgentSessionCheckpointRepository['closeout']['commitCanonicalCoreCloseout']> {
    return this.closeout.commitCanonicalCoreCloseout(...args)
  }

  persistCanonicalMessageAndSteer(
    ...args: Parameters<AgentSessionCheckpointRepository['steering']['persistCanonicalMessageAndSteer']>
  ): ReturnType<AgentSessionCheckpointRepository['steering']['persistCanonicalMessageAndSteer']> {
    return this.steering.persistCanonicalMessageAndSteer(...args)
  }

  hasPendingSteering(
    ...args: Parameters<AgentSessionCheckpointRepository['steering']['hasPendingSteering']>
  ): ReturnType<AgentSessionCheckpointRepository['steering']['hasPendingSteering']> {
    return this.steering.hasPendingSteering(...args)
  }

  createHumanTakeoverIntent(
    ...args: Parameters<AgentSessionCheckpointRepository['resume']['createHumanTakeoverIntent']>
  ): ReturnType<AgentSessionCheckpointRepository['resume']['createHumanTakeoverIntent']> {
    return this.resume.createHumanTakeoverIntent(...args)
  }

  completeHumanTakeover(
    ...args: Parameters<AgentSessionCheckpointRepository['resume']['completeHumanTakeover']>
  ): ReturnType<AgentSessionCheckpointRepository['resume']['completeHumanTakeover']> {
    return this.resume.completeHumanTakeover(...args)
  }

  currentBrowserPowerConfirmation(
    ...args: Parameters<AgentSessionCheckpointRepository['resume']['currentBrowserPowerConfirmation']>
  ): ReturnType<AgentSessionCheckpointRepository['resume']['currentBrowserPowerConfirmation']> {
    return this.resume.currentBrowserPowerConfirmation(...args)
  }

  currentBrowserPermissionConfirmation(
    ...args: Parameters<AgentSessionCheckpointRepository['resume']['currentBrowserPermissionConfirmation']>
  ): ReturnType<AgentSessionCheckpointRepository['resume']['currentBrowserPermissionConfirmation']> {
    return this.resume.currentBrowserPermissionConfirmation(...args)
  }

  currentOwnerCrashRecovery(
    ...args: Parameters<AgentSessionCheckpointRepository['resume']['currentOwnerCrashRecovery']>
  ): ReturnType<AgentSessionCheckpointRepository['resume']['currentOwnerCrashRecovery']> {
    return this.resume.currentOwnerCrashRecovery(...args)
  }

  settleOwnerLaunchFailure(
    ...args: Parameters<AgentSessionCheckpointRepository['resume']['settleOwnerLaunchFailure']>
  ): ReturnType<AgentSessionCheckpointRepository['resume']['settleOwnerLaunchFailure']> {
    return this.resume.settleOwnerLaunchFailure(...args)
  }

  resumeSuspendedBrowserWorkflow(
    ...args: Parameters<AgentSessionCheckpointRepository['resume']['resumeSuspendedBrowserWorkflow']>
  ): ReturnType<AgentSessionCheckpointRepository['resume']['resumeSuspendedBrowserWorkflow']> {
    return this.resume.resumeSuspendedBrowserWorkflow(...args)
  }

  writeCleanBoundary(
    ...args: Parameters<AgentSessionCheckpointRepository['store']['writeCleanBoundary']>
  ): ReturnType<AgentSessionCheckpointRepository['store']['writeCleanBoundary']> {
    return this.store.writeCleanBoundary(...args)
  }

  current(
    ...args: Parameters<AgentSessionCheckpointRepository['store']['current']>
  ): ReturnType<AgentSessionCheckpointRepository['store']['current']> {
    return this.store.current(...args)
  }

  read(
    ...args: Parameters<AgentSessionCheckpointRepository['store']['read']>
  ): ReturnType<AgentSessionCheckpointRepository['store']['read']> {
    return this.store.read(...args)
  }

  latestForDiagnostics(
    ...args: Parameters<AgentSessionCheckpointRepository['store']['latestForDiagnostics']>
  ): ReturnType<AgentSessionCheckpointRepository['store']['latestForDiagnostics']> {
    return this.store.latestForDiagnostics(...args)
  }

  readBrowserObservationGaps(
    ...args: Parameters<AgentSessionCheckpointRepository['store']['readBrowserObservationGaps']>
  ): ReturnType<AgentSessionCheckpointRepository['store']['readBrowserObservationGaps']> {
    return this.store.readBrowserObservationGaps(...args)
  }

  deleteForParent(
    ...args: Parameters<AgentSessionCheckpointRepository['store']['deleteForParent']>
  ): ReturnType<AgentSessionCheckpointRepository['store']['deleteForParent']> {
    return this.store.deleteForParent(...args)
  }

  beginBrowserWorkflowAction(
    ...args: Parameters<AgentSessionCheckpointRepository['journal']['beginBrowserWorkflowAction']>
  ): ReturnType<AgentSessionCheckpointRepository['journal']['beginBrowserWorkflowAction']> {
    return this.journal.beginBrowserWorkflowAction(...args)
  }

  settleBrowserWorkflowAction(
    ...args: Parameters<AgentSessionCheckpointRepository['journal']['settleBrowserWorkflowAction']>
  ): ReturnType<AgentSessionCheckpointRepository['journal']['settleBrowserWorkflowAction']> {
    return this.journal.settleBrowserWorkflowAction(...args)
  }

  recordBrowserWorkflowObservation(
    ...args: Parameters<AgentSessionCheckpointRepository['journal']['recordBrowserWorkflowObservation']>
  ): ReturnType<AgentSessionCheckpointRepository['journal']['recordBrowserWorkflowObservation']> {
    return this.journal.recordBrowserWorkflowObservation(...args)
  }

  upsertBrowserResearchWorkItems(
    ...args: Parameters<AgentSessionCheckpointRepository['journal']['upsertBrowserResearchWorkItems']>
  ): ReturnType<AgentSessionCheckpointRepository['journal']['upsertBrowserResearchWorkItems']> {
    return this.journal.upsertBrowserResearchWorkItems(...args)
  }

  bindBrowserResearchEvidence(
    ...args: Parameters<AgentSessionCheckpointRepository['journal']['bindBrowserResearchEvidence']>
  ): ReturnType<AgentSessionCheckpointRepository['journal']['bindBrowserResearchEvidence']> {
    return this.journal.bindBrowserResearchEvidence(...args)
  }

  isBrowserWorkflowWriteAdmitted(input: {
    parentTaskId: string
    ownerRunId: string
    browserTaskId: string
    physicalTarget: BrowserHumanTakeoverPhysicalTarget
  }): boolean {
    return this.route.isBrowserWorkflowWriteAdmitted(input)
  }

  isBrowserWorkflowOwnerAdmitted(input: {
    parentTaskId: string
    ownerRunId: string
    browserTaskId: string
  }): boolean {
    return this.route.isBrowserWorkflowOwnerAdmitted(input)
  }

  isBrowserWorkflowSettlementAdmitted(input: {
    parentTaskId: string
    ownerRunId: string
    browserTaskId: string
  }): boolean {
    return this.route.isBrowserWorkflowSettlementAdmitted(input)
  }
}
