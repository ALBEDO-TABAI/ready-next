import assert from 'node:assert/strict'
import test from 'node:test'

import type { CanonicalAssistantMessage } from '../shared/ipc-contracts/canonical-message'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import {
  finalizeCodexProductCloseout,
  resolveCodexUnownedNativeTerminalCloseout,
} from '../main/modules/agent-control/codex-runtime/codex-product-closeout-support'
import {
  collectArtifactProof,
  collectToolOutputProofs,
  collectTransactionConfirmedProof,
  collectToolResultProof,
} from '../main/modules/agent-control/quality/proof-collector'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

function projection(overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'task-1',
    scopeId: 'scope-1',
    runId: 'run-1',
    taskType: 'short_task',
    module: 'skill',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'none',
    steps: [],
    taskOrigin: 'user_root',
    modelCriteria: ['扫描文件并给出证据', '写回标签'],
    proofRefs: [],
    checkins: [],
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  }
}

test('an unowned native interruption is a runtime failure, not a user stop', () => {
  assert.deepEqual(resolveCodexUnownedNativeTerminalCloseout({
    engineOutcome: 'interrupted',
    publicationDiverged: false,
  }), {
    status: 'error',
    terminalReason: 'blocked_external',
    errorCode: 'codex_unowned_runtime_interrupt',
    closeoutMode: 'product',
  })
  assert.deepEqual(resolveCodexUnownedNativeTerminalCloseout({
    engineOutcome: 'interrupted',
    publicationDiverged: true,
  }), {
    status: 'error',
    terminalReason: 'blocked_external',
    errorCode: 'codex_tool_publication_diverged',
    closeoutMode: 'publication_diverged',
  })
})

test('a failed native turn is retained unless typed history evidence proves divergence', () => {
  assert.equal(resolveCodexUnownedNativeTerminalCloseout({
    engineOutcome: 'failed',
    publicationDiverged: false,
  }).closeoutMode, 'product')
  assert.equal(resolveCodexUnownedNativeTerminalCloseout({
    engineOutcome: 'failed',
    publicationDiverged: true,
  }).closeoutMode, 'publication_diverged')
})

async function finalizeProofProfile(input: {
  taskType: TaskProjectionRecord['taskType']
  toolCalls: Array<{ itemId: string; tool: string; status: string; success: boolean | null }>
  proofs: ReturnType<typeof collectToolResultProof>[]
}): Promise<{ status: string; terminalReason: string }> {
  let row = projection({ taskType: input.taskType, modelCriteria: [] })
  return finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '任务已经完成。',
    },
    toolCalls: input.toolCalls,
    durableProofs: input.proofs,
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (closeout) => ({
      canonicalMessage: {
        id: `assistant:${row.taskId}:${row.runId}:terminal`,
        conversationId: closeout.conversationId,
        role: 'assistant',
        content: closeout.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: closeout.ownerRunId, terminalReason: closeout.terminalReason },
      },
      canonicalMessageDigest: '9'.repeat(64),
    }),
  })
}

test('Codex product closeout rejects a completed native turn when its skill tool calls failed', async () => {
  let row = projection()
  let committedStatus = ''
  let committedReason = ''
  let committedText = ''
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '请提供文件的绝对路径。',
    },
    toolCalls: [
      { itemId: 'prepare-1', tool: 'tag_forge_prepare_batch', status: 'failed', success: false },
      { itemId: 'prepare-2', tool: 'tag_forge_prepare_batch', status: 'failed', success: false },
      { itemId: 'prepare-3', tool: 'tag_forge_prepare_batch', status: 'failed', success: false },
    ],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => {
      committedStatus = input.status
      committedReason = input.terminalReason
      committedText = input.finalText
      const canonicalMessage: CanonicalAssistantMessage = {
        id: 'assistant:task-1:run-1:terminal',
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
      }
      return { canonicalMessage, canonicalMessageDigest: 'a'.repeat(64) }
    },
  })

  assert.equal(finalized.status, 'error')
  assert.equal(finalized.terminalReason, 'blocked_tool_error')
  assert.equal(committedStatus, 'error')
  assert.equal(committedReason, 'blocked_tool_error')
  assert.doesNotMatch(committedText, /绝对路径/)
  assert.match(committedText, /目标没有完成/)
  assert.ok((row.checkins || []).length > 0)
})

test('Codex product closeout rejects a required skill that only claims completion', async () => {
  let row = projection({ modelCriteria: [] })
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '已经完成操作。',
    },
    toolCalls: [],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => ({
      canonicalMessage: {
        id: 'assistant:task-1:run-1:terminal',
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
      },
      canonicalMessageDigest: '0'.repeat(64),
    }),
  })

  assert.equal(finalized.status, 'error')
  assert.notEqual(finalized.terminalReason, 'done')
})

test('Codex product closeout enforces the frozen completion proof profile', async () => {
  const at = new Date('2026-08-19T00:00:30.000Z')
  const prepareOnly = await finalizeProofProfile({
    taskType: 'transaction_task',
    toolCalls: [{ itemId: 'prepare-1', tool: 'tag_forge_prepare_batch', status: 'completed', success: true }],
    proofs: [collectToolResultProof('tag_forge_prepare_batch', 'prepared', at)],
  })
  assert.equal(prepareOnly.status, 'error')

  const applied = await finalizeProofProfile({
    taskType: 'transaction_task',
    toolCalls: [{ itemId: 'apply-1', tool: 'tag_forge_apply_batch', status: 'completed', success: true }],
    proofs: [
      collectToolResultProof('tag_forge_apply_batch', 'done', at),
      collectTransactionConfirmedProof('tag_forge_apply_batch:tag_forge_readback:batch-1', 'batch-1', at),
    ],
  })
  assert.equal(applied.status, 'done')

  const searchOnly = await finalizeProofProfile({
    taskType: 'research',
    toolCalls: [{ itemId: 'search-1', tool: 'web_search', status: 'completed', success: true }],
    proofs: [collectToolResultProof('web_search', '找到来源', at, 'https://example.com/source')],
  })
  assert.equal(searchOnly.status, 'error')

  const sourcesWithoutArtifact = await finalizeProofProfile({
    taskType: 'research_artifact_task',
    toolCalls: [
      { itemId: 'search-1', tool: 'web_search', status: 'completed', success: true },
      { itemId: 'fetch-1', tool: 'web_fetch', status: 'completed', success: true },
    ],
    proofs: [
      collectToolResultProof('web_search', '找到来源', at, 'https://example.com/source'),
      collectToolResultProof('web_fetch', '读取正文', at, 'https://example.com/source 完整正文'),
    ],
  })
  assert.equal(sourcesWithoutArtifact.status, 'error')

  const artifactOnly = await finalizeProofProfile({
    taskType: 'artifact_task',
    toolCalls: [{ itemId: 'write-1', tool: 'skill_write_artifact', status: 'completed', success: true }],
    proofs: [
      collectToolResultProof('skill_write_artifact', 'written', at),
      collectArtifactProof('/tmp/output.md', at, 'run-1'),
    ],
  })
  assert.equal(artifactOnly.status, 'done')

  const readOnly = await finalizeProofProfile({
    taskType: 'artifact_task',
    toolCalls: [{ itemId: 'read-1', tool: 'skill_read_artifact', status: 'completed', success: true }],
    proofs: collectToolOutputProofs('skill_read_artifact', createToolExecutionOutput('已读取已有文件', {
      shape: 'projection_patch',
      data: { ok: true, absolutePath: '/tmp/already-existing-input.md', content: '旧内容' },
      projectionPatch: {
        recentArtifacts: [
          { path: '/tmp/older-output.md', kind: 'artifact', meta: { toolName: 'skill_write_artifact' } },
          { path: '/tmp/already-existing-input.md', kind: 'read_artifact', meta: { toolName: 'skill_read_artifact' } },
        ],
      },
    }), at),
  })
  assert.equal(readOnly.status, 'error')
})

test('Codex product closeout still accepts a real direct answer', async () => {
  let row = projection({
    taskType: 'direct_answer',
    module: 'system',
    modelCriteria: [],
  })
  const contextUsage = {
    usedInputTokens: 6_400,
    windowTokens: 128_000,
    ratio: 0.05,
    windowSource: 'model' as const,
    source: 'last_model_request' as const,
    timestamp: '2026-08-19T00:00:30.000Z',
  }
  let committedContextUsage: typeof contextUsage | null = null
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '这是一个已回答的问题。',
      contextUsage,
    },
    toolCalls: [],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => {
      committedContextUsage = input.contextUsage || null
      return {
        canonicalMessage: {
          id: 'assistant:task-1:run-1:terminal',
          conversationId: input.conversationId,
          role: 'assistant',
          content: input.finalText,
          timestamp: '2026-08-19T00:01:00.000Z',
          meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
        },
        canonicalMessageDigest: 'b'.repeat(64),
      }
    },
  })

  assert.equal(finalized.status, 'done')
  assert.equal(finalized.terminalReason, 'done')
  assert.deepEqual(committedContextUsage, contextUsage)
})

test('Codex product closeout accepts a selected advisory skill with a complete direct answer', async () => {
  let row = projection({
    taskType: 'direct_answer',
    module: 'skill',
    modelCriteria: [],
  })
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '已按参考技能完成审阅意见。',
    },
    toolCalls: [],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => ({
      canonicalMessage: {
        id: 'assistant:task-1:run-1:terminal',
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
      },
      canonicalMessageDigest: 'e'.repeat(64),
    }),
  })

  assert.equal(finalized.status, 'done')
  assert.equal(finalized.terminalReason, 'done')
})

test('Codex product closeout accepts a skill result backed by published tool and artifact proofs', async () => {
  let row = projection()
  const at = new Date('2026-08-19T00:00:30.000Z')
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '标签已经写回并核对完成。',
    },
    toolCalls: [
      { itemId: 'prepare-1', tool: 'tag_forge_prepare_batch', status: 'completed', success: true },
      { itemId: 'apply-1', tool: 'tag_forge_apply_batch', status: 'completed', success: true },
    ],
    durableProofs: [
      collectToolResultProof('tag_forge_apply_batch', 'done', at),
      collectArtifactProof('/tmp/tag-forge/batch.json', at, row.runId),
    ],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => ({
      canonicalMessage: {
        id: 'assistant:task-1:run-1:terminal',
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
      },
      canonicalMessageDigest: 'c'.repeat(64),
    }),
  })

  assert.equal(finalized.status, 'done')
  assert.equal(finalized.terminalReason, 'done')
  assert.equal((row.proofRefs || []).length, 3)
})

test('Codex product closeout does not let an earlier skill proof hide a later failed stage', async () => {
  let row = projection()
  const at = new Date('2026-08-19T00:00:30.000Z')
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '请提供文件的绝对路径。',
    },
    toolCalls: [
      { itemId: 'prepare-1', tool: 'tag_forge_prepare_batch', status: 'completed', success: true },
      { itemId: 'apply-1', tool: 'tag_forge_apply_batch', status: 'failed', success: false },
    ],
    durableProofs: [
      collectToolResultProof('tag_forge_prepare_batch', 'prepared', at),
      collectArtifactProof('/tmp/tag-forge/batch.json', at, row.runId),
    ],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => ({
      canonicalMessage: {
        id: 'assistant:task-1:run-1:terminal',
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
      },
      canonicalMessageDigest: 'd'.repeat(64),
    }),
  })

  assert.equal(finalized.status, 'error')
  assert.equal(finalized.terminalReason, 'blocked_tool_error')
})

test('Codex product closeout accepts a corrected skill attempt with a confirmed final write', async () => {
  let row = projection()
  const at = new Date('2026-08-19T00:00:40.000Z')
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '标签已经写回并核对完成。',
    },
    toolCalls: [
      { itemId: 'prepare-1', tool: 'tag_forge_prepare_batch', status: 'failed', success: false },
      { itemId: 'prepare-2', tool: 'tag_forge_prepare_batch', status: 'completed', success: true },
      { itemId: 'apply-1', tool: 'tag_forge_apply_batch', status: 'completed', success: true },
    ],
    publishedToolEvidence: [{
      itemId: 'apply-1',
      tool: 'tag_forge_apply_batch',
      proofs: [
        collectToolResultProof('tag_forge_apply_batch', 'done', at),
        collectTransactionConfirmedProof(
          'tag_forge_apply_batch:tag_forge_readback:batch-1',
          'batch-1',
          at,
        ),
      ],
    }],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => ({
      canonicalMessage: {
        id: 'assistant:task-1:run-1:terminal',
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
      },
      canonicalMessageDigest: 'f'.repeat(64),
    }),
  })

  assert.equal(finalized.status, 'done')
  assert.equal(finalized.terminalReason, 'done')
})

test('Codex product closeout does not let an unrelated same-tool success erase a failed call', async () => {
  let row = projection()
  let committedText = ''
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '所有操作都已完成。',
    },
    toolCalls: [
      { itemId: 'shell-a', tool: 'skill_run_shell', status: 'failed', success: false },
      { itemId: 'shell-b', tool: 'skill_run_shell', status: 'completed', success: true },
    ],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => {
      committedText = input.finalText
      return {
        canonicalMessage: {
          id: 'assistant:task-1:run-1:terminal',
          conversationId: input.conversationId,
          role: 'assistant',
          content: input.finalText,
          timestamp: '2026-08-19T00:01:00.000Z',
          meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
        },
        canonicalMessageDigest: 'e'.repeat(64),
      }
    },
  })

  assert.equal(finalized.status, 'error')
  assert.equal(finalized.terminalReason, 'blocked_tool_error')
  assert.doesNotMatch(committedText, /所有操作都已完成/)
})

test('Codex product closeout never lends an older same-tool artifact to a later recovery call', async () => {
  let row = projection()
  const oldAt = new Date('2026-08-19T00:00:20.000Z')
  const newAt = new Date('2026-08-19T00:00:40.000Z')
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '所有操作都已完成。',
    },
    toolCalls: [
      { itemId: 'shell-old', tool: 'skill_run_shell', status: 'completed', success: true },
      { itemId: 'shell-failed', tool: 'skill_run_shell', status: 'failed', success: false },
      { itemId: 'shell-new', tool: 'skill_run_shell', status: 'completed', success: true },
    ],
    publishedToolEvidence: [
      {
        itemId: 'shell-old',
        tool: 'skill_run_shell',
        proofs: [
          collectToolResultProof('skill_run_shell', 'old output', oldAt),
          collectArtifactProof('/tmp/old-output.txt', oldAt, row.runId),
        ],
      },
      {
        itemId: 'shell-new',
        tool: 'skill_run_shell',
        proofs: [collectToolResultProof('skill_run_shell', 'echo ok', newAt)],
      },
    ],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => ({
      canonicalMessage: {
        id: 'assistant:task-1:run-1:terminal',
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
      },
      canonicalMessageDigest: '1'.repeat(64),
    }),
  })

  assert.equal(finalized.status, 'error')
  assert.equal(finalized.terminalReason, 'blocked_tool_error')
})

test('Codex product closeout does not treat criteria registration as completed work', async () => {
  let row = projection({ modelCriteria: ['交付最终结果'] })
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '已经完成。',
    },
    toolCalls: [{
      itemId: 'criteria-1',
      tool: 'declare_completion_criteria',
      status: 'completed',
      success: true,
    }],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => ({
      canonicalMessage: {
        id: 'assistant:task-1:run-1:terminal',
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
      },
      canonicalMessageDigest: '2'.repeat(64),
    }),
  })

  assert.equal(finalized.status, 'error')
  assert.equal(finalized.terminalReason, 'proof_gap')
  assert.notEqual(finalized.canonicalMessage.content, '已经完成。')
  assert.match(finalized.canonicalMessage.content, /未将候选回复作为完成结果交付/)
})

test('Codex product closeout rejects a short skill run that delivers only one of two declared outputs', async () => {
  let row = projection({
    modelCriteria: [],
    expectedOutputs: ['/tmp/a.md', '/tmp/b.md'],
  })
  const at = new Date('2026-08-19T00:00:40.000Z')
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '已经交付。',
    },
    toolCalls: [{ itemId: 'write-a', tool: 'skill_write_artifact', status: 'completed', success: true }],
    publishedToolEvidence: [{
      itemId: 'write-a',
      tool: 'skill_write_artifact',
      proofs: [
        collectToolResultProof('skill_write_artifact', 'a', at),
        collectArtifactProof('/tmp/a.md', at, row.runId),
      ],
    }],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => ({
      canonicalMessage: {
        id: 'assistant:task-1:run-1:terminal',
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
      },
      canonicalMessageDigest: '3'.repeat(64),
    }),
  })

  assert.equal(finalized.status, 'error')
  assert.notEqual(finalized.terminalReason, 'done')
})

test('Codex product closeout accepts a short skill run only after every declared output is delivered', async () => {
  let row = projection({
    modelCriteria: [],
    expectedOutputs: ['/tmp/a.md', '/tmp/b.md'],
  })
  const at = new Date('2026-08-19T00:00:40.000Z')
  const evidence = (itemId: string, path: string) => ({
    itemId,
    tool: 'skill_write_artifact',
    proofs: [
      collectToolResultProof('skill_write_artifact', itemId, at),
      collectArtifactProof(path, at, row.runId),
    ],
  })
  const finalized = await finalizeCodexProductCloseout({
    closeout: {
      parentTaskId: row.taskId,
      ownerRunId: row.runId,
      conversationId: row.scopeId,
      status: 'done',
      terminalReason: 'done',
      initiator: 'done',
      durationMs: 10,
      taskType: row.taskType,
      module: row.module,
      finalText: '两份文件都已交付。',
    },
    toolCalls: [
      { itemId: 'write-a', tool: 'skill_write_artifact', status: 'completed', success: true },
      { itemId: 'write-b', tool: 'skill_write_artifact', status: 'completed', success: true },
    ],
    publishedToolEvidence: [evidence('write-a', '/tmp/a.md'), evidence('write-b', '/tmp/b.md')],
    taskProjectionStore: {
      get: () => row,
      update: (_taskId, patch) => { row = { ...row, ...patch } },
    },
    commitCanonicalCoreCloseout: async (input) => ({
      canonicalMessage: {
        id: 'assistant:task-1:run-1:terminal',
        conversationId: input.conversationId,
        role: 'assistant',
        content: input.finalText,
        timestamp: '2026-08-19T00:01:00.000Z',
        meta: { runId: input.ownerRunId, terminalReason: input.terminalReason },
      },
      canonicalMessageDigest: '4'.repeat(64),
    }),
  })

  assert.equal(finalized.status, 'done')
  assert.equal(finalized.terminalReason, 'done')
})
