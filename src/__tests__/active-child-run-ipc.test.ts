import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')

test('active child run IPC surface stays wired through main, preload, renderer types, and Settings', () => {
  const ipc = read('src/main/modules/claude-bridge/ipc-handler.ts')
  const preload = read('src/preload/index.ts')
  const types = read('src/renderer/types/electron.d.ts')
  const settings = read('src/renderer/pages/Settings.tsx')

  assert.match(ipc, /agent:listActiveChildRuns/)
  assert.match(ipc, /agent:cancelChildRun/)
  assert.match(ipc, /childRunId is required/)
  assert.match(ipc, /source:\s*['"]ui_button['"]/)
  assert.match(preload, /listActiveChildRuns:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]agent:listActiveChildRuns['"]\)/)
  assert.match(preload, /cancelChildRun:\s*\(childRunId:\s*string\)\s*=>/)
  assert.match(types, /interface ActiveChildRunSummaryData/)
  assert.match(types, /listActiveChildRuns:\s*\(\)\s*=>\s*Promise<IPCResponse<ActiveChildRunSummaryData\[\]>>/)
  assert.match(types, /cancelChildRun:\s*\(\s*childRunId:\s*string\s*\)\s*=>\s*Promise<IPCResponse/)
  assert.match(settings, /ActiveChildRunsDebug/)
})

test('child runner exposes summaries and records cancellation source for metrics', () => {
  const runner = read('src/main/modules/agent-control/skill-child-runner.ts')

  assert.match(runner, /listActiveRuns\(/)
  assert.match(runner, /startedAt:\s*string/)
  assert.match(runner, /CancelSkillChildRunSource\s*=\s*['"]nlp['"]\s*\|\s*['"]ui_button['"]/)
  assert.match(runner, /skill_child_run_cancel_requested/)
})

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}
