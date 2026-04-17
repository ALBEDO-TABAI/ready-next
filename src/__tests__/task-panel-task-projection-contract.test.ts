import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('task panel reads task projections and renders budget and recovery hints', () => {
  const source = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.match(source, /window\.electronAPI\.agent\.listTaskProjections/)
  assert.match(source, /const \[taskProjections, setTaskProjections\] = useState/)
  assert.match(source, /function resolveActiveProjection\(/)
  assert.match(source, /activeRun\?\.taskId/)
  assert.match(source, /activeRun\?\.taskContinuation\?\.taskId/)
  assert.match(source, /item\.status === 'running' \|\| item\.status === 'blocked' \|\| item\.interactionState === 'resuming'/)
  assert.doesNotMatch(source, /return taskProjections\[0\] \|\| null/)
  assert.match(source, /activeProjection\?\.taskTitle\s*\|\|\s*activeRun\?\.taskTitle/)
  assert.match(source, /activeProjection\?\.taskSummary\s*\|\|\s*activeRun\?\.taskSummary/)
  assert.match(source, /activeProjection\?\.recentArtifacts/)
  assert.match(source, /activeProjection\s*\?\s*projectionStatusLabel\(activeProjection\?\.status\)\s*:\s*phaseLabel\(activeRun\?\.phase\)/)
  assert.match(source, /预算进度/)
  assert.match(source, /自动恢复/)
  assert.match(source, /任务类型/)
  assert.match(source, /当前状态/)
  assert.match(source, /activeProjection\?\.budgetUsagePercent/)
  assert.match(source, /activeProjection\?\.recoveryHistory/)
  assert.match(source, /activeProjection\?\.interactionState/)
  assert.match(source, /degradationReason/)
  assert.match(source, /stepBudget/)
  assert.match(source, /activeProjection\?\.blockedReason \? `继续前上下文：\$\{activeProjection\.blockedReason\}` : null/)
})
