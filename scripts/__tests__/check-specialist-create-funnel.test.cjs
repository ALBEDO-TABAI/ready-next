'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-specialist-create-funnel.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specialist-retirement-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, source) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, source)
}

function seed(root, overrides = {}) {
  const files = {
    'src/main/modules/tools/agent-interaction-tool-defs.ts': "const names = ['ask_user_questions', 'declare_completion_criteria']\n",
    'src/main/modules/tools/schemas/agent-interaction-schemas.ts': 'export const schemas = {}\n',
    'src/main/modules/tools/tool-executor.ts': 'export const execute = () => undefined\n',
    'src/main/modules/claude-bridge/ipc/agent-specialist-blueprint-group.ts': "const channels = ['agent:specialistBlueprint:list']\n",
    'src/main/modules/claude-bridge/ipc/agent-registry-group.ts': "const channels = ['agent:registry:list', 'agent:registry:listKnowledge']\n",
    'src/preload/index.ts': 'listSpecialistBlueprints()\nlistRegistry()\n',
    'src/shared/agent-specialist-blueprint.ts': 'export type SpecialistAgentBlueprint = unknown\n',
    'src/main/modules/agent-control/agents/specialist-blueprint-store.ts': 'export class SpecialistBlueprintStore {}\n',
    ...overrides,
  }
  for (const [rel, source] of Object.entries(files)) write(root, rel, source)
}

function run(root) {
  return spawnSync('node', [SCRIPT], { cwd: root, encoding: 'utf8' })
}

test('retirement gate rejects a returned model-facing specialist tool', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'src/main/modules/tools/agent-interaction-tool-defs.ts': "const names = ['ask_user_questions', 'declare_completion_criteria', 'propose_specialist_blueprint']\n",
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /retired specialist tool/)
})

test('retirement gate rejects a returned blueprint create IPC', (t) => {
  const root = makeRoot(t)
  seed(root, {
    'src/main/modules/claude-bridge/ipc/agent-specialist-blueprint-group.ts': "const channels = ['agent:specialistBlueprint:list', 'agent:specialistBlueprint:confirmCreate']\n",
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /mutation or creation/)
})

test('retirement gate passes on the real repository', () => {
  const result = run(REPO_ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /live creation retired; historical audit retained/)
})
