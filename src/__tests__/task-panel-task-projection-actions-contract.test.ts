import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: task projection action wiring spans renderer callbacks without a stable DOM harness
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('task panel keeps historical continuation and retry read-only', () => {
  const source = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.match(source, /projectionRuntimeState\?\.statusLabel/)
  assert.match(source, /resumableActions:\s*activeProjection\.resumableActions/)
  assert.match(source, /activeProjection\.waitingFor/)
  assert.doesNotMatch(source, /waitingFor:\s*activeProjection\.status === 'blocked'/)
  assert.doesNotMatch(source, /handleRetryProjection/)
  assert.doesNotMatch(source, /continuationIntent:/)
  assert.doesNotMatch(source, /继续运行/)
  assert.doesNotMatch(source, /重新发起|重试任务/)
  assert.doesNotMatch(source, /Task ID:/)
  assert.doesNotMatch(source, /Execution ID:/)
})

test('task panel exposes projection cancel and artifact actions after restart projection restore', () => {
  const source = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.match(source, /const handleCancelProjection = useCallback\(/)
  assert.match(source, /activeProjection\.continuationRef\?\.detachedTaskId/)
  assert.match(source, /window\.electronAPI\.agent\.cancelDetachedSkillTask\(detachedTaskId, activeProjection\.scopeId\)/)
  assert.match(source, /activeProjection\.continuationRef\?\.childRunId/)
  assert.match(source, /window\.electronAPI\.agent\.cancelChildRun\(childRunId\)/)
  assert.doesNotMatch(source, /window\.electronAPI\.agent\.suspendRun\(/)
  assert.match(source, /activeProjection\?\.recentArtifacts/)
  assert.match(source, /function revealArtifact\(/)
  assert.match(source, /window\.electronAPI\.document\.showInFolder\(path\)/)
  assert.match(source, /void revealArtifact\(artifact\)/)
})

test('task panel lets projection clear stale active run blockers', () => {
  const source = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.doesNotMatch(source, /activeRun\?\.blockedReason \|\| activeProjection\?\.blockedReason/)
})
