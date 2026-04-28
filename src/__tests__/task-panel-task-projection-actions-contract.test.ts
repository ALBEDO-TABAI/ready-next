import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('task panel exposes continue and retry actions from task projections', () => {
  const source = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.match(source, /const handleResumeProjection = useCallback\(/)
  assert.match(source, /const handleRetryProjection = useCallback\(/)
  assert.match(source, /activeProjection\?\.continuationRef/)
  assert.match(source, /buildProjectionContinuationIntent\(/)
  assert.match(source, /detachedTaskId:\s*ref\?\.detachedTaskId/)
  assert.match(source, /runStatePath:\s*ref\?\.runStatePath/)
  assert.match(source, /outputDir:\s*ref\?\.outputDir/)
  assert.match(source, /projectionRuntimeState\?\.statusLabel/)
  assert.match(source, /activeProjection\?\.resumableActions/)
  assert.match(source, /setComposerDraft\(/)
  assert.match(source, /continuationIntent:/)
  assert.match(source, /继续运行/)
  assert.match(source, /重试任务/)
  assert.doesNotMatch(source, /Task ID:/)
  assert.doesNotMatch(source, /Execution ID:/)
})

test('task panel exposes projection cancel and artifact actions after restart projection restore', () => {
  const source = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.match(source, /const handleCancelProjection = useCallback\(/)
  assert.match(source, /activeProjection\.continuationRef\?\.detachedTaskId/)
  assert.match(source, /window\.electronAPI\.agent\.cancelDetachedSkillTask\(detachedTaskId, activeProjection\.scopeId\)/)
  assert.match(source, /window\.electronAPI\.agent\.suspendRun\(/)
  assert.match(source, /activeProjection\?\.recentArtifacts/)
  assert.match(source, /function revealArtifact\(/)
  assert.match(source, /window\.electronAPI\.document\.showInFolder\(path\)/)
  assert.match(source, /void revealArtifact\(artifact\)/)
})

test('task panel lets projection clear stale active run blockers', () => {
  const source = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.doesNotMatch(source, /activeRun\?\.blockedReason \|\| activeProjection\?\.blockedReason/)
})
