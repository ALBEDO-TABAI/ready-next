import type { ReadyAgentSdkRunParams, ToolBridgeResultItem, ToolBridgeRuntimeContext } from './agent-sdk-types'
import type { ExecutionTurnResult } from '../contracts/run-contracts'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import { buildTextToolResultMessage } from '../../claude-bridge/tool-bridge'
import { browserWorkflowStableDigest } from '../../browser-engine/browser-workflow-evidence'
import { buildBrowserObservationRequiredInput } from '../system-reminders/browser-observation-required-reminder'
import { buildBrowserResearchIncompleteInput } from '../system-reminders/browser-research-incomplete-reminder'
import { syncBrowserObservationGapsFromJournal } from './agent-sdk-browser-turn-control'

type BrowserCandidateClosurePhase =
  | 'idle'
  | 'observation_pending'
  | 'observation_running'
  | 'synthesis_pending'
  | 'synthesis_running'

interface BrowserCandidateClosureState {
  finalText: string
  nextInput: ReadyAgentSdkRunParams['input']
}

export interface BrowserCandidateClosureTurn {
  observationClosureTurn: boolean
  observationSynthesisTurn: boolean
}

const MAX_STALLED_RESEARCH_TERMINAL_CANDIDATES = 2

export function createBrowserCandidateClosureController(input: {
  state: BrowserCandidateClosureState
  host: Pick<TurnOrchestratorHost, 'readVerifiedBrowserWorkflowEvidence'>
  runtimeContext: ToolBridgeRuntimeContext
  emitHeartbeat: (text: string) => void
  candidateOutputBuffer?: { replace(text: string): void }
  finishObservationCheckpoint: (message?: string) => Promise<ExecutionTurnResult>
  finishIncompleteCheckpoint: (message?: string) => Promise<ExecutionTurnResult>
}) {
  let phase: BrowserCandidateClosurePhase = 'idle'
  let lastIncompleteResearchProgressDigest: string | null = null
  let stalledIncompleteResearchCandidates = 0

  const readEvidence = () => {
    const route = input.runtimeContext.browserWorkflowRoute
    if (!route) return null
    const evidence = input.host.readVerifiedBrowserWorkflowEvidence(route.browserTaskId)
    if (!evidence) throw new Error('browser_observation_evidence_unavailable')
    syncBrowserObservationGapsFromJournal(
      input.runtimeContext,
      evidence.unresolvedActions.map((entry) => ({
        actionId: entry.actionId,
        actionSeq: entry.actionSeq,
        outcome: entry.outcome as unknown as Record<string, unknown>,
      })),
    )
    return evidence
  }

  const finishObservationSynthesisCheckpoint = () => input.finishObservationCheckpoint(
    '页面状态已经核对，但兼容接口没有形成最终答复。我已保存现场，继续时不会重复之前的动作。',
  )

  return {
    hasPendingTurn(): boolean {
      return phase === 'observation_pending' || phase === 'synthesis_pending'
    },

    beginTurn(): BrowserCandidateClosureTurn {
      const observationClosureTurn = phase === 'observation_pending'
      const observationSynthesisTurn = phase === 'synthesis_pending'
      if (observationClosureTurn) phase = 'observation_running'
      if (observationSynthesisTurn) phase = 'synthesis_running'
      input.runtimeContext.browserObservationClosureActive = observationClosureTurn
      return { observationClosureTurn, observationSynthesisTurn }
    },

    async continueAfterObservationToolResults(
      bridgeResults: ToolBridgeResultItem[],
      visibleText: string,
    ): Promise<'continue' | ExecutionTurnResult | null> {
      if (phase !== 'observation_running') return null
      input.state.nextInput = buildTextToolResultMessage(bridgeResults)
      input.state.finalText = visibleText
      input.runtimeContext.browserObservationClosureActive = false
      readEvidence()
      if (input.runtimeContext.browserObservationBarrier) {
        return input.finishObservationCheckpoint()
      }
      phase = 'synthesis_pending'
      return 'continue'
    },

    finishObservationSynthesisCheckpoint,

    async guardTerminalCandidate(
      candidateStart: string,
    ): Promise<'continue' | ExecutionTurnResult | null> {
      if (!input.runtimeContext.browserWorkflowRoute) return null
      const evidence = readEvidence()
      if (!evidence) return null
      if (input.runtimeContext.browserObservationBarrier) {
        input.candidateOutputBuffer?.replace(candidateStart)
        input.state.finalText = ''
        if (phase === 'idle') {
          phase = 'observation_pending'
          input.state.nextInput = buildBrowserObservationRequiredInput(
            input.runtimeContext.browserObservationGaps,
          )
          input.emitHeartbeat('正在核对刚才的页面变化…')
          return 'continue'
        }
        return input.finishObservationCheckpoint()
      }
      if (evidence.researchState !== 'incomplete' || !evidence.researchAssessment) return null

      input.candidateOutputBuffer?.replace(candidateStart)
      input.state.finalText = ''
      const missingWorkItemIds = new Set(evidence.researchAssessment.missingWorkItemIds)
      const progressDigest = browserWorkflowStableDigest({
        requiredWorkItemCoverage: evidence.researchAssessment.workItems
          .filter((item) => item.required)
          .map((item) => ({
            workItemId: item.workItemId,
            completed: !missingWorkItemIds.has(item.workItemId),
            evidenceRefIds: [...item.evidenceRefIds].sort(),
          }))
          .sort((left, right) => left.workItemId.localeCompare(right.workItemId)),
      })
      if (progressDigest === lastIncompleteResearchProgressDigest) {
        stalledIncompleteResearchCandidates += 1
      } else {
        lastIncompleteResearchProgressDigest = progressDigest
        stalledIncompleteResearchCandidates = 0
      }
      if (stalledIncompleteResearchCandidates >= MAX_STALLED_RESEARCH_TERMINAL_CANDIDATES) {
        return input.finishIncompleteCheckpoint(
          '任务仍有未完成的研究项，但连续两次继续后没有新增页面证据。我已保存现场，避免空转；可以从当前进度继续。',
        )
      }
      input.state.nextInput = buildBrowserResearchIncompleteInput(evidence.researchAssessment)
      input.emitHeartbeat('研究项还没有全部完成，正在继续…')
      return 'continue'
    },

    clear(): void {
      input.runtimeContext.browserObservationClosureActive = false
    },
  }
}
