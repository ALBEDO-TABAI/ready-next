import type { DurableWriteResult } from '../../main/modules/repositories/browser-workflow-unit-of-work'
import type { AgentSessionCheckpointRepository } from '../../main/modules/repositories/agent-session-checkpoint-repository'

export type CanonicalCodexFailureInput = {
  parentTaskId: string
  ownerRunId: string
  conversationId: string
  status: 'error' | 'cancelled' | 'interrupted'
  terminalReason: string
  initiator: string
  durationMs: number
  taskType: string
  module: string
  error: string
  verifierReceiptDigest?: string
  now: string
}

export async function commitCanonicalCodexFailure(
  repository: Pick<AgentSessionCheckpointRepository, 'commitCanonicalCoreCloseout'>,
  input: CanonicalCodexFailureInput,
): Promise<DurableWriteResult<{ productTerminalDigest: string; closeoutAt: string }>> {
  const finalText = input.status === 'error'
    ? '本轮未能完成。已经完成的内容和文件状态都已保留；再次尝试时会先核对已有结果，避免重复执行。'
    : '本轮已停止。停止前已经完成的内容和文件状态都已保留。'
  const committed = await repository.commitCanonicalCoreCloseout({
    parentTaskId: input.parentTaskId,
    ownerRunId: input.ownerRunId,
    conversationId: input.conversationId,
    status: input.status,
    terminalReason: input.terminalReason,
    initiator: input.initiator,
    durationMs: input.durationMs,
    taskType: input.taskType,
    module: input.module,
    finalText,
    providerDiagnostics: {
      codexFailure: {
        contract: 'codex_failure_evidence_v1',
        error: input.error,
        module: input.module,
        ...(input.verifierReceiptDigest
          ? { verifierReceiptDigest: input.verifierReceiptDigest }
          : {}),
      },
    },
    now: input.now,
  })
  return {
    value: {
      productTerminalDigest: committed.value.canonicalMessageDigest,
      closeoutAt: committed.value.canonicalMessage.timestamp,
    },
    derivedRepairError: committed.derivedRepairError,
  }
}
