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
  assert.match(source, /activeProjection\?\.resumableActions/)
  assert.match(source, /setComposerDraft\(/)
  assert.match(source, /continuationIntent:/)
  assert.match(source, /继续运行/)
  assert.match(source, /重试任务/)
  assert.doesNotMatch(source, /Task ID:/)
  assert.doesNotMatch(source, /Execution ID:/)
})
