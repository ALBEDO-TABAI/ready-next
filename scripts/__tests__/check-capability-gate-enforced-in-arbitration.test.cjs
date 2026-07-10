'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  checkCapabilityGateEnforcedInArbitration
} = require('../check-capability-gate-enforced-in-arbitration.cjs')

const REPO_ROOT = path.resolve(__dirname, '../..')
const ORCHESTRATOR = 'src/main/modules/agent-control/runtime-core/agent-sdk-turn-orchestrator.ts'

function copy(root, rel) {
  const target = path.join(root, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(REPO_ROOT, rel), target)
}

test('capability floor gate rejects a late tool-surface reset', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-floor-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const rel of [
    'src/main/modules/agent-control/domain-adapters/run-capability-controller.ts',
    'src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts',
    ORCHESTRATOR
  ]) {
    copy(root, rel)
  }
  const file = path.join(root, ORCHESTRATOR)
  const source = fs.readFileSync(file, 'utf8')
  const anchor = 'const executionResult = await executeAgentSdkPreparedTurn({'
  assert.ok(source.includes(anchor))
  fs.writeFileSync(file, source.replace(anchor, 'toolDefinitions = []\n      ' + anchor))

  const result = checkCapabilityGateEnforcedInArbitration({ root })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /must not be narrowed or replaced/)
})
