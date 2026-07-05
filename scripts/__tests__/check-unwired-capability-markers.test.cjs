const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { check } = require('../check-unwired-capability-markers.cjs')

function write(root, rel, body) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-p5-unwired-'))
  write(root, 'docs/superpowers/plans/2026-06-20-p5c-packet-trio-disabled-implementation.md', '任务包体系未启用\n')
  write(root, 'docs/superpowers/plans/2026-06-20-p5d-maintenance-emergence-status-implementation.md', '维护回合 / 涌现候选未启用\n')
  write(root, 'src/main/modules/agent-control/quality/packet-fields.ts', 'export function validatePacketFields() {}\n')
  write(root, 'src/main/modules/agent-control/quality/packet-compiler.ts', '/** P5c/C22 unwired: not in production path. */\nexport const compiler = 1\n')
  write(root, 'src/main/modules/agent-control/quality/packet-dispatch.ts', '/** P5c/C22 unwired: not in production path. */\nimport type { compiler } from "./packet-compiler"\nexport const dispatch = 1\n')
  write(root, 'src/main/modules/agent-control/quality/packet-failure.ts', '/** P5c/C22 unwired: not in production path. */\nimport { compiler } from "./packet-compiler"\nexport const failure = compiler\n')
  write(root, 'src/main/modules/agent-control/maintenance/cas-merge.ts', 'export function runUserPictureCasMerge() {}\n')
  write(root, 'src/main/modules/agent-control/maintenance/crystallize-gate.ts', '/** P5d/C26 unwired: not in production driver path. */\nexport function decideCrystallizeRun() {}\n')
  write(root, 'src/main/modules/agent-control/maintenance/maintenance-llm-round.ts', 'import { decideCrystallizeRun } from "./crystallize-gate"\nexport function getLastMaintenanceRoundStatus() { return null }\n/** D7 live: driven via maintenance-llm-driver. */\nexport async function runMaintenanceLlmRound() { return decideCrystallizeRun() }\n')
  write(root, 'src/main/modules/agent-control/emergence/candidate-maintenance.ts', '/** P5d/C26 unwired: not in production driver path. */\nexport function maintainAgentCandidates() {}\n')
  write(root, 'src/main/modules/agent-control/runtime-core/runtime.ts', 'import { runUserPictureCasMerge } from "../maintenance/cas-merge"\nrunUserPictureCasMerge()\n')
  write(root, 'src/main/modules/claude-bridge/ipc-handler.ts', 'import { getLastMaintenanceRoundStatus } from "../agent-control/maintenance/maintenance-llm-round"\ngetLastMaintenanceRoundStatus()\n')
  write(root, 'src/main/modules/claude-bridge/ipc/belief-card-group.ts', 'export const payload = { llmRound: null }\n')
  write(root, 'src/renderer/components/memory/BeliefCardsPanel.tsx', 'export const text = "LLM 维护回合未接入驱动"\n')
  return root
}

test('passes for marked dormant modules, exact intra-cluster imports, test imports, and live surfaces', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/repositories/task-projection-repository.ts', 'import { validatePacketFields } from "../agent-control/quality/packet-fields"\n')
  write(root, 'src/__tests__/packet-compiler-gate.test.ts', 'import { compiler } from "../main/modules/agent-control/quality/packet-compiler"\n')
  const result = check({ root })
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
})

test('fails when a trio file lacks the disabled markers', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/agent-control/quality/packet-compiler.ts', 'export const compiler = 1\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('packet-compiler.ts') && error.includes('markers')))
})

test('fails when production imports the unwired trio', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/agent-control/runtime-core/runtime.ts', 'import { compiler } from "../quality/packet-compiler"\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('runtime.ts') && error.includes('packet-compiler.ts')))
})

test('fails when a maintenance or emergence dormant file lacks disabled markers', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/agent-control/emergence/candidate-maintenance.ts', 'export function maintainAgentCandidates() {}\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('candidate-maintenance.ts') && error.includes('P5d/C26')))
})

test('fails when production imports a dormant maintenance/emergence module', () => {
  const root = makeRoot()
  // crystallize-gate + emergence-cards were migrated live (2026-07-03);
  // candidate-maintenance stays dormant, so it is the import that must still fail.
  write(root, 'src/main/modules/agent-control/runtime-core/runtime.ts', 'import { runUserPictureCasMerge } from "../maintenance/cas-merge"\nimport { maintainAgentCandidates } from "../emergence/candidate-maintenance"\nrunUserPictureCasMerge(); maintainAgentCandidates()\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('runtime.ts') && error.includes('candidate-maintenance.ts')))
})

test('allows production to import the now-live crystallize-gate (P5d deterministic migration)', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/agent-control/maintenance/crystallize-gate.ts', 'export function decideCrystallizeRun() {}\nexport function runCrystallizeRound() {}\n')
  write(root, 'src/main/modules/agent-control/runtime-core/runtime.ts', 'import { runUserPictureCasMerge } from "../maintenance/cas-merge"\nimport { runCrystallizeRound } from "../maintenance/crystallize-gate"\nrunUserPictureCasMerge(); runCrystallizeRound()\n')
  const result = check({ root })
  assert.ok(!result.errors.some((error) => error.includes('crystallize-gate.ts')), 'importing live crystallize-gate must not error')
})

test('fails when production bypasses maintenance-llm-driver and calls the round directly (D7 budget gates)', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/agent-control/runtime-core/runtime.ts', 'import { runUserPictureCasMerge } from "../maintenance/cas-merge"\nimport { runMaintenanceLlmRound } from "../maintenance/maintenance-llm-round"\nrunUserPictureCasMerge(); runMaintenanceLlmRound()\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('runMaintenanceLlmRound') && error.includes('maintenance-llm-driver')))
})

test('allows the maintenance-llm-driver itself to invoke the round (D7 wired path)', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/agent-control/maintenance/maintenance-llm-driver.ts', 'import { runMaintenanceLlmRound } from "./maintenance-llm-round"\nexport async function runMaintenanceLlmRoundTick() { return runMaintenanceLlmRound() }\n')
  const result = check({ root })
  assert.ok(!result.errors.some((error) => error.includes('maintenance-llm-driver.ts')), 'driver is the sanctioned call site')
})

test('fails when live packet-fields is marked unwired', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/agent-control/quality/packet-fields.ts', '/** P5c/C22 unwired: not in production path. */\nexport function validatePacketFields() {}\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('packet-fields.ts') && error.includes('live validation')))
})

test('fails when live cas-merge is marked unwired', () => {
  const root = makeRoot()
  write(root, 'src/main/modules/agent-control/maintenance/cas-merge.ts', '/** P5d/C26 unwired: not in production driver path. */\nexport function runUserPictureCasMerge() {}\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('cas-merge.ts') && error.includes('live CAS merge')))
})

test('fails when the enforce doc omits the disabled-system statement', () => {
  const root = makeRoot()
  write(root, 'docs/superpowers/plans/2026-06-20-p5c-packet-trio-disabled-implementation.md', 'packet trio docs\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('任务包体系未启用')))
})

test('fails when the P5d enforce doc or settings null-state copy omits the disabled status', () => {
  const root = makeRoot()
  write(root, 'docs/superpowers/plans/2026-06-20-p5d-maintenance-emergence-status-implementation.md', 'maintenance docs\n')
  write(root, 'src/renderer/components/memory/BeliefCardsPanel.tsx', 'export const text = "LLM 维护回合尚未记录"\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('维护回合 / 涌现候选未启用')))
  assert.ok(result.errors.some((error) => error.includes('未接入驱动')))
})
