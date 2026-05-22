import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- PreviewBrowser.tsx is a React component with renderer-only hook/store deps (useHostedPreviewBounds, useWorkspace, react refs/effects); no electron-free seam and no JSDOM harness in scope for W1 (see ledger).
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('RSS preview opens browser mode through the workbench transition controller', () => {
  const previewBrowser = readWorkspaceFile('src/renderer/components/rss/PreviewBrowser.tsx')

  assert.match(previewBrowser, /requestWorkbenchModeChange/)
  assert.match(previewBrowser, /requestWorkbenchModeChange\('browser'\)/)
  assert.doesNotMatch(previewBrowser, /setWorkbenchMode\('browser'\)/)
  assert.doesNotMatch(previewBrowser, /from '\.\.\/\.\.\/stores\/useMode'/)
})
