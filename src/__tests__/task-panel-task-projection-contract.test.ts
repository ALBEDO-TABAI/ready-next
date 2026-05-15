import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: task projection panel wiring is a renderer source-surface contract
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('task panel reads task projections and renders budget and recovery hints', () => {
  const source = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.match(source, /window\.electronAPI\.agent\.listTaskProjections/)
  assert.match(source, /const \[taskProjections, setTaskProjections\] = useState/)
  assert.match(source, /function resolveActiveProjection\(/)
  assert.match(source, /activeRun\?\.taskId/)
  assert.match(source, /activeRun\?\.taskContinuation\?\.taskId/)
  assert.match(source, /function isStalePausedProjection\(/)
  assert.match(source, /function isLiveProjectionCandidate\(/)
  assert.match(source, /function selectFallbackProjection\(/)
  assert.match(source, /item\.status === 'done' && \(item\.recentArtifacts\?\.length \|\| 0\) > 0/)
  assert.doesNotMatch(source, /return taskProjections\[0\] \|\| null/)
  assert.match(source, /activeProjection\?\.taskTitle\s*\|\|\s*activeRun\?\.taskTitle/)
  assert.match(source, /activeProjection\?\.taskSummary\s*\|\|\s*activeRun\?\.taskSummary/)
  assert.match(source, /activeProjection\?\.recentArtifacts/)
  assert.match(source, /activeProjection\s*\?\s*projectionRuntimeState\?\.statusLabel\s*\|\|\s*projectionStatusLabel\(activeProjection\?\.status\)\s*:\s*phaseLabel\(activeRun\?\.phase\)/)
  assert.match(source, /预算进度/)
  assert.match(source, /自动恢复/)
  assert.match(source, /任务类型/)
  assert.match(source, /当前状态/)
  assert.match(source, /activeProjection\?\.budgetUsagePercent/)
  assert.match(source, /activeProjection\?\.recoveryHistory/)
  assert.match(source, /activeProjection\?\.interactionState/)
  assert.match(source, /degradationReason/)
  assert.match(source, /stepBudget/)
  assert.match(source, /setComposerDraft\(/)
  assert.doesNotMatch(source, /继续前上下文：/)
})
