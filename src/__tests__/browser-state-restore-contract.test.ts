import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser runtime restoration rehydrates loading and navigation state from main-process tab metadata', () => {
  const runtimeHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')
  const tabMetaService = readWorkspaceFile('src/main/modules/browser-engine/tab-meta-service.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')

  assert.match(runtimeHook, /loading:\s*Boolean\(tab\.loading\)/)
  assert.match(runtimeHook, /canGoBack:\s*Boolean\(tab\.canGoBack\)/)
  assert.match(runtimeHook, /canGoForward:\s*Boolean\(tab\.canGoForward\)/)
  assert.match(runtimeHook, /error:\s*tab\.error \|\| undefined/)
  assert.match(tabMetaService, /loading: boolean/)
  assert.match(tabMetaService, /canGoBack: boolean/)
  assert.match(tabMetaService, /canGoForward: boolean/)
  assert.match(tabMetaService, /error: string \| null/)
  assert.match(electronTypes, /interface BrowserTabInfo \{[\s\S]*loading: boolean[\s\S]*canGoBack: boolean[\s\S]*canGoForward: boolean[\s\S]*error\?: string \| null/)
})
