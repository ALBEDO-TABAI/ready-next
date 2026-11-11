import test from 'node:test'
import assert from 'node:assert/strict'
import { runDryRun } from '../dry-run.mjs'

test('24 个任务执行前失败、oracle 执行后通过', async () => {
  const result = await runDryRun({ log: () => {} })
  assert.equal(
    result.ok,
    true,
    JSON.stringify(
      result.tasks.filter(t => !t.ok),
      null,
      2,
    ),
  )
  assert.deepEqual(result.validationErrors, [])
  assert.equal(result.tasks.length, 24)
  for (const task of result.tasks) {
    assert.equal(task.ok, true)
    assert.deepEqual(
      task.steps.map(step => step.id),
      ['start', 'prompt', 'before', 'after'],
    )
    assert.ok(task.steps.every(step => step.ok))
  }
})
test('未知任务在启动前拒绝', async () => {
  const result = await runDryRun({ taskIds: ['Z9'], log: () => {} })
  assert.equal(result.ok, false)
  assert.equal(result.tasks.length, 0)
  assert.match(result.validationErrors[0], /未知任务/)
})
