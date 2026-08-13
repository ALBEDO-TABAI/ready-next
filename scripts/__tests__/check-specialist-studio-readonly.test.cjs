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
    'src/main/modules/claude-bridge/ipc/agent-system-studio-group.ts': "const CHANNELS = ['agent:systemStudio:getSnapshot', 'agent:systemStudio:stageContentEdit', 'agent:systemStudio:confirmContentEdit', 'agent:systemStudio:rejectContentEdit']\n",
    'src/preload/index.ts': "getSystemStudioSnapshot()\nstageSystemStudioContentEdit()\nconfirmSystemStudioContentEdit()\nrejectSystemStudioContentEdit()\n",
    'src/renderer/components/agent-system/studio/AgentSystemStudioView.tsx': 'getSystemStudioSnapshot()\nconfirmSystemStudioContentEdit()\nrejectSystemStudioContentEdit()\n不会改变当前 Codex\n不会自动创建或分配 Agent\n',
    'src/renderer/components/agent-system/AgentSettingsHub.tsx': '<PersonalityEditor />\n<AgentSystemStudio />\n不会改变当前 Codex\n',
    'src/renderer/pages/Settings.tsx': '<AgentSettingsHub />\n',
    ...overrides,
  }
  for (const [rel, body] of Object.entries(files)) writeFile(root, rel, body)
}

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

test('historical Studio gate rejects a returned routing simulator', (t) => {
  const root = makeRoot(t)
  seedMinimum(root, {
    'src/preload/index.ts': 'getSystemStudioSnapshot()\nstageSystemStudioContentEdit()\nconfirmSystemStudioContentEdit()\nrejectSystemStudioContentEdit()\nsimulateSystemStudioRouting()\n',
  })
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /simulateSystemStudioRouting/)
})

test('historical Studio gate rejects a returned Agent-creation action', (t) => {
  const root = makeRoot(t)
  seedMinimum(root, {
    'src/renderer/components/agent-system/studio/AgentSystemStudioView.tsx': 'getSystemStudioSnapshot()\nconfirmSystemStudioContentEdit()\nrejectSystemStudioContentEdit()\nconfirmSpecialistBlueprint()\n不会改变当前 Codex\n不会自动创建或分配 Agent\n',
  })
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /confirmSpecialistBlueprint/)
})

test('historical Studio gate passes on the real codebase', () => {
  const result = runIn(REPO_ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-specialist-studio-readonly.*OK/)
})
