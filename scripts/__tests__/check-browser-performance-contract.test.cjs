'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { check } = require('../check-browser-performance-contract.cjs')

function write(root, rel, source) {
  const target = path.join(root, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, source)
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-browser-perf-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(root, 'src/main/modules/browser-engine/browser-tab-load-governor.ts', 'tab.view.webContents.setBackgroundThrottling(true)')
  write(root, 'src/main/modules/browser-engine/browser-controller-composition.ts', `
    this.performanceRuntime = new BrowserPerformanceRuntime({
      emitTabUpdate: () => this.sendToRendererImmediate('browser:tabUpdate'),
    })
  `)
  write(root, 'src/main/modules/browser-engine/browser-controller-tab-runtime.ts', `
    registerDormantTabs(request) { return this.tabLifecycleService.registerDormantTabs(request) }
  `)
  write(root, 'src/main/modules/browser-engine/browser-controller-capture-runtime.ts', '')
  write(root, 'src/main/modules/browser-engine/ipc-handler.ts', '')
  write(root, 'src/main/modules/browser-engine/browser-performance-runtime.ts', `
    this.updateBatcher = new BrowserTabUpdateBatcher({ emit: (update) => this.deps.emitTabUpdate(update) })
  `)
  write(root, 'src/main/modules/browser-engine/tab-lifecycle-service.ts', `
    registerDormantTabs() { this.materializeTab('tab-1') }
  `)
  write(root, 'src/main/index.ts', 'rsshubManager.cleanup()')
  for (const rel of [
    'src/shared/browser-view-intent.ts',
    'src/shared/browser-view-layout.ts',
    'src/main/modules/browser-engine/host-types.ts',
    'src/main/modules/browser-engine/host-layout-service.ts',
    'src/main/modules/browser-engine/tab-shell-service.ts',
  ]) write(root, rel, 'export const contract = true')
  return root
}

test('browser performance contract accepts the governed lazy architecture', (t) => {
  const root = fixture(t)
  write(root, 'src/main/modules/browser-engine/browser-controller-composition.ts', `
    this.performanceRuntime = new BrowserPerformanceRuntime({
      emitTabUpdate: () => this.sendToRendererImmediate('browser:tabUpdate'),
    })
  `)
  write(root, 'src/main/modules/browser-engine/browser-controller-tab-runtime.ts', `
    registerDormantTabs(request) { return this.tabLifecycleService.registerDormantTabs(request) }
  `)
  write(root, 'src/main/modules/browser-engine/browser-controller-capture-runtime.ts', `
    async captureBackgroundPage() {
      const probeWindow = new BrowserWindow({ webPreferences: { backgroundThrottling: false } })
    }
  `)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('browser performance contract rejects forced full-speed tabs and eager RSSHub boot', (t) => {
  const root = fixture(t)
  write(root, 'src/main/modules/browser-engine/host-layout-service.ts', 'const prefs = { backgroundThrottling: false }')
  write(root, 'src/main/index.ts', 'rsshubManager.start()')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.startsWith('background_throttling_forced_off:')))
  assert.ok(result.errors.some((error) => error.startsWith('rsshub_eager_start:')))
})
