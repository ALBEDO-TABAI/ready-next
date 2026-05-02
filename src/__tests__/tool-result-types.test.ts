import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createToolExecutionOutput,
  serializeToolExecutionOutput,
} from '../main/modules/agent-control/tool-result-types'

test('serializeToolExecutionOutput sends tool text to the model even when a projection patch exists', () => {
  const output = createToolExecutionOutput('exitCode=0\nSTDOUT:\nreport ready', {
    projectionPatch: {
      module: 'skill',
      taskSummary: '执行技能脚本',
    },
  })

  assert.equal(
    serializeToolExecutionOutput(output),
    'exitCode=0\nSTDOUT:\nreport ready',
  )
})

test('serializeToolExecutionOutput falls back to projection JSON only when there is no tool text', () => {
  const output = createToolExecutionOutput('', {
    projectionPatch: {
      module: 'skill',
      taskSummary: '执行技能脚本',
    },
  })

  assert.equal(
    serializeToolExecutionOutput(output),
    JSON.stringify({ module: 'skill', taskSummary: '执行技能脚本' }),
  )
})
