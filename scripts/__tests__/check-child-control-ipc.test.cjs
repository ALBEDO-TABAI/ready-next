const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const test = require('node:test')

const { checkChildControlIpc } = require('../check-child-control-ipc.cjs')

test('child control checker reports every required surface when missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-child-control-missing-'))
  try {
    const failures = checkChildControlIpc({ root })
    assert.ok(failures.length >= 6)
    assert.ok(failures.some((failure) => failure.file === 'src/preload/index.ts'))
    assert.ok(failures.some((failure) => failure.label === 'file'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('child control checker accepts the required IPC, preload, type, UI, and runner contracts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-child-control-ok-'))
  try {
    write(root, 'src/main/modules/claude-bridge/ipc-handler.ts', `
      import { cancelChildRunForIpc, listActiveChildRunsForIpc } from './active-child-run-ipc'
      ipcMain.handle('agent:listActiveChildRuns', () => {})
      ipcMain.handle('agent:cancelChildRun', () => {})
    `)
    write(root, 'src/main/modules/claude-bridge/active-child-run-ipc.ts', `
      export function listActiveChildRunsForIpc() {}
      export async function cancelChildRunForIpc() {
        if (!childRunId) return { success: false, error: 'childRunId is required' }
        return cancelSkillChildRun(childRunId, { source: 'ui_button' })
      }
    `)
    write(root, 'src/preload/index.ts', `
      const agentAPI = {
        listActiveChildRuns: () => ipcRenderer.invoke('agent:listActiveChildRuns'),
        cancelChildRun: (childRunId) => ipcRenderer.invoke('agent:cancelChildRun', { childRunId }),
      }
    `)
    write(root, 'src/renderer/types/electron.d.ts', `
      interface ActiveChildRunSummaryData {
        childRunId: string
        skillId: string
        sessionId: string | null
        scopeId: string | null
        status: string
        startedAt: string
        outputDir: string
        runStatePath: string
      }
      interface ElectronAgentAPI {
        listActiveChildRuns: () => Promise<IPCResponse<ActiveChildRunSummaryData[]>>
        cancelChildRun: (childRunId: string) => Promise<IPCResponse<unknown>>
      }
    `)
    write(root, 'src/renderer/pages/Settings.tsx', `
      function ActiveChildRunsDebug() {
        window.electronAPI.agent.listActiveChildRuns()
        window.electronAPI.agent.cancelChildRun('child')
      }
    `)
    write(root, 'src/renderer/preview/installSettingsPreviewMocks.ts', `
      agent: {
        listActiveChildRuns: async () => ({ success: true, data: [] }),
        cancelChildRun: async () => ({ success: true, data: {} }),
      }
    `)
    write(root, 'src/main/modules/agent-control/skill-child-runner.ts', `
      interface ActiveRun {
        startedAt: string
      }
      type CancelSkillChildRunSource = 'nlp' | 'ui_button'
      class SkillChildRunner {
        listActiveRuns() {}
        cancelSkillChildRun() {
          logAgentMetric('skill_child_run_cancel_requested')
        }
      }
    `)

    assert.deepEqual(checkChildControlIpc({ root }), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function write(root, file, text) {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
