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

const WIRED_RUNTIME = `
import { runBeliefDecayRound } from '../memory/belief-decay'
import { CrystallizeScheduler } from '../maintenance/crystallize-gate'
const scheduler = new CrystallizeScheduler(() => {})
logAgentMetric('crystallize_round_fired', {})
runBeliefDecayRound([], effectors, now)
logAgentMetric('belief_decay_round_fired', {})
`

function writeBaseline(root) {
  write(root, LIFECYCLE_REL, `
for (const row of rows) {
  if (row.category === 'belief') continue
}
`)
  write(root, RUNTIME_REL, WIRED_RUNTIME)
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

test('排除即托付：exclusion present but belief-decay unwired fails', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, RUNTIME_REL, `
import { CrystallizeScheduler } from '../maintenance/crystallize-gate'
const scheduler = new CrystallizeScheduler(() => {})
logAgentMetric('crystallize_round_fired', {})
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[belief-decay]') && e.includes('排除即托付')))
})

test('live-required wired without fired ledger fails', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, RUNTIME_REL, WIRED_RUNTIME.replace("logAgentMetric('belief_decay_round_fired', {})", ''))
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[belief-decay]') && e.includes('belief_decay_round_fired')))
})

test('live file carrying a stale unwired marker fails', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, DECAY_REL, '// P5d/C26 unwired — not in production driver path\nexport function runBeliefDecayRound() {}\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[belief-decay]') && e.includes('unwired 标记')))
})

test('live-required capability without delegation missing wiring fails (crystallize)', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, RUNTIME_REL, `
import { runBeliefDecayRound } from '../memory/belief-decay'
runBeliefDecayRound([], effectors, now)
logAgentMetric('belief_decay_round_fired', {})
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[crystallize-round]') && e.includes('缺失接线证据')))
})

test('dark-defect anchor symbol disappearing fails', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, CRITERIA_REL, 'export function somethingElse() {}\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[appendModelCriteria]') && e.includes('锚点符号已消失')))
})

test('dark-defect without a register mention fails', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, REGISTER_REL, '# 登记\n（空）\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('[appendModelCriteria]') && e.includes('必须挂工单')))
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
