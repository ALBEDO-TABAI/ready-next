import type { WorkflowDatabaseAccessor } from './browser-workflow-unit-of-work'
import { BrowserWorkflowUnitOfWork } from './browser-workflow-unit-of-work'
import { AgentSessionCheckpointTakeoverRepository } from './agent-session-checkpoint-takeover'
import { AgentSessionCheckpointConfirmationLifecycleRepository } from './agent-session-checkpoint-confirmation-lifecycle'
import { AgentSessionCheckpointOwnerRecoveryRepository } from './agent-session-checkpoint-owner-recovery'
import { AgentSessionCheckpointTypedResumeRepository } from './agent-session-checkpoint-typed-resume'
import { AgentSessionCheckpointTakeoverExpiryRepository } from './agent-session-checkpoint-takeover-expiry'

export class AgentSessionCheckpointResumeRepository {
  private readonly takeover: AgentSessionCheckpointTakeoverRepository
  private readonly confirmation: AgentSessionCheckpointConfirmationLifecycleRepository
  private readonly ownerRecovery: AgentSessionCheckpointOwnerRecoveryRepository
  private readonly typedResume: AgentSessionCheckpointTypedResumeRepository
  private readonly takeoverExpiry: AgentSessionCheckpointTakeoverExpiryRepository

  constructor(accessor: WorkflowDatabaseAccessor, readonly unitOfWork: BrowserWorkflowUnitOfWork) {
    this.takeover = new AgentSessionCheckpointTakeoverRepository(accessor, unitOfWork)
    this.confirmation = new AgentSessionCheckpointConfirmationLifecycleRepository(accessor, unitOfWork)
    this.ownerRecovery = new AgentSessionCheckpointOwnerRecoveryRepository(accessor, unitOfWork)
    this.typedResume = new AgentSessionCheckpointTypedResumeRepository(accessor, unitOfWork)
    this.takeoverExpiry = new AgentSessionCheckpointTakeoverExpiryRepository(unitOfWork)
  }

  createHumanTakeoverIntent(input: Parameters<AgentSessionCheckpointTakeoverRepository['createHumanTakeoverIntent']>[0]) {
    return this.takeover.createHumanTakeoverIntent(input)
  }

  expirePendingHumanTakeovers(input?: Parameters<AgentSessionCheckpointTakeoverExpiryRepository['expirePendingHumanTakeovers']>[0]) {
    return this.takeoverExpiry.expirePendingHumanTakeovers(input)
  }

  completeHumanTakeover(input: Parameters<AgentSessionCheckpointTakeoverRepository['completeHumanTakeover']>[0]) {
    return this.takeover.completeHumanTakeover(input)
  }

  currentBrowserPowerConfirmation(parentTaskId: string) {
    return this.confirmation.currentBrowserPowerConfirmation(parentTaskId)
  }

  expirePendingBrowserConfirmations(input?: Parameters<AgentSessionCheckpointConfirmationLifecycleRepository['expirePendingBrowserConfirmations']>[0]) {
    return this.confirmation.expirePendingBrowserConfirmations(input)
  }

  currentBrowserPermissionConfirmation(parentTaskId: string) {
    return this.confirmation.currentBrowserPermissionConfirmation(parentTaskId)
  }

  currentOwnerCrashRecovery(parentTaskId: string) {
    return this.ownerRecovery.currentOwnerCrashRecovery(parentTaskId)
  }

  settleOwnerFailure(input: Parameters<AgentSessionCheckpointOwnerRecoveryRepository['settleOwnerFailure']>[0]) {
    return this.ownerRecovery.settleOwnerFailure(input)
  }

  resumeSuspendedBrowserWorkflow(input: Parameters<AgentSessionCheckpointTypedResumeRepository['resumeSuspendedBrowserWorkflow']>[0]) {
    return this.typedResume.resumeSuspendedBrowserWorkflow(input)
  }
}
