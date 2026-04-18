import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench resize hub keeps one RAF-coalesced window listener and fans out to subscribers', () => {
  const resizeHub = readWorkspaceFile('src/renderer/modules/workbench/windowResize.ts')
  const boundsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')
  const previewBrowser = readWorkspaceFile('src/renderer/components/rss/PreviewBrowser.tsx')
  const chatHeader = readWorkspaceFile('src/renderer/components/agent/ChatHeader.tsx')
  const filesPanel = readWorkspaceFile('src/renderer/components/layout/FilesPanel.tsx')

  assert.match(resizeHub, /type ResizeSubscriber = \(\) => void/)
  assert.match(resizeHub, /const resizeSubscribers = new Set<ResizeSubscriber>\(\)/)
  assert.match(resizeHub, /window\.addEventListener\('resize', handleWindowResize\)/)
  assert.match(resizeHub, /resizeRafId = window\.requestAnimationFrame\(flushResizeSubscribers\)/)
  assert.match(resizeHub, /export function subscribeWorkbenchWindowResize\(subscriber: ResizeSubscriber\)/)
  assert.match(resizeHub, /if \(resizeSubscribers\.size === 0\) \{[\s\S]*window\.removeEventListener\('resize', handleWindowResize\)/)

  assert.match(boundsHook, /subscribeWorkbenchWindowResize/)
  assert.match(previewBrowser, /subscribeWorkbenchWindowResize/)
  assert.match(chatHeader, /subscribeWorkbenchWindowResize/)
  assert.match(filesPanel, /subscribeWorkbenchWindowResize/)
})
