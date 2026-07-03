'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const { check } = require('../check-browser-agent-lane-bound-target.cjs')

function writeFixture(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
}

test('browser agent lane bound-target gate passes the current workspace', () => {
  const result = check()
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('browser agent lane bound-target gate rejects fixed user-view active-tab fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-browser-lane-gate-'))
  writeFixture(root, {
    'src/main/modules/tools/browser-agent-runner.ts': `
      runUnderUserViewLease(service, {}, async () => {})
      controller.updateTabRuntimeState(activeTabId, { owner: 'agent' })
    `,
    'src/main/modules/browser-engine/browser-surface-binding.ts': `
      export function resolveBrowserToolSurfaceBinding() { return 'user-view-assisted' }
    `,
    'src/main/modules/browser-engine/ipc-supervision.ts': `
      const activeTasks = []
    `,
    'src/main/modules/browser-engine/host-layout-service.ts': `
      const options = { webPreferences: {} }
    `,
    'src/main/modules/browser-engine/ipc-handler.ts': `
      class BrowserController {}
    `,
    'src/main/modules/browser-engine/browser-workflow-session.ts': `
      export type BrowserWorkflowSessionStatus = 'running' | 'completed' | 'failed'
    `,
    'src/main/modules/browser-engine/auth-popup-manager.ts': `
      class AuthPopupManager { openInTab(url) {} }
    `,
  })
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.includes('runner_still_uses_fixed_user_view_lease'))
  assert.ok(result.errors.includes('runner_marks_active_tab_as_agent'))
  assert.ok(result.errors.includes('surface_binding_not_lane_aware_for_runner'))
})
