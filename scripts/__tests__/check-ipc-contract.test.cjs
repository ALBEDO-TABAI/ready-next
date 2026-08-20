'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const { scanPreload } = require('../check-ipc-contract.cjs')

function withPreload(source, run) {
  const root = mkdtempSync(join(tmpdir(), 'ready-ipc-contract-'))
  try {
    mkdirSync(join(root, 'src/preload'), { recursive: true })
    writeFileSync(join(root, 'src/preload/index.ts'), source)
    run(scanPreload(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('scanPreload follows a local literal-channel invoke forwarder', () => {
  withPreload(`
    const invokeRuntime = <T>(channel: string, ...args: unknown[]): Promise<T> => (
      gate.invoke(() => ipcRenderer.invoke(channel, ...args) as Promise<T>)
    )
    const api = {
      read: () => invokeRuntime('agent:readProductTurnPresentation', { readyRunId: 'run-1' }),
      direct: () => ipcRenderer.invoke('browser:getTabs'),
    }
  `, (result) => {
    assert.deepEqual(
      [...result.invokeUsed].sort(),
      ['agent:readProductTurnPresentation', 'browser:getTabs'],
    )
  })
})

test('scanPreload does not treat non-literal forwarder calls as registered channels', () => {
  withPreload(`
    function invokeRuntime(channel: string, ...args: unknown[]) {
      return ipcRenderer.invoke(channel, ...args)
    }
    const dynamicChannel = getChannelAtRuntime()
    invokeRuntime(dynamicChannel)
  `, (result) => {
    assert.deepEqual([...result.invokeUsed], [])
  })
})
