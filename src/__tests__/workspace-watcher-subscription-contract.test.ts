import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('watcher failure subscription stays mounted across workbench, ready, and settings routes', () => {
  const app = readWorkspaceFile('src/renderer/App.tsx')
  const workbench = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(
    app,
    /function MainAppShell\(\)[\s\S]*onWatcherFailed[\s\S]*handleWorkspaceWatcherFailure/,
    'the route-stable app shell must own watcher failure delivery',
  )
  assert.doesNotMatch(
    workbench,
    /onWatcherFailed/,
    'route-local workbench mounts must not own the only failure listener',
  )
})
