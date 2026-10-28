import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'

import { readCodexFolderOutputActivation } from '../main/modules/agent-control/codex-runtime/codex-folder-output-activation'
import { executeDeclareCompletionCriteria } from '../main/modules/tools/builtins/declare-completion-criteria'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import type { DatabaseConnection } from '../main/modules/database/connection'

const destination = {
  logicalResourceId: 'local-directory:reading', path: join('/Users', 'reader', '卡拉马佐夫兄弟'),
  currentVersion: 'sha256:folder', currentDigest: 'folder', policyEpoch: 1,
  directoryIdentity: { device: '1', inode: '2', mode: 16877, mtimeMs: 1 },
}

// Declarations delivered to the model in call order, as the activation query returns them.
function databaseWith(outputs: ReadonlyArray<ReturnType<typeof executeDeclareCompletionCriteria> extends Promise<infer T> ? T : never>) {
  const rows = outputs.map((output, index) => ({
    ready_action_id: `action-${index}`, receipt_id: `receipt-${index}`,
    result_digest: digestCanonicalJson(output), result_json: JSON.stringify(output), attempt_id: `attempt-${index}`,
  }))
  return {
    prepare: (sql: string) => ({
      get: () => (sql.includes('ingress_json')
        ? { ingress_json: JSON.stringify({ prepared: { outputContract: { destination } } }) }
        : undefined),
      all: () => rows,
    }),
  } as unknown as DatabaseConnection
}

test('a rejected declaration promises nothing; the first accepted one freezes the folder promise', async () => {
  const deps = {
    taskId: 'task-1',
    outputContract: { destinationResourceId: destination.logicalResourceId, maxExpectedOutputs: 8 },
    updateTaskCompletionDeclaration: () => {},
  }
  const rejected = await executeDeclareCompletionCriteria({ criteria: ['导出人物表'] }, deps)
  const accepted = await executeDeclareCompletionCriteria({
    criteria: ['导出人物表'], folder_output_intent: 'save', expected_outputs: ['人物表.md'],
  }, deps)
  const later = await executeDeclareCompletionCriteria({
    criteria: ['不写文件了'], folder_output_intent: 'no_write',
  }, deps)
  assert.deepEqual(readCodexFolderOutputActivation(databaseWith([rejected]), 'run-1'), { kind: 'pending' })
  const activation = readCodexFolderOutputActivation(databaseWith([rejected, accepted, later]), 'run-1')
  assert.equal(activation.kind, 'positive')
  assert.deepEqual('expectedOutputs' in activation ? activation.expectedOutputs : null, ['人物表.md'],
    'a later declaration cannot withdraw a promised file')
})

test('the open document declared as a folder save owes no folder delivery', async () => {
  const deps = {
    taskId: 'task-1',
    outputContract: {
      destinationResourceId: destination.logicalResourceId,
      maxExpectedOutputs: 8,
      currentDocumentFile: {
        destinationPath: destination.path,
        pathDigest: createHash('sha256').update(join(destination.path, '阅读回顾.md')).digest('hex'),
      },
    },
    updateTaskCompletionDeclaration: () => {},
  }
  const declared = await executeDeclareCompletionCriteria({
    criteria: ['把引用块换成信息卡并保存回原文件'], folder_output_intent: 'save', expected_outputs: ['阅读回顾.md'],
  }, deps)
  assert.equal(readCodexFolderOutputActivation(databaseWith([declared]), 'run-1').kind, 'no_write')
})
