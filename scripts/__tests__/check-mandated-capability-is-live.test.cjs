'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-mandated-capability-is-live.cjs')

const RUNTIME_REL = 'src/main/modules/agent-control/runtime-core/runtime.ts'
const LIFECYCLE_REL = 'src/main/modules/agent-control/memory/memory-lifecycle.ts'
const DECAY_REL = 'src/main/modules/agent-control/memory/belief-decay.ts'
const CRYSTALLIZE_REL = 'src/main/modules/agent-control/maintenance/crystallize-gate.ts'
const CRITERIA_REL = 'src/main/modules/agent-control/quality/criteria-templates.ts'
const REGISTER_REL = 'docs/superpowers/plans/2026-07-03-deferred-work-register.md'
const IPC_HANDLER_REL = 'src/main/modules/claude-bridge/ipc-handler.ts'
const PRELOAD_REL = 'src/preload/index.ts'
const FEEDBACK_GROUP_REL = 'src/main/modules/claude-bridge/ipc/run-feedback-group.ts'
const FEEDBACK_STARS_REL = 'src/renderer/components/agent/chat-panel/task/RunFeedbackStars.tsx'
const EMERGENCE_CARDS_REL = 'src/main/modules/agent-control/emergence/emergence-cards.ts'
const EMERGENCE_GROUP_REL = 'src/main/modules/claude-bridge/ipc/emergence-feed-group.ts'
const EMERGENCE_SECTION_REL = 'src/renderer/components/ready/EmergenceFeedSection.tsx'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandated-capability-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

const RETIRED_MEMORY_RUNTIME = 'export const runtimeReady = true\n'

function writeBaseline(root) {
  write(root, LIFECYCLE_REL, `
for (const row of rows) {
  if (row.category === 'belief') continue
}
`)
  write(root, RUNTIME_REL, RETIRED_MEMORY_RUNTIME)
  write(root, DECAY_REL, 'export function runBeliefDecayRound() {}\n')
  write(root, CRYSTALLIZE_REL, 'export class CrystallizeScheduler {}\n')
  write(root, CRITERIA_REL, 'export function appendModelCriteria(\n) {}\n')
  write(root, REGISTER_REL, '# 登记\nappendModelCriteria 工单\n')
  write(root, IPC_HANDLER_REL, 'runFeedbackGroupDispose = runFeedbackGroup.register(ipcMain, {})\nemergenceFeedGroupDispose = emergenceFeedGroup.register(ipcMain, {})\n')
  write(root, PRELOAD_REL, "const runFeedbackAPI = { submit: (p) => ipcRenderer.invoke('agent:runFeedback:submit', p) }\n")
  write(root, FEEDBACK_GROUP_REL, "logAgentMetric('run_feedback_submitted', {})\n")
  write(root, FEEDBACK_STARS_REL, 'const result = await api.submit({ taskId, rating: value })\n')
  write(root, EMERGENCE_CARDS_REL, 'export function assembleEmergenceFeed() {}\n')
  write(root, EMERGENCE_GROUP_REL, "const cards = assembleEmergenceFeed([])\nlogAgentMetric('emergence_feed_assembled', {})\n")
  write(root, EMERGENCE_SECTION_REL, 'export const marker = "data-ready-emergence-feed"\n')
  write(root, 'src/renderer/components/ready/TaskPanel.tsx', 'export const panel = <EmergenceFeedSection onOpenScope={open} onOpenSettings={openSettings} />\n')
  // D4 gate-flip fixture: declare tool + executor dispatch + finalizer merge/ledger
  write(root, 'src/main/modules/tools/agent-interaction-tool-defs.ts', "export const AGENT_INTERACTION_TOOL_NAMES = ['ask_user_questions', 'declare_completion_criteria']\n")
  write(root, 'src/main/modules/tools/tool-executor.ts', 'import { executeDeclareCompletionCriteria } from "./builtins/declare-completion-criteria"\nexport const dispatch = () => executeDeclareCompletionCriteria({}, {})\n')
  write(root, 'src/main/modules/agent-control/runtime-core/run-finalizer-adjudication.ts', "const criteriaItems = appendModelCriteria(criteria.items, declared)\nlogAgentMetric('model_criteria_merged', {})\n")
}

test('gate passes on a fully-consistent baseline (also exercises deferred handshake against real unwired lists)', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate passes on the real repository', () => {
  const result = check({})
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('local maintenance no-provider boundary rejects the retired model path', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(
    root,
    'src/main/modules/agent-control/maintenance/maintenance-llm-driver.ts',
    'export async function runMaintenanceLlmRoundTick() {}\n',
  )
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('[maintenance-local-no-provider]')))
})

test('retired remote automatic Agent ingress cannot return', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(
    root,
    'src/main/modules/agent-control/runtime-core/remote-channel-service.ts',
    'await deps.runInboundChannel(request)\n',
  )
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('[remote-im-automatic-agent-ingress]')))
})

test('retired remote-specific coordinator alias cannot return', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(
    root,
    'src/main/modules/agent-control/task-projection/run-coordinator.ts',
    'async runInboundChannel(request) { return this.runScoped(request) }\n',
  )
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('[remote-im-automatic-agent-ingress]')))
})

test('an unowned crystallize startup timer cannot return', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, RUNTIME_REL, `${RETIRED_MEMORY_RUNTIME}\nnew CrystallizeScheduler(() => {})\n`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('[unowned-crystallize-startup-timer]')))
})

test('retired persona and preroute controls cannot return through preload', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, PRELOAD_REL, `${fs.readFileSync(path.join(root, PRELOAD_REL), 'utf8')}\nsimulateSystemStudioRouting()\n`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('[persona-knowledge-preroute-live-controls]')))
})

test('historical personalities cannot repopulate the live Agent selector', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/renderer/stores/useAgent.ts', 'await window.electronAPI.agentPersonality.list()\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('[persona-knowledge-preroute-live-controls]')))
})

test('historical personality CRUD cannot recreate live Agent registry side effects', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(
    root,
    'src/main/modules/repositories/agent-personality-repository.ts',
    "db.prepare('INSERT INTO agents (id, name) VALUES (?, ?)').run(id, name)\n",
  )
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('[persona-knowledge-preroute-live-controls]')))
})

test('retired specialist mutation tools cannot return to the Codex surface', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(
    root,
    'src/main/modules/tools/agent-interaction-tool-defs.ts',
    "export const AGENT_INTERACTION_TOOL_NAMES = ['ask_user_questions', 'propose_specialist_blueprint']\n",
  )
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('[specialist-agent-live-mutation-tools]')))
})

test('retired belief-decay round cannot return to the production runtime', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, RUNTIME_REL, `
import { runBeliefDecayRound } from '../memory/belief-decay'
runBeliefDecayRound([], effectors, now)
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[belief-decay]') && e.includes('retired path returned')))
})

test('retired crystallize scheduler cannot return to the production runtime', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, RUNTIME_REL, `
import { CrystallizeScheduler } from '../maintenance/crystallize-gate'
const crystallizeScheduler = new CrystallizeScheduler(() => {})
crystallizeScheduler.start({ startupDelayMs: 90_000 })
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[crystallize-round]') && e.includes('retired path returned')))
})

// appendModelCriteria 已 gate-flip 为 live-required（D4）；dark-defect 机制
// 改用合成 registry 条目保持分支覆盖。
const SYNTHETIC_DARK_REGISTRY = [{
  capability: 'synthetic-dark',
  status: 'dark-defect',
  anchor: { file: CRITERIA_REL, pattern: /export function appendModelCriteria\(/ },
  register: { file: REGISTER_REL, mention: 'appendModelCriteria' },
}]

test('dark-defect anchor symbol disappearing fails', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, CRITERIA_REL, 'export function somethingElse() {}\n')
  const result = check({ root, registry: SYNTHETIC_DARK_REGISTRY })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[synthetic-dark]') && e.includes('锚点符号已消失')))
})

test('dark-defect without a register mention fails', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, REGISTER_REL, '# 登记\n（空）\n')
  const result = check({ root, registry: SYNTHETIC_DARK_REGISTRY })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[synthetic-dark]') && e.includes('必须挂工单')))
})

test('gate-flipped run-feedback fails when the renderer call site disappears', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, FEEDBACK_STARS_REL, 'export function RunFeedbackStars() { return null }\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[RunFeedbackRepository]') && e.includes('缺失接线证据')))
})

test('gate-flipped emergence feed fails when a stale unwired marker returns', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, EMERGENCE_CARDS_REL, '/** P5d/C26 unwired: not in production driver path. */\nexport function assembleEmergenceFeed() {}\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[emergence-cards]') && e.includes('unwired 标记')))
})

test('gate-flipped run-feedback fails without its fired ledger', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, FEEDBACK_GROUP_REL, 'export const runFeedbackGroup = {}\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[RunFeedbackRepository]') && e.includes('run_feedback_submitted')))
})
