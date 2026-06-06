import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert'

const root = process.cwd()

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

describe('browser collection consent IPC contract', () => {
  it('exposes direct UI confirmation from main through preload and renderer types', () => {
    const main = read('src/main/modules/browser-engine/ipc-handler.ts')
    const preload = read('src/preload/index.ts')
    const rendererTypes = read('src/renderer/types/electron.d.ts')

    assert.match(main, /ipcMain\.handle\('browser:confirmCollectionConsent'/)
    assert.match(main, /confirmPendingRequest\(requestId,\s*confirmedVia\)/)
    assert.match(preload, /confirmCollectionConsent:\s*\(payload:\s*\{ requestId: string; confirmedVia: 'ask_user_questions' \| 'ui_action' \}\)/)
    assert.match(preload, /ipcRenderer\.invoke\('browser:confirmCollectionConsent', payload\)/)
    assert.match(rendererTypes, /confirmCollectionConsent:\s*\(payload:\s*\{/)
    assert.match(rendererTypes, /confirmedVia:\s*'ask_user_questions' \| 'ui_action'/)
  })

  it('exposes browser task resume from main through preload and renderer types', () => {
    const main = read('src/main/modules/browser-engine/ipc-handler.ts')
    const preload = read('src/preload/index.ts')
    const rendererTypes = read('src/renderer/types/electron.d.ts')

    assert.match(main, /ipcMain\.handle\('browser:resumeTask'/)
    assert.match(main, /resumeBrowserTask\(payload\)/)
    assert.match(main, /startCollectionFromCompletedVisibleTask\(task\)/)
    assert.match(preload, /resumeTask:\s*\(payload:\s*\{ taskId: string \}\)/)
    assert.match(preload, /ipcRenderer\.invoke\('browser:resumeTask', payload\)/)
    assert.match(rendererTypes, /resumeTask:\s*\(payload:\s*\{/)
    assert.match(rendererTypes, /taskId:\s*string/)
  })
})
