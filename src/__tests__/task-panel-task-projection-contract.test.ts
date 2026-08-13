import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: task projection panel wiring is a renderer source-surface contract
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('task panel reads task projections as progress truth without public continuation drafting', () => {
  const source = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.match(source, /window\.electronAPI\.agent\.listTaskProjections/)
  assert.match(source, /window\.electronAPI\.agent\.onTaskProjectionsChanged/)
  assert.match(source, /createDebouncedFetch\(refreshTaskProjections, 100\)/)
  assert.match(source, /const \[taskProjections, setTaskProjections\] = useState/)
  assert.match(source, /function resolveActiveProjection\(/)
  assert.match(source, /activeRun\?\.taskId/)
  assert.match(source, /activeRun\?\.taskContinuation\?\.taskId/)
  assert.match(source, /function isStalePausedProjection\(/)
  assert.match(source, /function isLiveProjectionCandidate\(/)
  assert.match(source, /function selectFallbackProjection\(/)
  assert.match(source, /item\.status === 'completed' && \(item\.recentArtifacts\?\.length \|\| 0\) > 0/)
  assert.doesNotMatch(source, /return taskProjections\[0\] \|\| null/)
  assert.match(source, /function userFacingTaskTitle\(/)
  assert.match(source, /function userFacingTaskSummary\(/)
  assert.match(source, /activeTaskTitle = userFacingTaskTitle\(activeProjection\?\.taskTitle \|\| activeRun\?\.taskTitle\)/)
  assert.match(source, /activeTaskSummary = userFacingTaskSummary\(activeProjection\?\.taskSummary \|\| activeRun\?\.taskSummary\)/)
  assert.match(source, /activeProjection\?\.recentArtifacts/)
  assert.match(source, /activeProjection\s*\?\s*projectionRuntimeState\?\.statusLabel\s*\|\|\s*projectionStatusLabel\(activeProjection\?\.status\)\s*:\s*phaseLabel\(activeRun\?\.phase\)/)
  assert.match(source, /当前进展/)
  assert.match(source, /formatTaskProgressLabel/)
  assert.match(source, /formatTaskStepDisplayTitle/)
  assert.match(source, /自动恢复/)
  assert.match(source, /activeProjection\?\.recoveryHistory/)
  assert.match(source, /interactionStateToUserLabel\(activeProjection\.interactionState\)/)
  assert.doesNotMatch(source, /任务类型/)
  assert.doesNotMatch(source, /预算进度/)
  assert.doesNotMatch(source, /当前步骤额度/)
  assert.doesNotMatch(source, /degradationReason:\s*\{activeProjection\.degradationReason\}/)
  assert.doesNotMatch(source, /setComposerDraft\(/)
  assert.doesNotMatch(source, /继续前上下文：/)
})
