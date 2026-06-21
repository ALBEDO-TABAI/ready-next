'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-specialist-studio-readonly.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function makeRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specialist-studio-readonly-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeFile(root, rel, body) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function seedMinimum(root, overrides = {}) {
  const files = {
    'src/main/modules/claude-bridge/ipc/agent-system-studio-group.ts': "const CHANNELS = ['agent:systemStudio:getSnapshot', 'agent:systemStudio:simulateRouting', 'agent:systemStudio:stageContentEdit', 'agent:systemStudio:confirmContentEdit', 'agent:systemStudio:rejectContentEdit']\n",
    'src/preload/index.ts': "getSystemStudioSnapshot: () => ipcRenderer.invoke('agent:systemStudio:getSnapshot')\nsimulateSystemStudioRouting: () => ipcRenderer.invoke('agent:systemStudio:simulateRouting')\nstageSystemStudioContentEdit: () => ipcRenderer.invoke('agent:systemStudio:stageContentEdit')\nconfirmSystemStudioContentEdit: () => ipcRenderer.invoke('agent:systemStudio:confirmContentEdit')\nrejectSystemStudioContentEdit: () => ipcRenderer.invoke('agent:systemStudio:rejectContentEdit')\n",
    'src/renderer/components/agent-system/AgentSystemStudio.tsx': 'window.electronAPI.agent.getSystemStudioSnapshot()\nwindow.electronAPI.agent.simulateSystemStudioRouting()\nwindow.electronAPI.agent.stageSystemStudioContentEdit()\nwindow.electronAPI.agent.confirmSystemStudioContentEdit()\nwindow.electronAPI.agent.rejectSystemStudioContentEdit()\n',
    'src/renderer/pages/Settings.tsx': "id: 'agent-system'\n<AgentSystemStudio />\n",
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) writeFile(root, rel, body)
}

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

test('specialist Studio readonly gate fails on a create channel', (t) => {
  const root = makeRoot(t)
  seedMinimum(root, {
    'src/main/modules/claude-bridge/ipc/agent-system-studio-group.ts': "const CHANNELS = ['agent:systemStudio:getSnapshot', 'agent:systemStudio:simulateRouting', 'agent:systemStudio:stageContentEdit', 'agent:systemStudio:confirmContentEdit', 'agent:systemStudio:rejectContentEdit', 'agent:systemStudio:create']\n",
  })
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /forbidden write token/)
})

test('specialist Studio readonly gate passes on the real codebase', () => {
  const result = runIn(REPO_ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-specialist-studio-readonly.*OK/)
})
